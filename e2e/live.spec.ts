/**
 * Live smoke: the *deployed* production build in a real browser, with zero
 * console errors, page errors, CSP violations or unexpected failed requests.
 * Opt-in: `LIVE_URL=https://test.1ink.us/clip-stacker/ npm run e2e:live`
 * (playwright.live.config.ts). Works against `npm run preview` too.
 *
 * `?test_harness` is used only to read results and place the playhead; the
 * edits go through the real UI as in smoke.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';

const DEMO_TOTAL_SECONDS = 12;

/**
 * Requests allowed to fail: documented optional probes. The Whisper build is
 * opt-in and not deployed; FFmpeg core sources are HEAD-probed (self-hosted
 * first, CDNs as fallback), so a missing fallback is not an error.
 */
const OPTIONAL_REQUESTS: RegExp[] = [
  /\/wasm\/whisper[^/]*$/,
  /(cdn\.jsdelivr\.net|unpkg\.com)\/.*@ffmpeg\/core/,
  /\/favicon\.ico$/,
];

interface Problems {
  console: string[];
  page: string[];
  network: string[];
  csp: string[];
}

function isOptional(url: string): boolean {
  return OPTIONAL_REQUESTS.some((re) => re.test(url.split('?')[0]!));
}

/** Record every console error, page error, failed request and CSP violation. */
function watch(page: Page): Problems {
  const problems: Problems = { console: [], page: [], network: [], csp: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chromium's echo of an HTTP error carries no URL; the response handler
    // below reports it (or allow-lists it) with the URL.
    if (msg.text().startsWith('Failed to load resource:')) return;
    problems.console.push(msg.text());
  });
  page.on('pageerror', (error) => problems.page.push(error.message));
  page.on('requestfailed', (request) => {
    const url = request.url();
    // Downloads and blob: / data: reads are not network traffic.
    if (url.startsWith('blob:') || url.startsWith('data:') || isOptional(url)) return;
    const reason = request.failure()?.errorText ?? 'failed';
    if (reason === 'net::ERR_ABORTED' && request.resourceType() === 'media') return; // seek aborts
    problems.network.push(`${request.method()} ${url}: ${reason}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (response.status() >= 400 && isOptional(url)) {
      test.info().annotations.push({ type: 'optional-probe', description: `${response.status()} ${url}` });
    } else if (response.status() >= 400) {
      problems.network.push(`${response.request().method()} ${url}: HTTP ${response.status()}`);
    }
  });
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return problems;
}

function expectClean(problems: Problems): void {
  const csp = problems.console.filter((line) => line.startsWith('CSP violation'));
  expect(csp, 'CSP violations').toEqual([]);
  expect(problems.page, 'page errors').toEqual([]);
  expect(problems.console, 'console errors').toEqual([]);
  expect(problems.network, 'failed requests').toEqual([]);
}

async function open(page: Page): Promise<void> {
  const response = await page.goto('./?test_harness');
  expect(response?.ok(), 'document loads').toBe(true);
  const headers = response!.headers();
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toMatch(/require-corp|credentialless/);
  await page.waitForFunction(() => Boolean(window.clipStacker?.test), undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => window.crossOriginIsolated), 'crossOriginIsolated').toBe(true);
}

async function loadDemoClips(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Load demo clips/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.timelineSummary().clipCount), { timeout: 60_000 })
    .toBe(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const summary = (page: Page) => page.evaluate(() => window.clipStacker!.test!.timelineSummary());

/** Render through the toolbar and check the file: duration, non-black frame 0. */
async function renderAndCheck(page: Page, expectedSeconds: number): Promise<void> {
  await page.evaluate(() => window.clipStacker!.test!.stores.renderJobStore.getState().setOutputUrl(null));
  await page.getByRole('button', { name: /▶ Render/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.stores.renderJobStore.getState().outputUrl), {
      timeout: 240_000,
    })
    .not.toBeNull();
  const result = await page.evaluate(async () => {
    const h = window.clipStacker!.test!;
    const blob = await (await fetch(h.stores.renderJobStore.getState().outputUrl!)).blob();
    const frame = await h.decodeFrame(blob, 0);
    let sum = 0;
    for (let i = 0; i < frame.data.length; i += 4) sum += frame.data[i]! + frame.data[i + 1]! + frame.data[i + 2]!;
    return { duration: await h.mediaDuration(blob), meanRgb: sum / ((frame.data.length / 4) * 3) };
  });
  expect(result.duration).toBeGreaterThan(expectedSeconds - 0.2);
  expect(result.duration).toBeLessThan(expectedSeconds + 0.2);
  expect(result.meanRgb, 'frame 0 is not black').toBeGreaterThan(8);
}

test('load is clean and names its build', async ({ page }) => {
  const problems = watch(page);
  await open(page);
  const build = await page.locator('meta[name="clip-stacker-build"]').getAttribute('content');
  const commit = await page.locator('meta[name="clip-stacker-commit"]').getAttribute('content');
  expect(build).toMatch(/^[0-9a-f]{16}$/);
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  if (process.env.EXPECTED_SHA) expect(commit).toBe(process.env.EXPECTED_SHA);
  test.info().annotations.push({ type: 'commit', description: commit! }, { type: 'build', description: build! });
  await page.waitForLoadState('networkidle');
  expectClean(problems);
});

test('demo → scrub → split → ripple delete → undo → title → render', async ({ page }) => {
  test.setTimeout(420_000);
  const problems = watch(page);
  await open(page);
  await loadDemoClips(page);

  // Preview plays and scrubs.
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.stores.playbackStore.getState().playheadTime), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0.2);
  await page.keyboard.press('Space');
  await page.evaluate(() => window.clipStacker!.test!.stores.playbackStore.getState().setPlayheadTime(6));
  await page.evaluate(() => window.clipStacker!.test!.renderPreviewFrame(6));

  await page.evaluate(() => {
    const { editorStore, playbackStore } = window.clipStacker!.test!.stores;
    editorStore.getState().setSelectedClipId(editorStore.getState().tracks[0]!.items[0]!.clipId);
    playbackStore.getState().setPlayheadTime(3);
  });
  await page.keyboard.press('s');
  await expect.poll(async () => (await summary(page)).clipCount).toBe(3);
  await page.keyboard.press('Shift+Delete');
  await expect.poll(async () => (await summary(page)).clipCount).toBe(2);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await summary(page)).clipCount).toBe(3);
  expect((await summary(page)).totalDuration).toBeCloseTo(DEMO_TOTAL_SECONDS, 1);

  await page.getByRole('button', { name: '+ Add Text' }).click();
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.stores.editorStore.getState().textOverlays.length))
    .toBe(1);

  await renderAndCheck(page, DEMO_TOTAL_SECONDS);
  expectClean(problems);
});

test('Force FFmpeg render loads the self-hosted core', async ({ page }) => {
  test.setTimeout(420_000);
  const problems = watch(page);
  const coreRequests: string[] = [];
  page.on('request', (request) => {
    if (/ffmpeg-core/.test(request.url())) coreRequests.push(request.url());
  });
  await open(page);
  await loadDemoClips(page);
  await page.evaluate(() => {
    const s = window.clipStacker!.test!.stores.settingsStore.getState();
    s.setForceFFmpeg(true);
    s.setForceReencode(true);
  });
  await renderAndCheck(page, DEMO_TOTAL_SECONDS);
  const base = new URL(page.url()).origin;
  expect(coreRequests.some((url) => url.startsWith(base) && /ffmpeg-core(-mt)?\//.test(url))).toBe(true);
  expectClean(problems);
});

test('save project → reload → recover autosave', async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  await open(page);
  await loadDemoClips(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Save project/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$|\.clipstack/);
  await expect
    .poll(() => page.evaluate(() => window.clipStacker!.test!.autoSaveSummary()?.clipCount ?? 0), {
      timeout: 30_000,
    })
    .toBe(2);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.clipStacker?.test));
  await page.getByRole('button', { name: 'Recover session' }).click();
  await expect.poll(async () => (await summary(page)).clipCount, { timeout: 30_000 }).toBe(2);
  expectClean(problems);
});
