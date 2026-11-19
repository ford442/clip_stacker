/**
 * Timeline interchange, offline clips and stems in the real app, through
 * `window.clipStacker.project` (the harness exposes it as `test.project`).
 * No video encode: these run anywhere the harness loads.
 */
import { expect, test } from '@playwright/test';
import { GOLDEN_CASES } from './fixtures';
import { openHarness } from './harness';

test.describe('timeline interchange', () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page);
  });

  for (const golden of GOLDEN_CASES) {
    test(`${golden.name}: OTIO and FCPXML export → import → export is byte-identical`, async ({ page }) => {
      const identical = await page.evaluate(async (spec) => {
        const harness = window.clipStacker!.test!;
        const out: Record<string, boolean> = {};
        for (const format of ['otio', 'fcpxml'] as const) {
          await harness.buildProject(spec as unknown as Parameters<typeof harness.buildProject>[0]);
          const first = harness.project.exportTimeline(format);
          const report = await harness.project.importTimeline(first, { format });
          out[format] = report.offline.length === 0 && harness.project.exportTimeline(format) === first;
        }
        return out;
      }, golden.spec);
      expect(identical).toEqual({ otio: true, fcpxml: true });
    });
  }

  test('a clip whose media is missing imports offline, survives a save / load and blocks render', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const harness = window.clipStacker!.test!;
      await harness.buildProject({ clips: [{ demo: 'a', trimEnd: 2 }, { demo: 'b', trimEnd: 2 }], resolution: '320x180' });
      const otio = harness.project.exportTimeline('otio');
      const gone = otio.replaceAll('colour bars, pulsing 660 Hz', 'gone').replaceAll('colour%20bars,%20pulsing%20660%20Hz', 'gone');
      const report = await harness.project.importTimeline(gone, { format: 'otio' });
      const saved = harness.project.getState();
      await harness.project.loadProject(saved);
      const reloaded = harness.project.getState();
      const render = await harness.project.render({ outputResolution: '320x180' });
      return {
        offline: report.offline,
        savedOffline: saved.clips.filter((c) => c.offline).map((c) => c.offline!.fileName),
        reloadedOffline: reloaded.clips.filter((c) => c.offline).length,
        renderOk: render.ok,
        status: render.status,
      };
    });
    expect(result.offline).toEqual(['demo-b (gone).mp4']);
    expect(result.savedOffline).toEqual(['demo-b (gone).mp4']);
    expect(result.reloadedOffline).toBe(1);
    expect(result.renderOk).toBe(false);
    expect(result.status).toMatch(/offline clip/);
  });

  test('stems: one BWF per lane plus the master', async ({ page }) => {
    const report = await page.evaluate(async () => {
      const harness = window.clipStacker!.test!;
      await harness.buildProject({
        clips: [{ demo: 'a', trimEnd: 2 }, { demo: 'b', trimEnd: 2, layer: 1, startTime: 0.5 }],
        resolution: '320x180',
      });
      const stems = await harness.project.exportStems({ format: 'float32' });
      const zip = await (await fetch(stems.url)).blob();
      return { files: stems.files.map((f) => [f.role, f.fileName]), timeReference: stems.timeReference, zipBytes: zip.size };
    });
    expect(report.files).toEqual([
      ['master', '01 Master.wav'],
      ['lane', '02 Video 1.wav'],
      ['lane', '03 Video 2.wav'],
    ]);
    expect(report.timeReference).toBe(3600 * 48_000);
    expect(report.zipBytes).toBeGreaterThan(100_000);
  });
});
