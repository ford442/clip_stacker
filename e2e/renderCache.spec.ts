/**
 * Render cache, smart render and the RAM preview (#380). Through the app's
 * real Render action; the harness only builds fixtures and reads reports
 * (`RenderPlan.renderCache`), digests and preview metrics.
 *
 * Demo clips are 640x360 H.264 High at 30 fps with B-frames and a single key
 * frame at 0; demo A and demo B differ in their PPS.
 */
import { expect, test } from '@playwright/test';
import { openHarness } from './harness';


/** A title keyframed visible only between `from` and `to` seconds. */
function title(text: string, from: number, to: number): Record<string, unknown> {
  return {
    text,
    keyframes: {
      opacity: [
        { t: 0, value: 0 },
        { t: from - 0.001, value: 0 },
        { t: from, value: 1 },
        { t: to, value: 1 },
        { t: to + 0.001, value: 0 },
      ],
    },
  };
}

test('smart render: a cut-only project copies every frame but a GOP-straddling cut', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const result = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    await h.renderCache.clear();
    const srcA = await (await fetch('demo/demo-clip-a.mp4')).blob();
    const srcB = await (await fetch('demo/demo-clip-b.mp4')).blob();

    // A whole, then B from 1 ms: both start on their key frame — nothing is encoded.
    await h.buildProject({ clips: [{ demo: 'a' }, { demo: 'b', trimStart: 0.001 }], resolution: '640x360' });
    const copyOnly = await h.exportProject({ forceReencode: false });
    const copyReport = h.renderCache.lastReport();
    const copyFrames = [
      h.compare(await h.decodeFrame(copyOnly, 2), await h.decodeFrame(srcA, 2)),
      h.compare(await h.decodeFrame(copyOnly, 9), await h.decodeFrame(srcB, 3)),
    ];

    // A whole, then A from 2 s: its GOP starts at 0, so that clip is the only thing encoded.
    await h.buildProject({ clips: [{ demo: 'a' }, { demo: 'a', trimStart: 2 }], resolution: '640x360' });
    const straddle = await h.exportProject({ forceReencode: false });
    const straddleReport = h.renderCache.lastReport();
    const straddleFrames = [
      h.compare(await h.decodeFrame(straddle, 3), await h.decodeFrame(srcA, 3)),
      h.compare(await h.decodeFrame(straddle, 7), await h.decodeFrame(srcA, 3)),
    ];
    return {
      copyReport,
      copyFrames,
      copyDuration: await h.mediaDuration(copyOnly),
      straddleReport,
      straddleFrames,
      straddleDuration: await h.mediaDuration(straddle),
    };
  });

  expect(result.copyReport?.renderCache).toMatchObject({ framesCopied: 360, framesEncoded: 0, copies: 2 });
  // A and B carry different PPS: the track is avc3 with them in band.
  expect(result.copyReport?.renderCache?.parameterSets).toBe('in-band');
  for (const frame of result.copyFrames) expect(frame.ssim).toBe(1);
  expect(result.copyDuration).toBeCloseTo(12, 1);

  expect(result.straddleReport?.renderCache).toMatchObject({ framesCopied: 180, framesEncoded: 120 });
  expect(result.straddleReport?.reasons.join('\n')).toMatch(/inside a source GOP|no source key frame/);
  expect(result.straddleFrames[0]!.ssim).toBe(1);
  expect(result.straddleFrames[1]!.psnr ?? Infinity).toBeGreaterThan(30);
  expect(result.straddleDuration).toBeCloseTo(10, 1);
});

test('render cache: a title edit re-encodes only its frames, and cached = uncached bit for bit', async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const result = await page.evaluate(
    async ({ before, after }) => {
      const h = window.clipStacker!.test!;
      await h.renderCache.clear();
      // 320x180: nothing can be copied, every frame goes through the cache.
      const spec = (t: Record<string, unknown>) => ({
        clips: [{ demo: 'a' as const }],
        resolution: '320x180',
        textOverlays: [t],
      });
      await h.buildProject(spec(before));
      const cold = await h.exportProject({ forceReencode: false });
      const coldReport = h.renderCache.lastReport();

      await h.buildProject(spec(after));
      const edited = await h.exportProject({ forceReencode: false });
      const editedReport = h.renderCache.lastReport();

      const warm = await h.exportProject({ forceReencode: false });
      const warmReport = h.renderCache.lastReport();

      await h.renderCache.clear();
      const uncached = await h.exportProject({ forceReencode: false });
      return {
        coldReport,
        editedReport,
        warmReport,
        digests: {
          edited: await h.mp4Digest(edited),
          warm: await h.mp4Digest(warm),
          uncached: await h.mp4Digest(uncached),
          cold: await h.mp4Digest(cold),
        },
        usage: await h.renderCache.usage(),
      };
    },
    { before: title('Hello', 2, 3), after: title('World', 2, 3) },
  );

  expect(result.coldReport?.renderCache).toMatchObject({ hits: 0, framesEncoded: 180, framesCopied: 0 });
  // The title shows on frames 60..90: only that segment is encoded again.
  expect(result.editedReport?.renderCache).toMatchObject({ framesEncoded: 31, framesReused: 149, misses: 1 });
  expect(result.warmReport?.renderCache).toMatchObject({ framesEncoded: 0, framesReused: 180, misses: 0 });
  expect(result.digests.warm).toBe(result.digests.edited);
  expect(result.digests.uncached).toBe(result.digests.warm);
  expect(result.digests.cold).not.toBe(result.digests.edited);
  expect(result.usage?.entries).toBeGreaterThan(0);
});

test('render cache: survives a reload and stays under its budget', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const before = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    await h.buildProject({ clips: [{ demo: 'b', trimEnd: 2 }], resolution: '320x180' });
    await h.exportProject({ forceReencode: false });
    return h.renderCache.usage();
  });
  expect(before?.persistent).toBe(true);
  expect(before?.entries).toBeGreaterThan(0);

  await page.reload();
  await openHarness(page);
  const after = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    const usage = await h.renderCache.usage();
    await h.buildProject({ clips: [{ demo: 'b', trimEnd: 2 }], resolution: '320x180' });
    await h.exportProject({ forceReencode: false });
    return { usage, report: h.renderCache.lastReport() };
  });
  expect(after.usage?.entries).toBe(before?.entries);
  expect(after.usage!.bytes).toBeLessThanOrEqual(after.usage!.budgetBytes);
  expect(after.report?.renderCache).toMatchObject({ framesEncoded: 0, framesReused: 60 });
});

test('RAM preview: Render In→Out makes an NLM denoise + bloom stack play without dropped frames', async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const rendered = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    h.renderCache.update({ previewCache: true, backgroundRender: false });
    await h.buildProject({
      clips: [{ demo: 'a', trimEnd: 4 }],
      finishing: {
        schema: 'clip_stacker.finishing-preset',
        version: 1,
        name: 'e2e nlm + bloom',
        apply: 'replace',
        finishing: {
          noiseReduction: { enabled: true, quality: 'nlm', spatialStrength: 1, spatialRadius: 2, temporal: false },
          bloom: { enabled: true, amount: 0.6, threshold: 0.5, radius: 0.5 },
        },
      },
    });
    // Let the preview mount on the new timeline and fingerprint its media.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    h.previewCache.setMarks(0.5, 2.5);
    const stats = await h.previewCache.renderRange(0.5, 2.5);
    const status = await h.previewCache.status();
    return { stats, frames: status?.frames.length ?? 0 };
  });
  expect(rendered.stats.frames).toBe(60);
  expect(rendered.frames).toBeGreaterThanOrEqual(60);

  await page.evaluate(() => window.clipStacker!.test!.stores.playbackStore.getState().setPlayheadTime(0.5));
  await page.getByRole('button', { name: 'Play/Pause' }).click();
  const played = await page.evaluate(
    () =>
      new Promise<{ droppedFrames: number; playedFrames: number; cacheHits: number }>((resolve) => {
        const h = window.clipStacker!.test!;
        const poll = () => {
          if ((h.stores.playbackStore.getState().playheadTime ?? 0) >= 2.5) resolve(h.previewCache.metrics());
          else requestAnimationFrame(poll);
        };
        poll();
      }),
  );
  await page.getByRole('button', { name: 'Play/Pause' }).click();
  expect(played.playedFrames).toBeGreaterThan(50);
  expect(played.droppedFrames).toBe(0);
  expect(played.cacheHits).toBeGreaterThan(50);
});
