import { describe, expect, it } from 'vitest';
import {
  createMemoryCacheBackend,
  createOpfsCacheBackend,
  type CacheBackend,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
} from './cacheBackend';
import { INDEX_PATH, RenderCache, renderCachePath } from './renderCache';
import {
  decodeSegmentRecord,
  decoderConfigIdentity,
  encodeSegmentRecord,
  segmentPayloadBytes,
  type SegmentRecord,
} from './segmentRecord';

function record(bytesPerPacket = 100, packets = 3, description = [1, 2, 3]): SegmentRecord {
  return {
    frameCount: packets,
    config: {
      codec: 'avc1.42001f',
      codedWidth: 320,
      codedHeight: 180,
      description: new Uint8Array(description),
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    },
    packets: Array.from({ length: packets }, (_, i) => ({
      type: i === 0 ? ('key' as const) : ('delta' as const),
      timestamp: i * 33_333,
      duration: 33_333,
      data: new Uint8Array(bytesPerPacket).fill(i + 1),
    })),
  };
}

/** An in-memory OPFS directory: just enough of the handle API for the backend. */
function fakeOpfs(clock: () => number = Date.now): OpfsDirectoryHandle {
  const makeDir = (): OpfsDirectoryHandle => {
    const children = new Map<string, OpfsDirectoryHandle | OpfsFileHandle>();
    const notFound = () => new DOMException('missing', 'NotFoundError');
    return {
      kind: 'directory',
      async getDirectoryHandle(name, options) {
        let child = children.get(name);
        if (!child) {
          if (!options?.create) throw notFound();
          child = makeDir();
          children.set(name, child);
        }
        if (child.kind !== 'directory') throw new DOMException('file', 'TypeMismatchError');
        return child;
      },
      async getFileHandle(name, options) {
        let child = children.get(name);
        if (!child) {
          if (!options?.create) throw notFound();
          let bytes = new Uint8Array(0);
          let modified = clock();
          const handle: OpfsFileHandle = {
            kind: 'file',
            async getFile() {
              return new File([bytes.slice()], name, { lastModified: modified });
            },
            async createWritable() {
              const parts: Uint8Array[] = [];
              return {
                async write(data: Uint8Array) {
                  parts.push(data.slice());
                },
                async close() {
                  const total = parts.reduce((n, p) => n + p.byteLength, 0);
                  const next = new Uint8Array(total);
                  let at = 0;
                  for (const p of parts) {
                    next.set(p, at);
                    at += p.byteLength;
                  }
                  bytes = next;
                  modified = clock();
                },
              };
            },
          };
          child = handle;
          children.set(name, child);
        }
        if (child.kind !== 'file') throw new DOMException('dir', 'TypeMismatchError');
        return child;
      },
      async removeEntry(name) {
        if (!children.delete(name)) throw notFound();
      },
      async *entries() {
        for (const entry of [...children]) yield entry;
      },
    };
  };
  return makeDir();
}

describe('segment records', () => {
  it('round-trip packets, config and frame count', () => {
    const original = record();
    const decoded = decodeSegmentRecord(encodeSegmentRecord(original));
    expect(decoded).toEqual(original);
    expect(segmentPayloadBytes(decoded)).toBe(300);
  });

  it('reject torn, foreign and non-key-first records', () => {
    const bytes = encodeSegmentRecord(record());
    expect(() => decodeSegmentRecord(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => decodeSegmentRecord(new Uint8Array([1, 2, 3]))).toThrow(/Not a render-cache segment/);
    const delta = record();
    delta.packets[0]!.type = 'delta';
    expect(() => encodeSegmentRecord(delta)).toThrow(/key frame/);
  });

  it('identifies parameter sets by family and description', () => {
    const a = decoderConfigIdentity({ codec: 'avc1.64001e', description: new Uint8Array([1]) });
    expect(decoderConfigIdentity({ codec: 'avc3.64001e', description: new Uint8Array([1]) })).toBe(a);
    expect(decoderConfigIdentity({ codec: 'avc1.64001e', description: new Uint8Array([2]) })).not.toBe(a);
    expect(decoderConfigIdentity({ codec: 'hvc1.1.6.L93.B0', description: new Uint8Array([1]) })).not.toBe(a);
  });
});

describe.each<[string, () => CacheBackend]>([
  ['memory', () => createMemoryCacheBackend()],
  ['opfs', () => createOpfsCacheBackend(fakeOpfs())],
])('RenderCache over %s', (_name, makeBackend) => {
  it('stores and reads segments by settings + segment key', async () => {
    const cache = new RenderCache(makeBackend());
    await cache.ready();
    expect(await cache.read('s', 'k')).toBeNull();
    expect(await cache.write('s', 'k', record())).toBe(true);
    expect(cache.peek('s', 'k')).toMatchObject({ frames: 3 });
    expect(await cache.read('s', 'k')).toEqual(record());
    expect(await cache.read('other', 'k')).toBeNull();
    expect(cache.usage()).toMatchObject({ entries: 1 });
  });

  it('evicts least recently used entries down to the budget, skipping pinned ones', async () => {
    let now = 1000;
    const size = encodeSegmentRecord(record(200)).byteLength;
    const budget = size * 2 + size / 2; // room for two entries
    const cache = new RenderCache(makeBackend(), { budgetBytes: budget, now: () => now });
    await cache.write('s', 'a', record(200));
    now += 10;
    await cache.write('s', 'b', record(200));
    now += 10;
    await cache.read('s', 'a'); // a is now more recent than b
    const release = cache.pin([renderCachePath('s', 'b')]);
    now += 10;
    await cache.write('s', 'c', record(200));
    // Budget fits two entries: b is the LRU but pinned, so a goes.
    expect(cache.peek('s', 'a')).toBeNull();
    expect(cache.peek('s', 'b')).not.toBeNull();
    release();
    await cache.flush();
    now += 10;
    await cache.write('s', 'd', record(200));
    expect(cache.peek('s', 'b')).toBeNull();
    expect(cache.usage().bytes).toBeLessThanOrEqual(budget);
  });

  it('never stores a segment larger than the whole budget', async () => {
    const cache = new RenderCache(makeBackend(), { budgetBytes: 100 });
    expect(await cache.write('s', 'k', record(500))).toBe(false);
    expect(cache.usage().entries).toBe(0);
  });

  it('shrinking the budget evicts, and clear empties', async () => {
    const cache = new RenderCache(makeBackend());
    await cache.write('s', 'a', record());
    await cache.write('s', 'b', record());
    await cache.setBudget(encodeSegmentRecord(record()).byteLength);
    expect(cache.usage().entries).toBe(1);
    expect(cache.peek('s', 'b')).not.toBeNull();
    await cache.clear();
    expect(cache.usage()).toMatchObject({ entries: 0, bytes: 0 });
    expect(await cache.read('s', 'b')).toBeNull();
  });

  it('notifies listeners with the usage after a store', async () => {
    const cache = new RenderCache(makeBackend());
    const seen: number[] = [];
    cache.onChange((usage) => seen.push(usage.entries));
    await cache.write('s', 'a', record());
    expect(seen.at(-1)).toBe(1);
  });
});

describe('RenderCache persistence', () => {
  it('survives a reload: the index keeps LRU order and unindexed files are adopted', async () => {
    let now = 1;
    const backend = createOpfsCacheBackend(fakeOpfs(() => now));
    const first = new RenderCache(backend, { now: () => now });
    await first.write('s', 'old', record());
    now = 50;
    await first.write('s', 'new', record());
    now = 60;
    await first.read('s', 'old');
    await first.flush();
    // A file written behind the index's back (a crash between file and index).
    await backend.write(renderCachePath('s', 'stray'), encodeSegmentRecord(record()));

    const reloaded = new RenderCache(backend, { now: () => now });
    await reloaded.ready();
    expect(reloaded.usage().entries).toBe(3);
    expect(reloaded.peek('s', 'old')!.lastUsed).toBeGreaterThan(reloaded.peek('s', 'new')!.lastUsed);
    expect(await reloaded.read('s', 'stray')).toEqual(record());
  });

  it('drops index entries whose file is gone and removes unreadable files', async () => {
    const backend = createMemoryCacheBackend();
    const cache = new RenderCache(backend);
    await cache.write('s', 'gone', record());
    await cache.write('s', 'torn', record());
    await backend.remove(renderCachePath('s', 'gone'));
    await backend.write(renderCachePath('s', 'torn'), new Uint8Array([0x43, 0x53, 0x52, 0x43, 9]));
    const reloaded = new RenderCache(backend);
    await reloaded.ready();
    expect(reloaded.peek('s', 'gone')).toBeNull();
    expect(await reloaded.read('s', 'torn')).toBeNull();
    expect(await backend.read(renderCachePath('s', 'torn'))).toBeNull();
    expect(await backend.read(INDEX_PATH)).not.toBeNull();
  });

  it('ignores a corrupt index', async () => {
    const backend = createMemoryCacheBackend();
    await backend.write(INDEX_PATH, new TextEncoder().encode('{not json'));
    await backend.write(renderCachePath('s', 'k'), encodeSegmentRecord(record()));
    const cache = new RenderCache(backend);
    await cache.ready();
    expect(cache.peek('s', 'k')).not.toBeNull();
  });
});
