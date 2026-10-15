#!/usr/bin/env node
/**
 * Copy the FFmpeg WASM cores from node_modules into public/ so the app serves
 * them itself (src/ffmpeg/ffmpegCommon.ts tries the local copy before any CDN).
 *
 *   @ffmpeg/core     dist/esm → public/ffmpeg-core/     (single-threaded)
 *   @ffmpeg/core-mt  dist/esm → public/ffmpeg-core-mt/  (multi-threaded, + pthread worker)
 *
 * Usage:
 *   node scripts/sync-ffmpeg-core.mjs           copy (npm run sync:ffmpeg-core)
 *   node scripts/sync-ffmpeg-core.mjs --check   exit 1 if public/ differs from
 *                                               node_modules, or the CDN fallback
 *                                               version in ffmpegCommon.ts does not
 *                                               match the installed packages
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Packages whose ESM dist is mirrored verbatim into public/. */
export const FFMPEG_CORE_TARGETS = [
  { pkg: '@ffmpeg/core', dest: 'public/ffmpeg-core' },
  { pkg: '@ffmpeg/core-mt', dest: 'public/ffmpeg-core-mt' },
];

/** Where ffmpegCommon.ts pins the CDN fallback version. */
const VERSION_SOURCE = 'src/ffmpeg/ffmpegCommon.ts';
const VERSION_RE = /export const FFMPEG_CORE_VERSION = '([^']+)'/;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Differences that would make `dest` not a verbatim copy of `src`.
 * @param {string} src
 * @param {string} dest
 * @returns {string[]} one human-readable line per problem
 */
export function diffDirs(src, dest) {
  const problems = [];
  const srcFiles = listFiles(src);
  const destFiles = new Set(listFiles(dest));
  for (const name of srcFiles) {
    if (!destFiles.has(name)) {
      problems.push(`missing ${path.join(dest, name)}`);
    } else if (sha256(path.join(src, name)) !== sha256(path.join(dest, name))) {
      problems.push(`stale ${path.join(dest, name)}`);
    }
    destFiles.delete(name);
  }
  for (const name of destFiles) {
    problems.push(`unexpected ${path.join(dest, name)} (not in ${src})`);
  }
  return problems;
}

/**
 * Make `dest` a verbatim copy of `src` (extra files removed).
 * @param {string} src
 * @param {string} dest
 */
export function syncDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const srcFiles = listFiles(src);
  for (const name of listFiles(dest)) {
    if (!srcFiles.includes(name)) fs.rmSync(path.join(dest, name));
  }
  for (const name of srcFiles) {
    const to = path.join(dest, name);
    fs.copyFileSync(path.join(src, name), to);
    // npm tarballs disagree on the wasm's exec bit between releases; keep the
    // committed copies stable.
    fs.chmodSync(to, 0o644);
  }
  return srcFiles;
}

function readInstalled(root, pkg) {
  const pkgDir = path.join(root, 'node_modules', pkg);
  const manifest = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifest)) {
    throw new Error(`${pkg} is not installed — run npm ci first.`);
  }
  const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  return { version, distDir: path.join(pkgDir, 'dist', 'esm') };
}

/**
 * @param {{ root?: string, check?: boolean, log?: (line: string) => void }} [options]
 * @returns {string[]} problems found (check mode) or left after copying
 */
export function syncFfmpegCore({ root = ROOT, check = false, log = console.log } = {}) {
  const problems = [];
  const versions = new Set();
  for (const { pkg, dest } of FFMPEG_CORE_TARGETS) {
    const { version, distDir } = readInstalled(root, pkg);
    versions.add(version);
    const destDir = path.join(root, dest);
    if (check) {
      problems.push(
        ...diffDirs(distDir, destDir).map((line) => line.split(`${root}${path.sep}`).join('')),
      );
    } else {
      const files = syncDir(distDir, destDir);
      log(`[sync-ffmpeg-core] ${pkg}@${version} → ${dest}/ (${files.join(', ')})`);
    }
  }

  if (versions.size !== 1) {
    problems.push(
      `@ffmpeg/core and @ffmpeg/core-mt versions differ (${[...versions].join(' vs ')}); pin both to the same release.`,
    );
  }
  const source = fs.readFileSync(path.join(root, VERSION_SOURCE), 'utf8');
  const pinned = VERSION_RE.exec(source)?.[1];
  const [installed] = versions;
  if (pinned !== installed) {
    problems.push(
      `${VERSION_SOURCE} FFMPEG_CORE_VERSION is ${pinned ?? 'missing'} but node_modules has ${installed}; update it so the CDN fallbacks match the self-hosted core.`,
    );
  }
  return problems;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const check = process.argv.includes('--check');
  try {
    const problems = syncFfmpegCore({ check });
    if (problems.length > 0) {
      for (const line of problems) console.error(`[sync-ffmpeg-core] ${line}`);
      if (check) console.error('[sync-ffmpeg-core] run `npm run sync:ffmpeg-core` and commit public/.');
      process.exit(1);
    }
    if (check) console.log('[sync-ffmpeg-core] public/ffmpeg-core{,-mt} match node_modules.');
  } catch (err) {
    console.error('[sync-ffmpeg-core] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
