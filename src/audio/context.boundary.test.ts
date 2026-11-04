import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every non-test source file under `src/`, comments stripped. */
function sources(): { path: string; code: string }[] {
  const root = join(process.cwd(), 'src');
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      out.push({ path: relative(root, path).split('\\').join('/'), code });
    }
  };
  walk(root);
  return out;
}

describe('audio context boundary', () => {
  it('constructs real-time AudioContexts only through audioService', () => {
    const offenders = sources()
      .filter(({ path }) => path !== 'audio/context.ts' && path !== 'audio/audioService.ts')
      .filter(({ code }) => /\bnew\s+(window\.)?(webkit)?AudioContext\b|\bwebkitAudioContext\b|\bcreateAudioContext\s*\(/.test(code))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('decodes audio only through decodeAudio', () => {
    const offenders = sources()
      .filter(({ path }) => path !== 'audio/decodeAudio.ts')
      .filter(({ code }) => /\.decodeAudioData\s*\(/.test(code))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
