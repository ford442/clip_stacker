/**
 * One loader and one heap boundary for every Emscripten module
 * (MODULARIZE + EXPORT_ES6 glue under `public/wasm/`).
 *
 * - `loadEmscriptenModule` instantiates a module once per realm, retries
 *   transient fetch failures with backoff, and after a failed load allows
 *   another attempt after a cooldown instead of disabling the feature until
 *   reload.
 * - `withHeap` is the only way module memory is allocated from JS: every
 *   `_malloc` is null-checked, typed views are rebuilt from the current
 *   buffer (a call that grows memory detaches the old ones), and every block
 *   is freed when the scope ends, on success, failure or trap.
 *
 * Vitest (happy-dom) exposes `window`, so generated glue takes the browser
 * `fetch` path, and Node's fetch rejects `file://`: for file URLs the loader
 * reads the bytes and instantiates them itself through `instantiateWasm`.
 */

/**
 * Factory options: `INCOMING_MODULE_JS_API` in native/toolchain.cmake. The
 * glue calls `instantiateWasm(imports, receive)` instead of fetching.
 */
export type EmscriptenFactory<T> = (opts?: {
  locateFile?: (path: string, prefix?: string) => string;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ) => object;
}) => Promise<T>;

/** What `withHeap` needs from a module. */
export interface EmscriptenHeapModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

/** `cs_status` from `native/common/include/cs_status.h`. */
export const CS_STATUS = {
  OK: 0,
  EINVAL: -1,
  ENOMEM: -2,
  ESTATE: -3,
  ERANGE: -4,
  EINTERNAL: -5,
} as const;

const CS_STATUS_NAMES: Record<number, string> = {
  0: 'CS_OK',
  [-1]: 'CS_EINVAL',
  [-2]: 'CS_ENOMEM',
  [-3]: 'CS_ESTATE',
  [-4]: 'CS_ERANGE',
  [-5]: 'CS_EINTERNAL',
};

export function describeStatus(rc: number): string {
  return CS_STATUS_NAMES[rc] ?? `status ${rc}`;
}

// ---------------------------------------------------------------------------
// Asset URLs

/** `?wasm_debug`: load `npm run build:wasm:debug` output from `/wasm-debug/`. */
export const WASM_DEBUG_PARAM = 'wasm_debug';

// Through a variable, not `new URL('…', import.meta.url)`: Vite treats that
// literal form as an asset reference and warns that the folder does not exist
// at build time. These URLs are only ever resolved at runtime.
const MODULE_URL = import.meta.url;

/** Repo-relative public assets (Node / Vitest). */
const NODE_WASM_BASE = new URL('../../public/wasm/', MODULE_URL);

export function isWasmDebugRequested(
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).has(WASM_DEBUG_PARAM);
}

function releaseWasmBaseUrl(): string {
  if (typeof document !== 'undefined') {
    return new URL('wasm/', document.baseURI).href;
  }
  // Bundled workers live under `assets/`; WASM is copied to `dist/wasm/`.
  if (typeof self !== 'undefined' && typeof MODULE_URL === 'string') {
    return new URL('../wasm/', MODULE_URL).href;
  }
  if (typeof window !== 'undefined') {
    return new URL('wasm/', window.location.href).href;
  }
  return NODE_WASM_BASE.href;
}

/**
 * Public URL for the `public/wasm/` directory (main thread and workers), or
 * the debug build next to it under `?wasm_debug`. A worker's `location` is its
 * script URL, so workers get the debug base only when main passes it in.
 */
export function getWasmPublicBaseUrl(): string {
  const base = releaseWasmBaseUrl();
  return isWasmDebugRequested() ? new URL('../wasm-debug/', base).href : base;
}

export function resolveWasmAssetUrl(fileName: string, baseUrl?: string): string {
  const root = baseUrl ? (baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`) : getWasmPublicBaseUrl();
  return new URL(fileName, root).href;
}

export async function readWasmBinaryIfFileUrl(wasmUrl: string): Promise<Uint8Array | undefined> {
  if (!wasmUrl.startsWith('file:')) return undefined;
  if (typeof process === 'undefined' || !process.versions?.node) return undefined;
  try {
    // Specifiers in variables keep the browser bundle from trying to resolve
    // (and warning about) Node built-ins this branch never reaches there.
    const fsSpecifier = 'node:fs/promises';
    const urlSpecifier = 'node:url';
    const [{ readFile }, { fileURLToPath }] = (await Promise.all([
      import(/* @vite-ignore */ fsSpecifier),
      import(/* @vite-ignore */ urlSpecifier),
    ])) as [typeof import('node:fs/promises'), typeof import('node:url')];
    const buf = await readFile(fileURLToPath(wasmUrl));
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Loading

export interface LoadEmscriptenModuleOptions {
  /** Directory holding `<name>.js` / `<name>.wasm` (trailing slash optional). */
  baseUrl?: string;
  /** Attempts within one load before giving up (default 3). */
  attempts?: number;
}

interface ModuleState {
  module: unknown;
  promise: Promise<unknown> | null;
  failure: string | null;
  failures: number;
  /** `Date.now()` before which a failed module is not retried. */
  retryAt: number;
}

const RETRY_DELAYS_MS = [250, 1000];
const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 60_000;

const states = new Map<string, ModuleState>();
/** Instance → module name, so a trap inside `withHeap` can retire its instance. */
const instanceNames = new WeakMap<object, string>();
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function stateFor(name: string): ModuleState {
  let state = states.get(name);
  if (!state) {
    state = { module: null, promise: null, failure: null, failures: 0, retryAt: 0 };
    states.set(name, state);
  }
  return state;
}

class PermanentLoadError extends Error {}

/**
 * Worth retrying: a network hiccup or a CDN/server blip. A local file that is
 * missing (tests), a glue file without its factory, or a binary that fails to
 * compile will fail the same way again.
 */
function isTransient(err: unknown, jsUrl: string): boolean {
  if (err instanceof PermanentLoadError) return false;
  if (typeof WebAssembly !== 'undefined') {
    if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError) return false;
  }
  return !jsUrl.startsWith('file:');
}

async function instantiate<T>(name: string, factoryName: string, baseUrl: string): Promise<T> {
  const jsUrl = resolveWasmAssetUrl(`${name}.js`, baseUrl);
  const wasmUrl = resolveWasmAssetUrl(`${name}.wasm`, baseUrl);
  const glue = (await import(/* @vite-ignore */ jsUrl)) as Record<string, unknown>;
  const factory = (glue[factoryName] ?? glue.default) as EmscriptenFactory<T> | undefined;
  if (typeof factory !== 'function') {
    throw new PermanentLoadError(`${name}: module factory ${factoryName} missing`);
  }
  const locateFile = (path: string) => (path.endsWith('.wasm') ? wasmUrl : resolveWasmAssetUrl(path, baseUrl));
  const wasmBinary = await readWasmBinaryIfFileUrl(wasmUrl);
  if (!wasmBinary) return factory({ locateFile });

  // The glue awaits `receive` and never sees a compile error here, so race
  // the factory against one: a bad binary must reject, not hang.
  let fail: (err: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const created = factory({
    locateFile,
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(wasmBinary as BufferSource, imports).then(
        ({ instance, module }) => receive(instance, module),
        fail,
      );
      return {};
    },
  });
  return Promise.race([created, failed]);
}

/**
 * Load `public/wasm/<name>.js` once and instantiate it with its
 * `factoryName` export. Resolves null when it cannot be loaded (the feature
 * stays off); the reason is in `getEmscriptenLoadFailure(name)`. Concurrent
 * callers share one load, and the first successful `baseUrl` wins.
 */
export function loadEmscriptenModule<T>(
  name: string,
  factoryName: string,
  options?: LoadEmscriptenModuleOptions,
): Promise<T | null> {
  const state = stateFor(name);
  if (state.module) return Promise.resolve(state.module as T);
  if (state.promise) return state.promise as Promise<T | null>;
  if (state.failure && Date.now() < state.retryAt) return Promise.resolve(null);

  const bases = options?.baseUrl
    ? [options.baseUrl]
    : isWasmDebugRequested()
      ? [getWasmPublicBaseUrl(), releaseWasmBaseUrl()]
      : [releaseWasmBaseUrl()];
  const attempts = Math.max(1, options?.attempts ?? 3);

  const promise = (async (): Promise<T | null> => {
    let lastError: unknown = null;
    for (const base of bases) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const instance = await instantiate<T>(name, factoryName, base);
          if (base !== bases[0]) console.warn(`[wasm] ${name}: debug build unavailable, using ${base}`);
          state.module = instance;
          state.failure = null;
          state.failures = 0;
          if (instance && typeof instance === 'object') instanceNames.set(instance, name);
          return instance;
        } catch (err) {
          lastError = err;
          if (!isTransient(err, resolveWasmAssetUrl(`${name}.js`, base)) || attempt === attempts - 1) break;
          await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    state.failures += 1;
    state.failure = message;
    const permanent = lastError instanceof PermanentLoadError;
    state.retryAt = permanent
      ? Number.POSITIVE_INFINITY
      : Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (state.failures - 1));
    console.warn(`[wasm] ${name} unavailable:`, message);
    return null;
  })();
  state.promise = promise;
  void promise.finally(() => {
    if (state.promise === promise) state.promise = null;
  });
  return promise;
}

/** The loaded instance, synchronously (null until a load has succeeded). */
export function getEmscriptenModule<T>(name: string): T | null {
  return (states.get(name)?.module as T | undefined) ?? null;
}

/** Why the last load failed (null when loaded, loading, or never tried). */
export function getEmscriptenLoadFailure(name: string): string | null {
  return states.get(name)?.failure ?? null;
}

/**
 * Drop an instance that trapped: Emscripten marks itself aborted and its heap
 * may be half-written, so the next load builds a fresh instance instead.
 */
function retireInstance(mod: object, err: unknown): void {
  const name = instanceNames.get(mod);
  if (!name) return;
  const state = states.get(name);
  if (!state || state.module !== mod) return;
  state.module = null;
  state.failure = err instanceof Error ? err.message : String(err);
  state.retryAt = 0;
  console.warn(`[wasm] ${name} trapped; it will be re-instantiated on next use:`, state.failure);
}

/** Forget one module's load state, or every module's (tests). */
export function _resetEmscriptenModuleForTests(name?: string): void {
  if (name) states.delete(name);
  else states.clear();
}

/** Replace the retry back-off sleep (tests). */
export function _setLoaderSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

// ---------------------------------------------------------------------------
// Heap boundary

/** A `_malloc` returned 0 (or a misaligned block): the module heap is full. */
export class HeapAllocationError extends Error {
  constructor(readonly bytes: number) {
    super(`WASM heap allocation of ${bytes} bytes failed`);
    this.name = 'HeapAllocationError';
  }
}

/**
 * Allocations inside one `withHeap` call. Pointers are 8-byte aligned. Copies
 * in and out use views made at that moment, so they are valid even after a
 * module call grew (and detached) the heap; `f32View` and friends must be
 * re-acquired after any call into the module.
 */
export interface HeapScope {
  /** Allocate `bytes` (at least 8). */
  alloc(bytes: number): number;
  /** Allocate and copy `data` in as f32 / f64 / bytes. */
  f32(data: ArrayLike<number>): number;
  f64(data: ArrayLike<number>): number;
  u8(data: ArrayLike<number>): number;
  /** Copy `count` values out of the heap. */
  readF32(ptr: number, count: number): Float32Array;
  readF64(ptr: number, count: number): Float64Array;
  /** Live views (valid until the next call into the module). */
  f32View(ptr: number, count: number): Float32Array;
  f64View(ptr: number, count: number): Float64Array;
  i32View(ptr: number, count: number): Int32Array;
  u8View(ptr: number, count: number): Uint8Array;
}

class Scope implements HeapScope {
  private readonly blocks: number[] = [];

  constructor(private readonly mod: EmscriptenHeapModule) {}

  alloc(bytes: number): number {
    const size = Math.max(8, Math.ceil(bytes));
    const ptr = this.mod._malloc(size);
    if (!ptr || ptr & 7) {
      if (ptr) this.mod._free(ptr);
      throw new HeapAllocationError(size);
    }
    this.blocks.push(ptr);
    return ptr;
  }

  f32(data: ArrayLike<number>): number {
    const ptr = this.alloc(data.length * 4);
    this.f32View(ptr, data.length).set(data);
    return ptr;
  }

  f64(data: ArrayLike<number>): number {
    const ptr = this.alloc(data.length * 8);
    this.f64View(ptr, data.length).set(data);
    return ptr;
  }

  u8(data: ArrayLike<number>): number {
    const ptr = this.alloc(data.length);
    this.u8View(ptr, data.length).set(data);
    return ptr;
  }

  readF32(ptr: number, count: number): Float32Array {
    return this.f32View(ptr, count).slice();
  }

  readF64(ptr: number, count: number): Float64Array {
    return this.f64View(ptr, count).slice();
  }

  f32View(ptr: number, count: number): Float32Array {
    return new Float32Array(this.mod.HEAPU8.buffer, ptr, count);
  }

  f64View(ptr: number, count: number): Float64Array {
    return new Float64Array(this.mod.HEAPU8.buffer, ptr, count);
  }

  i32View(ptr: number, count: number): Int32Array {
    return new Int32Array(this.mod.HEAPU8.buffer, ptr, count);
  }

  u8View(ptr: number, count: number): Uint8Array {
    return new Uint8Array(this.mod.HEAPU8.buffer, ptr, count);
  }

  release(): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      try {
        this.mod._free(this.blocks[i]!);
      } catch {
        // An aborted module throws on every export; its heap is gone anyway.
      }
    }
    this.blocks.length = 0;
  }
}

/**
 * Run `fn` with a heap scope and free everything it allocated afterwards.
 * Returns null (and logs) when an allocation fails, so callers fall back
 * exactly as they do for an unloaded module. A WASM trap retires the
 * instance (the next `loadEmscriptenModule` builds a fresh one) and rethrows.
 * `fn` must be synchronous: the scope ends when it returns.
 */
export function withHeap<R>(mod: EmscriptenHeapModule, fn: (heap: HeapScope) => R): R | null {
  const scope = new Scope(mod);
  try {
    return fn(scope);
  } catch (err) {
    if (err instanceof HeapAllocationError) {
      console.warn(`[wasm] ${instanceNames.get(mod) ?? 'module'}: ${err.message}`);
      return null;
    }
    if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) {
      retireInstance(mod, err);
    }
    throw err;
  } finally {
    scope.release();
  }
}
