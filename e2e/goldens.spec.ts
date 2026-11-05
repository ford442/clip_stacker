/**
 * Render regression goldens (#365): for each fixture, the preview frame must
 * match the decoded export frame (same compositor, then one H.264 encode) and
 * the committed golden PNG. `npm run e2e:update-goldens` rewrites them.
 */
import { expect, test } from '@playwright/test';
import { GOLDEN_CASES } from './fixtures';
import { openHarness, readGolden, UPDATE_GOLDENS, writeGolden } from './harness';

/** Preview vs the committed golden: same renderer, so only driver drift. */
const MIN_GOLDEN_PSNR = 38;
/**
 * Preview vs export at 320x180: hard test-pattern edges through H.264 land
 * at 25–41 dB PSNR with SSIM ≥ 0.96 when the two agree; a missing layer,
 * pass or title drops SSIM well below 0.9.
 */
const MIN_EXPORT_PSNR = 24;
const MIN_EXPORT_SSIM = 0.95;
/** The refusal a browser without a 10-bit encoder must give for HDR10. */
const NO_10BIT_ENCODER = /HEVC Main10 and AV1 10-bit are not available/;

for (const golden of GOLDEN_CASES) {
  test(`golden: ${golden.name}`, async ({ page }) => {
    await openHarness(page);
    const hdr10 = golden.mode === 'hdr10';
    const goldens = Object.fromEntries(
      golden.times.map((t) => [t, UPDATE_GOLDENS ? null : readGolden(`${golden.name}@${t}`)]),
    );
    const results = await page.evaluate(
      async ({ spec, times, hdr10, goldens }) => {
        const h = window.clipStacker!.test!;
        await h.buildProject(spec as never);
        let blob: Blob | null = null;
        let exportError: string | null = null;
        try {
          blob = await h.exportProject();
        } catch (error) {
          exportError = error instanceof Error ? error.message : String(error);
        }
        const frames = [];
        for (const t of times) {
          const reference = hdr10 ? await h.renderPqFrame(t) : await h.renderPreviewFrame(t);
          const exported = blob && !hdr10 ? await h.decodeFrame(blob, t) : null;
          const expected = goldens[t] ? await h.fromPng(goldens[t]) : null;
          frames.push({
            t,
            size: [reference.width, reference.height],
            mean: h.meanRgb(reference),
            exportSize: exported ? [exported.width, exported.height] : null,
            exportMean: exported ? h.meanRgb(exported) : null,
            previewVsExport: exported ? h.compare(reference, exported) : null,
            vsGolden: expected ? h.compare(reference, expected) : null,
            png: expected ? null : await h.toPng(reference),
          });
        }
        const duration = blob ? await h.mediaDuration(blob) : null;
        h.disposePreviewEngine();
        return { frames, exportError, duration, encoder: h.stores.renderJobStore.getState().encoderPath };
      },
      { spec: golden.spec, times: golden.times, hdr10, goldens },
    );
    console.log(
      `[golden] ${golden.name}`,
      JSON.stringify({
        exportError: results.exportError,
        frames: results.frames.map(({ png: _png, ...rest }) => rest),
      }),
    );

    if (hdr10 && results.exportError) {
      expect(results.exportError, 'HDR10 export refusal').toMatch(NO_10BIT_ENCODER);
      test.info().annotations.push({ type: 'note', description: 'no 10-bit encoder: PQ readback only' });
    } else {
      expect(results.exportError, 'export').toBeNull();
      expect(results.encoder, 'export ran the GPU compositor').toBe('webcodecs');
      expect(results.duration, 'exported duration').toBeGreaterThan(0);
    }

    for (const frame of results.frames) {
      const label = `${golden.name} @ ${frame.t}s`;
      if (frame.previewVsExport) {
        expect(frame.exportSize, `${label}: export size`).toEqual(frame.size);
        expect(frame.previewVsExport.psnr, `${label}: preview vs export PSNR`).toBeGreaterThanOrEqual(
          golden.minExportPsnr ?? MIN_EXPORT_PSNR,
        );
        expect(frame.previewVsExport.ssim, `${label}: preview vs export SSIM`).toBeGreaterThanOrEqual(
          golden.minExportSsim ?? MIN_EXPORT_SSIM,
        );
      }
      if (frame.png) {
        if (!UPDATE_GOLDENS) throw new Error(`${label}: no golden — run with UPDATE_GOLDENS=1`);
        writeGolden(`${golden.name}@${frame.t}`, frame.png);
      } else {
        expect(frame.vsGolden!.psnr, `${label}: vs golden PSNR`).toBeGreaterThanOrEqual(MIN_GOLDEN_PSNR);
      }
    }
  });
}

/**
 * Known export defect, found by this harness: with managed colour the first
 * frame a fresh compositor draws is black, and export does not discard it, so
 * frame 0 of a Display P3 (and HDR10) file is black. `test.fail` keeps it
 * visible; it flips to an unexpected pass once the export is fixed.
 */
test('known bug: Display P3 export frame 0 is not black', async ({ page }) => {
  test.fail();
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
