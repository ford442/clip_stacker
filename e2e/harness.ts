import { expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goldens');
export const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1';

/** Open the app with `?test_harness` and wait for `window.clipStacker.test`. */
export async function openHarness(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test_harness');
  await page.waitForFunction(() => Boolean(window.clipStacker?.test), undefined, { timeout: 30_000 });
  const gpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  expect(gpu, 'WebGPU adapter (SwiftShader flags in playwright.config.ts)').toBe(true);
  expect(errors).toEqual([]);
}

export function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.png`);
}

export function readGolden(name: string): string | null {
  const file = goldenPath(name);
  return existsSync(file) ? readFileSync(file).toString('base64') : null;
}

export function writeGolden(name: string, pngBase64: string): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(goldenPath(name), Buffer.from(pngBase64, 'base64'));
}
