#!/usr/bin/env node
/**
 * Post-build: fail when the entry chunk outgrows its budget.
 *
 * Everything the editor does not need to paint its first frame (export,
 * FFmpeg, captions, Inspector tabs, the main-thread WebGPU fallback) loads
 * through `import()`. A static import that drags one of those back into the
 * entry would only show up as a Vite warning; this makes it a build failure.
 * Runs before utf16-dual-encode.mjs, which rewrites index.html.
 *
 * Usage (after vite build):
 *   node scripts/check-bundle-size.mjs [distDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minified bytes (Vite's "kB" is 1000 bytes). */
export const ENTRY_BUDGET_BYTES = 600_000;

/** `src` of every module script in the built HTML. */
export function entryScriptPaths(html) {
  const paths = [];
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/type=["']module["']/.test(tag)) continue;
    const src = /src=["']([^"']+)["']/.exec(tag);
    if (src) paths.push(src[1]);
  }
  return paths;
}

export function checkBundleSize(distDir, budget = ENTRY_BUDGET_BYTES) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const entries = entryScriptPaths(html);
  if (entries.length === 0) throw new Error('no module entry script in index.html');
  return entries.map((src) => {
    const bytes = fs.statSync(path.join(distDir, src)).size;
    return { src, bytes, ok: bytes <= budget };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const distDir = path.resolve(process.argv[2] ?? 'dist');
  let failed = false;
  for (const { src, bytes, ok } of checkBundleSize(distDir)) {
    const kb = (bytes / 1000).toFixed(1);
    console.log(`${ok ? 'ok' : 'FAIL'}  ${src}: ${kb} kB (budget ${ENTRY_BUDGET_BYTES / 1000} kB)`);
    failed ||= !ok;
  }
  if (failed) {
    console.error('Entry chunk over budget: move the new heavy import behind import().');
    process.exit(1);
  }
}
