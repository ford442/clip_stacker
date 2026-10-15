import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CS_STATUS,
  describeStatus,
  getEmscriptenLoadFailure,
  getEmscriptenModule,
  getWasmPublicBaseUrl,
  HeapAllocationError,
  isWasmDebugRequested,
  loadEmscriptenModule,
  withHeap,
  _resetEmscriptenModuleForTests,
  _setLoaderSleepForTests,
} from './emscriptenLoader';

/** A bump allocator over a heap that `grow()` replaces, like memory.grow does. */
function fakeModule(bytes = 1024) {
  let heap = new Uint8Array(bytes);
  let next = 16;
  const freed: number[] = [];
  return {
    get HEAPU8() {
      return heap;
    },
    _malloc: vi.fn((size: number) => {
      const ptr = next;
      if (ptr + size > heap.length) return 0;
      next += Math.ceil(size / 8) * 8;
      return ptr;
    }),
    _free: vi.fn((ptr: number) => {
      freed.push(ptr);
    }),
    freed,
    grow() {
      const grown = new Uint8Array(heap.length * 2);
      grown.set(heap);
      heap = grown;
    },
  };
}

// Under a `/public/wasm/` path so Vitest externalizes the fake glue like the
// real modules (vitest.config.ts) instead of transforming it.
const root = mkdtempSync(path.join(tmpdir(), 'cs-loader-'));
const tmp = path.join(root, 'public', 'wasm');
mkdirSync(tmp, { recursive: true });
const TMP_BASE = pathToFileURL(tmp + path.sep).href;
writeFileSync(
  path.join(tmp, 'fake_ok.js'),
  'export default async function createFakeOk(opts) { return { opts, _malloc() { return 8; }, _free() {}, HEAPU8: new Uint8Array(64) }; }\n',
);
writeFileSync(path.join(tmp, 'fake_nofactory.js'), 'export default 42;\n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('withHeap', () => {
  it('copies in and out and frees every block afterwards', () => {
    const mod = fakeModule();
    const out = withHeap(mod, (heap) => {
      const a = heap.f32([1, 2, 3]);
      const b = heap.f64([0.5]);
      heap.f32View(a, 3)[1] = 20;
      return [...heap.readF32(a, 3), ...heap.readF64(b, 1)];
    });
    expect(out).toEqual([1, 20, 3, 0.5]);
    expect(mod._malloc).toHaveBeenCalledTimes(2);
    expect(mod.freed).toHaveLength(2);
  });

  it('returns null when _malloc returns 0, freeing what it already allocated', () => {
    const mod = fakeModule(64);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn((heap: { alloc(n: number): number }) => {
      heap.alloc(16);
      heap.alloc(4096);
      return 'unreachable';
    });
    expect(withHeap(mod, fn)).toBeNull();
    expect(mod.freed).toEqual([16]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats a misaligned block as a failed allocation', () => {
    const mod = fakeModule();
    mod._malloc.mockReturnValueOnce(12);
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});
    expect(withHeap(mod, (heap) => heap.alloc(8))).toBeNull();
    expect(mod.freed).toEqual([12]);
  });

  it('frees and rethrows other errors', () => {
    const mod = fakeModule();
    expect(() =>
      withHeap(mod, (heap) => {
        heap.alloc(8);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(mod.freed).toHaveLength(1);
  });

  it('reads results through views made after a call that grew the heap', () => {
    const mod = fakeModule(256);
    const out = withHeap(mod, (heap) => {
      const ptr = heap.alloc(8);
      const stale = heap.f32View(ptr, 2);
      // A "module call" that grows memory, then writes its result.
      mod.grow();
      new Float32Array(mod.HEAPU8.buffer, ptr, 2).set([7, 9]);
      expect(stale.buffer).not.toBe(mod.HEAPU8.buffer);
      return heap.readF32(ptr, 2);
    });
    expect(Array.from(out!)).toEqual([7, 9]);
  });

  it('exposes HeapAllocationError with the requested size', () => {
    expect(new HeapAllocationError(32).bytes).toBe(32);
  });
});

describe('cs_status', () => {
  it('mirrors cs_status.h', () => {
    expect(CS_STATUS).toEqual({ OK: 0, EINVAL: -1, ENOMEM: -2, ESTATE: -3, ERANGE: -4, EINTERNAL: -5 });
    expect(describeStatus(-2)).toBe('CS_ENOMEM');
    expect(describeStatus(-99)).toBe('status -99');
  });
});

describe('loadEmscriptenModule', () => {
  const sleep = vi.fn(async (_ms: number) => {});

  beforeEach(() => {
    _resetEmscriptenModuleForTests();
    _setLoaderSleepForTests(sleep);
    sleep.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    _setLoaderSleepForTests(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads once and shares the instance', async () => {
    const [a, b] = await Promise.all([
      loadEmscriptenModule<{ opts: { locateFile(p: string): string } }>('fake_ok', 'createFakeOk', {
        baseUrl: TMP_BASE,
      }),
      loadEmscriptenModule('fake_ok', 'createFakeOk', { baseUrl: TMP_BASE }),
    ]);
    expect(getEmscriptenLoadFailure('fake_ok')).toBeNull();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(getEmscriptenModule('fake_ok')).toBe(a);
    expect(a!.opts.locateFile('fake_ok.wasm')).toBe(`${TMP_BASE}fake_ok.wasm`);
  });

  it('retries a transient failure with backoff, then cools down instead of giving up for good', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const base = 'unsupported-scheme://cdn.example/wasm/';
    expect(await loadEmscriptenModule('flaky', 'createFlaky', { baseUrl: base })).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 1000]);
    expect(getEmscriptenLoadFailure('flaky')).toBeTruthy();

    // Inside the cooldown: no new attempt.
    expect(await loadEmscriptenModule('flaky', 'createFlaky', { baseUrl: base })).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(2);

    // After it: tried again.
    vi.setSystemTime(Date.now() + 6_000);
    expect(await loadEmscriptenModule('flaky', 'createFlaky', { baseUrl: base })).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('does not retry a missing local file', async () => {
    expect(await loadEmscriptenModule('missing', 'createMissing', { baseUrl: TMP_BASE })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('disables a glue file without a factory for the session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await loadEmscriptenModule('fake_nofactory', 'createX', { baseUrl: TMP_BASE })).toBeNull();
    expect(getEmscriptenLoadFailure('fake_nofactory')).toMatch(/factory/);
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(await loadEmscriptenModule('fake_nofactory', 'createX', { baseUrl: TMP_BASE })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('?wasm_debug', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is read from the query string', () => {
    expect(isWasmDebugRequested('?wasm_debug')).toBe(true);
    expect(isWasmDebugRequested('?a=1&wasm_debug=1')).toBe(true);
    expect(isWasmDebugRequested('?a=1')).toBe(false);
  });

  it('points the base URL at /wasm-debug/', () => {
    expect(getWasmPublicBaseUrl()).toMatch(/\/wasm\/$/);
    vi.stubGlobal('location', { search: '?wasm_debug' });
    expect(getWasmPublicBaseUrl()).toMatch(/\/wasm-debug\/$/);
  });
});
