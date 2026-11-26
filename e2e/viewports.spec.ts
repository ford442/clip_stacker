/**
 * Viewport matrix (#383, part 3/5): every common viewport × layout variant ×
 * app state must have no horizontal page scroll, no control clipped by the
 * viewport, and a preview that keeps its aspect ratio (#305). Screenshots go
 * to `test-results/viewports/` (VIEWPORT_SHOTS=0 skips them) so the report
 * can show each one.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openHarness } from './harness';

const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1100x800', width: 1100, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
] as const;

type Variant = { name: string; layout: Record<string, unknown> };
const VARIANTS: Variant[] = [
  { name: 'default', layout: {} },
  { name: 'density-S', layout: { density: 'compact' } },
  { name: 'density-L', layout: { density: 'spacious' } },
  { name: 'collapsed', layout: { libraryCollapsed: true, inspectorCollapsed: true } },
  { name: 'boxed', layout: { fullWidth: false } },
];

const SHOT_DIR = 'test-results/viewports';
const SHOTS = process.env.VIEWPORT_SHOTS !== '0';

async function audit(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, select, input, [role="separator"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') continue;
      const closed = el.closest('details:not([open])');
      if (closed && !el.closest('summary')) continue;
      if (r.right > vw + 1 || r.left < -1) {
        clipped.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    const canvas = document.querySelector<HTMLCanvasElement>('.preview-canvas-stack canvas');
    let aspect: number | null = null;
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      if (r.height > 0) aspect = r.width / r.height;
    }
    return { scrollWidth: doc.scrollWidth, vw, clipped: clipped.slice(0, 10), aspect };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    for (const variant of VARIANTS) {
      test(variant.name, async ({ page }) => {
        await page.addInitScript((layout) => {
          if (Object.keys(layout).length) {
            localStorage.setItem('clip_stacker.workspaceLayout.v1', JSON.stringify(layout));
          }
        }, variant.layout);
        await openHarness(page);
        if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });
        const states: Array<[string, () => Promise<void>]> = [
          ['empty', async () => {}],
          ['file-menu', async () => {
            await page.locator('.file-menu > summary').click();
            await page.waitForTimeout(100);
          }],
          ['demo', async () => {
            await page.locator('.file-menu > summary').click();
            await page.getByRole('button', { name: /Load demo clips/ }).first().click();
            await expect
              .poll(() => page.evaluate(() => window.clipStacker!.test!.timelineSummary().clipCount))
              .toBe(2);
            await page.waitForTimeout(500);
          }],
        ];
        for (const [state, enter] of states) {
          await enter();
          const r = await audit(page);
          if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${vp.name}-${variant.name}-${state}.png` });
          expect.soft(r.scrollWidth, `${state}: horizontal page scroll`).toBeLessThanOrEqual(r.vw);
          expect.soft(r.clipped, `${state}: controls outside the viewport`).toEqual([]);
          if (state === 'demo' && r.aspect !== null) {
            expect.soft(Math.abs(r.aspect - 16 / 9), `${state}: preview aspect`).toBeLessThan(0.05);
          }
        }
      });
    }
  });
}
