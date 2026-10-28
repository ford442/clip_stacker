import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffDirs, syncDir, syncFfmpegCore } from './sync-ffmpeg-core.mjs';

let root: string;

function write(rel: string, contents: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** A fake repo: both core packages installed at `version`, ffmpegCommon pinned to `pinned`. */
function fakeRepo(version: string, pinned: string) {
  for (const pkg of ['core', 'core-mt']) {
    write(`node_modules/@ffmpeg/${pkg}/package.json`, JSON.stringify({ version }));
    write(`node_modules/@ffmpeg/${pkg}/dist/esm/ffmpeg-core.js`, `${pkg} js ${version}`);
    write(`node_modules/@ffmpeg/${pkg}/dist/esm/ffmpeg-core.wasm`, `${pkg} wasm ${version}`);
  }
  write('node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js', 'worker');
  write('src/ffmpeg/ffmpegCommon.ts', `export const FFMPEG_CORE_VERSION = '${pinned}';\n`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-ffmpeg-core-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sync-ffmpeg-core', () => {
  it('reports missing, stale and unexpected files', () => {
    write('src/a.js', 'a');
    write('src/b.wasm', 'b');
    write('dest/a.js', 'old a');
    write('dest/extra.js', 'x');
    const problems = diffDirs(path.join(root, 'src'), path.join(root, 'dest'));
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/stale .*a\.js/);
    expect(problems.join('\n')).toMatch(/missing .*b\.wasm/);
    expect(problems.join('\n')).toMatch(/unexpected .*extra\.js/);
  });

  it('makes the destination a verbatim copy', () => {
    write('src/a.js', 'a');
    write('dest/extra.js', 'x');
    syncDir(path.join(root, 'src'), path.join(root, 'dest'));
    expect(diffDirs(path.join(root, 'src'), path.join(root, 'dest'))).toEqual([]);
  });

  it('copies both cores, including the mt pthread worker, then checks clean', () => {
    fakeRepo('0.12.10', '0.12.10');
    expect(syncFfmpegCore({ root, check: true, log: () => {} })).not.toEqual([]);
    expect(syncFfmpegCore({ root, log: () => {} })).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'public/ffmpeg-core-mt')).sort()).toEqual([
      'ffmpeg-core.js',
      'ffmpeg-core.wasm',
      'ffmpeg-core.worker.js',
    ]);
    expect(syncFfmpegCore({ root, check: true, log: () => {} })).toEqual([]);
  });

  it('flags a CDN fallback version that does not match the installed cores', () => {
    fakeRepo('0.12.10', '0.12.6');
    syncFfmpegCore({ root, log: () => {} });
    const problems = syncFfmpegCore({ root, check: true, log: () => {} });
    expect(problems).toEqual([expect.stringMatching(/FFMPEG_CORE_VERSION is 0\.12\.6/)]);
  });
});
