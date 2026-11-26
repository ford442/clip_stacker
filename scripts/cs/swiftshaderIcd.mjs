/**
 * Point the Vulkan loader at the SwiftShader ICD bundled with the browser.
 *
 * ANGLE-on-Vulkan (`--use-angle=vulkan --use-vulkan=swiftshader`) is the only
 * combination where WebGPU frame uploads (`importExternalTexture`,
 * `copyExternalImageToTexture`) work headless. Without `VK_ICD_FILENAMES` the
 * system loader finds no ICD that offers `VK_KHR_surface`, ANGLE fails to
 * initialize, the GPU process falls back, and every frame import throws
 * "Failed to import texture from video" — the e2e harness failure on CI.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ICD_FILE = 'vk_swiftshader_icd.json';

/**
 * Directories that may hold the ICD for a Playwright Chromium executable: its
 * own, and the headless shell of the same revision (`<root>/chromium-1248/…`
 * vs `<root>/chromium_headless_shell-1248/…`), which is what headless runs
 * launch and may be the only one installed.
 */
function candidateDirs(exe) {
  const dirs = [path.dirname(exe)];
  const browserDir = path.dirname(path.dirname(exe));
  const revision = /-(\d+)$/.exec(path.basename(browserDir))?.[1];
  if (!revision) return dirs;
  const root = path.dirname(browserDir);
  const shell = path.join(root, `chromium_headless_shell-${revision}`);
  if (!existsSync(shell)) return dirs;
  for (const entry of readdirSync(shell, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(path.join(shell, entry.name));
  }
  return dirs;
}

/** The ICD next to `executablePath` (or Playwright's Chromium), or null. */
export function swiftshaderIcdPath(executablePath, fallbackExecutablePath) {
  for (const exe of [executablePath, fallbackExecutablePath]) {
    if (!exe) continue;
    for (const dir of candidateDirs(exe)) {
      const icd = path.join(dir, ICD_FILE);
      if (existsSync(icd)) return icd;
    }
  }
  return null;
}

/** `process.env` plus `VK_ICD_FILENAMES` when the ICD is found (an explicit value wins). */
export function swiftshaderLaunchEnv(executablePath, fallbackExecutablePath) {
  if (process.env.VK_ICD_FILENAMES) return { ...process.env };
  const icd = swiftshaderIcdPath(executablePath, fallbackExecutablePath);
  return icd ? { ...process.env, VK_ICD_FILENAMES: icd } : { ...process.env };
}
