/**
 * Helpers for Emscripten MODULARIZE/EXPORT_ES6 loaders.
 *
 * Vitest (happy-dom) exposes `window`, so generated glue may take the browser
 * `fetch` path. Node's fetch rejects `file://` — inject `wasmBinary` instead.
 */

export type EmscriptenFactory<T> = (opts?: {
  locateFile?: (path: string, prefix?: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
}) => Promise<T>;

export function resolveWasmAssetUrl(fileName: string, baseUrl?: string, fallbackBase?: string): string {
  const root = baseUrl
    ? baseUrl.endsWith('/')
      ? baseUrl
      : `${baseUrl}/`
    : fallbackBase ?? '';
  return new URL(fileName, root).href;
}

export async function readWasmBinaryIfFileUrl(
  wasmUrl: string,
): Promise<Uint8Array | undefined> {
  if (!wasmUrl.startsWith('file:')) return undefined;
  if (typeof process === 'undefined' || !process.versions?.node) return undefined;
  try {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'),
      import('node:url'),
    ]);
    const buf = await readFile(fileURLToPath(wasmUrl));
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}
