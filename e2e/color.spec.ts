/**
 * Colour pipeline acceptance (#347): true 10-bit HDR10 frames, Display P3
 * end to end, and the managed-colour export's first frame.
 */
import { expect, test } from '@playwright/test';
import { openHarness } from './harness';

/** The refusal a browser without a 10-bit encoder gives for HDR10 (CI's Chromium). */
const NO_10BIT_ENCODER = /HEVC Main10 and AV1 10-bit are not available/;

/**
 * A ramp drawn by a custom transition (so no 8-bit source frame limits it),
 * lifted 3 EV so it spans ~0–800 nits. Linear in uv.x^2.6 so the PQ codes are
 * spread evenly; on the float compositor canvas it lands ~638 distinct Y codes.
 * An 8-bit canvas or RGBA8 readback would cap it at ~250.
 */
const HDR_RAMP = {
  clips: [
    { demo: 'a', trimEnd: 2 },
    { demo: 'b', trimEnd: 2 },
  ],
  resolution: '1280x720',
  transitions: [
    {
      // The index of the clip the transition leads into.
      afterClipIndex: 1,
      type: 'custom',
      duration: 1,
      customShader: 'vec4<f32>(vec3<f32>(pow(uv.x, 2.6)), 1.0)',
    },
  ],
  finishing: {
    schema: 'clip_stacker.finishing-preset',
    version: 1,
    name: 'e2e hdr ramp',
    apply: 'replace',
    finishing: { primaryColor: { enabled: true, exposure: 3 } },
  },
  colorManagement: { outputColor: 'hdr10', workingSpace: 'rec2020-linear' },
};
const RAMP_TIME = 1.5;

test('HDR10: a ramp keeps more than 600 distinct 10-bit luma codes', async ({ page }) => {
  await openHarness(page);
  const result = await page.evaluate(
    async ({ spec, t }) => {
      const h = window.clipStacker!.test!;
      await h.buildProject(spec as never);
      const packed = await h.hdr10FrameStats(t);
      h.disposePreviewEngine();
      let exportError: string | null = null;
      let decoded: Awaited<ReturnType<typeof h.decodeFrameStats>> | null = null;
      let decodeError: string | null = null;
      try {
        const blob = await h.exportProject();
        try {
          decoded = await h.decodeFrameStats(blob, t);
        } catch (error) {
          decodeError = error instanceof Error ? error.message : String(error);
        }
      } catch (error) {
        exportError = error instanceof Error ? error.message : String(error);
      }
      return { packed, exportError, decoded, decodeError };
    },
    { spec: HDR_RAMP, t: RAMP_TIME },
  );
  console.log('[hdr10 ramp]', JSON.stringify(result));

  // What the encoder is handed: I420P10, BT.2020 NCL / PQ, limited range.
  expect(result.packed.format).toBe('I420P10');
  expect(result.packed.bitDepth).toBe(10);
  expect(result.packed.colorSpace).toMatchObject({ primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' });
  expect(result.packed.minLuma, 'limited-range black').toBeGreaterThanOrEqual(64);
  expect(result.packed.maxLuma, 'limited-range ceiling').toBeLessThanOrEqual(940);
  expect(result.packed.distinctLuma, 'distinct Y codes in the packed frame').toBeGreaterThan(600);

  if (result.exportError) {
    expect(result.exportError, 'HDR10 export refusal').toMatch(NO_10BIT_ENCODER);
    test.info().annotations.push({ type: 'note', description: 'no 10-bit encoder: packed frame checked only' });
  } else if (result.decoded && result.decoded.bitDepth === 10) {
    // HEVC / AV1 Main10 round trip: the file keeps the steps, give or take codec noise.
    expect(result.decoded.distinctLuma, 'distinct Y codes in the decoded file').toBeGreaterThan(600);
  } else {
    test.info().annotations.push({
      type: 'note',
      description: `exported, but the decode is not CPU-readable 10-bit (${result.decodeError ?? result.decoded?.format})`,
    });
  }
});

test('Display P3: a P3 chart keeps its primaries end to end', async ({ page }) => {
  await openHarness(page);
  const { p3, sdr } = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    const p3 = await h.renderP3Chart('display-p3');
    h.disposePreviewEngine();
    const sdr = await h.renderP3Chart('rec709-sdr');
    h.disposePreviewEngine();
    return { p3, sdr };
  });
  console.log('[p3 chart]', JSON.stringify({ p3, sdr }));
  const [red, green, blue, white, grey] = p3;
  // Read back in P3: the P3 primaries come out as P3 primaries…
  expect(red![0]).toBeGreaterThanOrEqual(245);
  expect(Math.max(red![1]!, red![2]!)).toBeLessThanOrEqual(12);
  expect(green![1]).toBeGreaterThanOrEqual(245);
  expect(Math.max(green![0]!, green![2]!)).toBeLessThanOrEqual(12);
  expect(blue![2]).toBeGreaterThanOrEqual(245);
  expect(Math.max(blue![0]!, blue![1]!)).toBeLessThanOrEqual(12);
  for (const c of white!) expect(c).toBeGreaterThanOrEqual(250);
  for (const c of grey!) expect(Math.abs(c - 128)).toBeLessThanOrEqual(4);
  // …where the Rec.709 output clips them to the sRGB gamut (sRGB red is
  // about (234, 51, 35) in P3).
  expect(sdr[0]![1]!, 'Rec.709 output clips P3 red').toBeGreaterThan(25);
});

test('Display P3 export frame 0 is not black', async ({ page }) => {
  await openHarness(page);
  const mean = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    await h.buildProject({
      clips: [{ demo: 'b', trimEnd: 1 }],
      resolution: '320x180',
      colorManagement: { outputColor: 'display-p3' },
    } as never);
    const blob = await h.exportProject();
    return h.meanRgb(await h.decodeFrame(blob, 0));
  });
  expect(Math.max(...mean), 'frame 0 mean RGB').toBeGreaterThan(10);
});
