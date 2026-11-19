/**
 * A headless Clip Stacker session for `cs` and the MCP server: the production
 * build served by Vite's preview server (COOP / COEP and the CSP exactly as
 * `npm run preview`), Chromium driven by Playwright, and the page's own
 * `window.clipStacker.project` API.
 *
 * - WebGPU runs on SwiftShader with the e2e flags (playwright.config.ts), so
 *   no GPU is needed; `gpu: true` uses the machine's adapter instead.
 * - A media folder is served same-origin at `/__cs_media/` through a
 *   Playwright route (the CSP allows only same-origin fetches); it is the
 *   API's `mediaRoot`, so projects and timelines find their files by name.
 * - Files come back through real downloads (no base64 through `evaluate`).
 * - `CS_CHROMIUM=/path/to/chrome` uses that browser instead of Playwright's
 *   download (`npx playwright install chromium`).
 */

// Callbacks handed to `page.evaluate` run in the page, where these exist.
/* global window, document */

import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MEDIA_PREFIX = '/__cs_media/';

/** The e2e harness's Chromium flags: WebGPU on SwiftShader through ANGLE-on-Vulkan. */
export const SWIFTSHADER_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=vulkan',
  '--use-webgpu-adapter=swiftshader',
  '--disable-vulkan-surface',
  '--autoplay-policy=no-user-gesture-required',
];
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'];

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** A file under `root` for a request path, or null (no escaping the folder). */
async function findMedia(root, requested) {
  const direct = path.resolve(root, requested);
  if (direct.startsWith(path.resolve(root) + path.sep) && existsSync(direct) && statSync(direct).isFile()) return direct;
  // Timelines name files by base name; look one level of subfolders down too.
  const base = path.basename(requested);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === base) return path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = path.join(root, entry.name, base);
      if (existsSync(nested) && statSync(nested).isFile()) return nested;
    }
  }
  return null;
}

/**
 * Open a session. `log(event)` receives JSON-able progress events. Close it
 * with `session.close()`.
 */
export async function openSession({ gpu = false, media = null, log = () => {}, headed = false } = {}) {
  const dist = path.join(REPO_ROOT, 'dist', 'index.html');
  if (!existsSync(dist)) throw new Error('No production build: run `npm run build` first (cs serves dist/ like `npm run preview`).');
  const { preview } = await import('vite');
  const { chromium } = await import('@playwright/test');
  const server = await preview({
    root: REPO_ROOT,
    configFile: path.join(REPO_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    preview: { port: 0, strictPort: false, host: '127.0.0.1', open: false },
  });
  const baseUrl = server.resolvedUrls?.local?.[0];
  if (!baseUrl) {
    await server.close();
    throw new Error('The preview server did not report a URL.');
  }
  log({ event: 'server', url: baseUrl });
  // CS_CHROMIUM: a Chrome / Chromium binary to use instead of Playwright's own download.
  const executablePath = process.env.CS_CHROMIUM || undefined;
  const browser = await chromium.launch({
    headless: !headed,
    args: gpu ? GPU_ARGS : SWIFTSHADER_ARGS,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const mediaRoot = media ? path.resolve(media) : null;
  if (mediaRoot) {
    await page.route(`**${MEDIA_PREFIX}**`, async (route) => {
      const requested = decodeURIComponent(new URL(route.request().url()).pathname.slice(MEDIA_PREFIX.length));
      const file = await findMedia(mediaRoot, requested);
      if (!file) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({
        path: file,
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cross-origin-resource-policy': 'same-origin',
        },
      });
    });
  }

  await page.exposeFunction('__csProgress', (progress) => log({ event: 'progress', ...progress }));
  await page.goto(new URL('./', baseUrl).href);
  await page.waitForFunction(() => window.clipStacker?.project?.version !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.clipStacker.project.onProgress((p) => window.__csProgress(p)));
  const version = await page.evaluate(() => window.clipStacker.project.version);
  log({ event: 'ready', apiVersion: version, gpu });

  /** Call `window.clipStacker.project[method](...args)` in the page. */
  const call = (method, ...args) =>
    page.evaluate(([name, params]) => window.clipStacker.project[name](...params), [method, args]);

  /** Save an object URL the page holds to `out` through a download. */
  const saveUrl = async (url, out) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.evaluate((href) => {
        const a = document.createElement('a');
        a.href = href;
        a.download = 'output';
        document.body.append(a);
        a.click();
        a.remove();
      }, url),
    ]);
    await download.saveAs(path.resolve(out));
    return path.resolve(out);
  };

  return {
    page,
    call,
    saveUrl,
    pageErrors,
    mediaRoot: mediaRoot ? new URL(MEDIA_PREFIX, baseUrl).href : undefined,
    async close() {
      await browser.close().catch(() => {});
      await server.close();
    },
  };
}

/** `1080p30` / `720p30` / `1440p30` / `4k30` / `WxH` → export settings (the export grid is 30 fps). */
export function presetSettings(preset) {
  if (!preset) return {};
  const sizes = { '720p': '1280x720', '1080p': '1920x1080', '1440p': '2560x1440', '4k': '3840x2160', '2160p': '3840x2160' };
  const match = /^(\d+p|4k)(?:(\d+(?:\.\d+)?))?$/i.exec(preset);
  if (match) {
    const size = sizes[match[1].toLowerCase()];
    if (!size) throw new Error(`Unknown preset "${preset}" (720p30, 1080p30, 1440p30, 4k30, or WIDTHxHEIGHT).`);
    if (match[2] && Number(match[2]) !== 30) throw new Error(`Exports render at 30 fps; "${preset}" asks for ${match[2]}.`);
    return { outputResolution: size };
  }
  if (/^\d+x\d+$/.test(preset)) return { outputResolution: preset };
  throw new Error(`Unknown preset "${preset}" (720p30, 1080p30, 1440p30, 4k30, or WIDTHxHEIGHT).`);
}
