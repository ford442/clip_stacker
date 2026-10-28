import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBundleSize, entryScriptPaths } from './check-bundle-size.mjs';

describe('check-bundle-size', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function dist(entryBytes: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'x'.repeat(entryBytes));
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<head><script type="module" crossorigin src="./assets/index-abc.js"></script>' +
        '<script src="./legacy.js"></script><link rel="modulepreload" href="./assets/x.js"></head>',
    );
    return dir;
  }

  it('reads only module entry scripts', () => {
    expect(
      entryScriptPaths('<script type="module" src="./a.js"></script><script src="b.js"></script>'),
    ).toEqual(['./a.js']);
  });

  it('passes under the budget and fails over it', () => {
    expect(checkBundleSize(dist(100), 200)).toEqual([{ src: './assets/index-abc.js', bytes: 100, ok: true }]);
    expect(checkBundleSize(dist(300), 200)[0].ok).toBe(false);
  });
});
