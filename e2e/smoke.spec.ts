/**
 * Smoke flows (#365) through the real UI: toolbar buttons, keyboard
 * shortcuts, the Render button, RootErrorBoundary and the recovery modal.
 * The harness API is only used to place the playhead / selection (pixel
 * positions on the ruler are layout-dependent) and to read results.
 */
import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './harness';

const DEMO_TOTAL_SECONDS = 12;

async function loadDemoClips(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Load demo clips/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.timelineSummary().clipCount))
    .toBe(2);
  // Shortcuts are ignored while a control has focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

function summary(page: Page) {
  return page.evaluate(() => window.clipStacker!.test!.timelineSummary());
}

test('demo clips → split → ripple delete → undo → render', async ({ page }) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await loadDemoClips(page);
  expect((await summary(page)).totalDuration).toBeCloseTo(DEMO_TOTAL_SECONDS, 1);

  // Select the first clip with the playhead 3 s in, then split (S).
  await page.evaluate(() => {
    const { editorStore, playbackStore } = window.clipStacker!.test!.stores;
    const first = editorStore.getState().tracks[0]!.items[0]!.clipId;
    editorStore.getState().setSelectedClipId(first);
    playbackStore.getState().setPlayheadTime(3);
  });
  await page.keyboard.press('s');
  await expect.poll(async () => (await summary(page)).clipCount).toBe(3);
  const split = await summary(page);
  expect(split.totalDuration).toBeCloseTo(DEMO_TOTAL_SECONDS, 1);
  // The cut snaps to a beat once beat analysis has run, so it lands near 3 s.
  const [left, right] = split.durations as [number, number];
  expect(left).toBeGreaterThan(2.5);
  expect(left).toBeLessThan(3.5);

  // The right half is selected: ripple delete (Shift+Delete) closes the gap.
  await page.keyboard.press('Shift+Delete');
  await expect.poll(async () => (await summary(page)).clipCount).toBe(2);
  expect((await summary(page)).totalDuration).toBeCloseTo(DEMO_TOTAL_SECONDS - right, 2);

  // Undo (Ctrl+Z) restores the right half and its time.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await summary(page)).clipCount).toBe(3);
  expect((await summary(page)).totalDuration).toBeCloseTo(DEMO_TOTAL_SECONDS, 1);

  await page.getByRole('button', { name: /▶ Render/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.stores.renderJobStore.getState().outputUrl), {
      timeout: 180_000,
    })
    .not.toBeNull();
  const result = await page.evaluate(async (total) => {
    const h = window.clipStacker!.test!;
    const url = h.stores.renderJobStore.getState().outputUrl!;
    const blob = await (await fetch(url)).blob();
    const last = await h.decodeFrame(blob, total - 0.5);
    return { duration: await h.mediaDuration(blob), lastFrameSize: [last.width, last.height] };
  }, DEMO_TOTAL_SECONDS);
  expect(result.duration).toBeGreaterThan(DEMO_TOTAL_SECONDS - 0.2);
  expect(result.duration).toBeLessThan(DEMO_TOTAL_SECONDS + 0.2);
  expect(result.lastFrameSize[0]).toBeGreaterThan(0);
});

/** Load demo clips, wait for the autosave, crash the tree, reload from the boundary. */
async function crashAndReload(page: Page) {
  await openHarness(page);
  await loadDemoClips(page);
  // Autosave debounces (2 s), then writes the session with its media.
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.autoSaveSummary()?.clipCount ?? 0), {
      timeout: 20_000,
    })
    .toBe(2);
  const before = await summary(page);

  await page.evaluate(() => window.clipStacker!.test!.crash());
  const reload = page.getByRole('button', { name: 'Reload and recover autosave' });
  await expect(reload).toBeVisible();
  await reload.click();
  await page.waitForFunction(() => Boolean(window.clipStacker?.test));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Recover unsaved work?' })).toBeVisible();
  return { before, dialog };
}

test('crash → error boundary → reload → recovery offer', async ({ page }) => {
  const { dialog } = await crashAndReload(page);
  await expect(dialog).toContainText('2 clips');
  await expect(dialog).toContainText('2 embedded locally');
});

/**
 * Known bug, found by this flow: recovery restores embedded media by
 * `fetch()`ing its `data:` URL, and the production CSP's `connect-src` does
 * not allow `data:` — so every embedded clip is dropped ("Could not restore
 * media … Failed to fetch") and the recovered timeline is empty. Unit tests
 * miss it because happy-dom enforces no CSP. `test.fail` keeps it visible
 * until the restore decodes data URLs without fetch.
 */
test('known bug: recover session restores the embedded clips', async ({ page }) => {
  test.fail();
  const { before } = await crashAndReload(page);
  await page.getByRole('button', { name: 'Recover session' }).click();
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.stores.renderJobStore.getState().status), {
      timeout: 30_000,
    })
    .toMatch(/Recovered autosave/);
  const after = await summary(page);
  expect(after.clipCount).toBe(2);
  expect(after.titles).toEqual(before.titles);
  expect(after.totalDuration).toBeCloseTo(before.totalDuration, 2);
});
