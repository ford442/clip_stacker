import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createWavWriter } from './wavWriter';
import { createZipBundle } from './zipBundle';

const MTIME = new Date(2026, 10, 19, 10, 20, 30);

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  dosTime: number;
  dosDate: number;
}

/** The central directory, read from the end-of-central-directory record (no archive comment). */
function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      dosTime: view.getUint16(offset + 12, true),
      dosDate: view.getUint16(offset + 14, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipBytes(result: Blob | Uint8Array): Promise<Uint8Array> {
  return result instanceof Uint8Array ? result : new Uint8Array(await result.arrayBuffer());
}

function names(...inputs: string[]): string[] {
  const bundle = createZipBundle({ mtime: MTIME });
  return inputs.map((name) => bundle.add(name, 'x'));
}

describe('createZipBundle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips bytes, parts and text through unzipSync', async () => {
    const bundle = createZipBundle({ mtime: MTIME });
    const pcm = new Uint8Array(70_000).map((_, i) => (i * 37) & 0xff);
    bundle.add('stems/Dialogue.wav', [pcm.subarray(0, 1000), pcm.subarray(1000)]);
    bundle.add('project.json', JSON.stringify({ name: 'Demo', lanes: ['Dialogue', 'Music'] }));
    bundle.add('notes.txt', new TextEncoder().encode('Ünïcode — notes\n'));
    bundle.add('empty.bin', []);
    const result = bundle.finish();
    expect(result).toBeInstanceOf(Blob);
    expect((result as Blob).type).toBe('application/zip');

    const files = unzipSync(await zipBytes(result));
    expect(Object.keys(files)).toEqual(['stems/Dialogue.wav', 'project.json', 'notes.txt', 'empty.bin']);
    expect(files['stems/Dialogue.wav']).toEqual(pcm);
    expect(JSON.parse(strFromU8(files['project.json']!))).toEqual({ name: 'Demo', lanes: ['Dialogue', 'Music'] });
    expect(strFromU8(files['notes.txt']!)).toBe('Ünïcode — notes\n');
    expect(files['empty.bin']).toEqual(new Uint8Array(0));
  });

  it('stores binary entries and deflates text, unless told otherwise', async () => {
    const bundle = createZipBundle({ mtime: MTIME });
    const text = 'clip '.repeat(2000);
    bundle.add('a.wav', new Uint8Array(4096));
    bundle.add('timeline.otio', text);
    bundle.add('sidecar.json', new TextEncoder().encode(text));
    bundle.add('raw.txt', text, { compress: false });
    bundle.add('blob.bin', new Uint8Array(4096), { compress: true });
    const entries = centralDirectory(await zipBytes(bundle.finish()));
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ['a.wav', 0],
      ['timeline.otio', 8],
      ['sidecar.json', 8],
      ['raw.txt', 0],
      ['blob.bin', 8],
    ]);
    const stored = entries[0]!;
    expect(stored.compressedSize).toBe(4096);
    expect(stored.size).toBe(4096);
    expect(entries[1]!.compressedSize).toBeLessThan(text.length / 10);
    // Streamed entries carry a data descriptor (general purpose bit 3).
    expect(entries.every((e) => (e.flags & 0x8) !== 0)).toBe(true);
  });

  it('passes stored bytes through by reference', () => {
    const bundle = createZipBundle({ mtime: MTIME });
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    bundle.add('take.wav', [first, second]);
    const parts = bundle.finishParts();
    expect(parts).toContain(first);
    expect(parts).toContain(second);
  });

  it('carries a Broadcast WAV writer\'s parts into the archive unchanged', async () => {
    const writer = createWavWriter({ trackName: 'Music', bext: { originationDate: '2026-11-19', originationTime: '10:20:30' } });
    writer.write(new Float32Array([0.5, -0.5, 0.25, -0.25]));
    const wav = writer.finish();
    const bundle = createZipBundle({ mtime: MTIME });
    bundle.add('Music.wav', wav.parts);
    const files = unzipSync(await zipBytes(bundle.finish()));
    const expected = new Uint8Array(wav.byteLength);
    let offset = 0;
    for (const part of wav.parts) {
      expected.set(part, offset);
      offset += part.length;
    }
    expect(files['Music.wav']).toEqual(expected);
  });

  it('sanitizes names so nothing leaves the extraction folder', () => {
    expect(
      names(
        '../../etc/passwd',
        '/abs/x.wav',
        'C:\\Users\\me\\a.wav',
        'a/./b//c.wav',
        'bad<>:"|?*name.wav',
        'tab\there\u0001.wav',
        'dots. /trailing.  ',
        '..',
        '',
        '...',
        'Ünïcode — mix.wav',
      ),
    ).toEqual([
      'etc/passwd',
      'abs/x.wav',
      'C_/Users/me/a.wav',
      'a/b/c.wav',
      'bad_______name.wav',
      'tab_here_.wav',
      'dots/trailing',
      'file',
      'file (2)',
      'file (3)',
      'Ünïcode — mix.wav',
    ]);
  });

  it('makes names unique, case-insensitively, before the extension', () => {
    expect(names('mix.wav', 'mix.wav', 'Mix.WAV', 'README', 'README', '.hidden', '.hidden', 'a.b/c.wav', 'a.b/c.wav')).toEqual([
      'mix.wav',
      'mix (2).wav',
      'Mix (3).WAV',
      'README',
      'README (2)',
      '.hidden',
      '.hidden (2)',
      'a.b/c.wav',
      'a.b/c (2).wav',
    ]);
  });

  it('keeps files and folders from claiming the same path', async () => {
    const bundle = createZipBundle({ mtime: MTIME });
    expect(bundle.add('stems', 'file')).toBe('stems');
    expect(bundle.add('stems/a.wav', 'a')).toBe('stems (2)/a.wav');
    expect(bundle.add('stems/b.wav', 'b')).toBe('stems (2)/b.wav');
    expect(bundle.add('Stems (2)', 'c')).toBe('Stems (2) (2)');
    expect(bundle.names).toEqual(['stems', 'stems (2)/a.wav', 'stems (2)/b.wav', 'Stems (2) (2)']);
    expect(Object.keys(unzipSync(await zipBytes(bundle.finish())))).toEqual(bundle.names);
  });

  it('writes the given modification time and identical bytes for identical input', async () => {
    const build = async (): Promise<Uint8Array> => {
      const bundle = createZipBundle({ mtime: MTIME });
      bundle.add('a.wav', new Uint8Array([1, 2, 3]));
      bundle.add('b.json', '{}');
      return zipBytes(bundle.finish());
    };
    const [first, second] = await Promise.all([build(), build()]);
    expect(first).toEqual(second);
    const entry = centralDirectory(first)[0]!;
    expect(entry.dosDate).toBe(((2026 - 1980) << 9) | (11 << 5) | 19);
    expect(entry.dosTime).toBe((10 << 11) | (20 << 5) | 15);
  });

  it('returns one Uint8Array where Blob does not exist', () => {
    vi.stubGlobal('Blob', undefined);
    const bundle = createZipBundle({ mtime: MTIME });
    bundle.add('a.txt', 'hello');
    const result = bundle.finish();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(strFromU8(unzipSync(result as Uint8Array)['a.txt']!)).toBe('hello');
  });

  it('copies SharedArrayBuffer views into the Blob', async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([9, 8, 7, 6]);
    const bundle = createZipBundle({ mtime: MTIME });
    bundle.add('shared.bin', shared);
    expect(unzipSync(await zipBytes(bundle.finish()))['shared.bin']).toEqual(new Uint8Array([9, 8, 7, 6]));
  });

  it('refuses a stored entry past 4 GiB before writing it, and stays usable', async () => {
    const bundle = createZipBundle({ mtime: MTIME });
    const huge = { length: 2 ** 32 } as unknown as Uint8Array;
    expect(() => bundle.add('huge.wav', [huge])).toThrow(/4 GiB/);
    expect(bundle.add('huge.wav', new Uint8Array([1]))).toBe('huge.wav');
    expect(unzipSync(await zipBytes(bundle.finish()))['huge.wav']).toEqual(new Uint8Array([1]));
  });

  it('reports a bad modification time and refuses use after finish', () => {
    const early = createZipBundle({ mtime: new Date(1970, 0, 1) });
    expect(() => early.add('a.txt', 'x')).toThrow();
    expect(() => early.add('b.txt', 'x')).toThrow();

    const bundle = createZipBundle({ mtime: MTIME });
    bundle.add('a.txt', 'x');
    bundle.finishParts();
    expect(() => bundle.add('b.txt', 'x')).toThrow(/already finished/);
    expect(() => bundle.finish()).toThrow(/already finished/);
  });
});
