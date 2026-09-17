/**
 * IndexedDB cache for Whisper weight files.
 *
 * A `ggml` model is tens to hundreds of megabytes; downloading it once per
 * page load would make auto-captioning unusable. Weights are data, not code —
 * they are stored verbatim under their source URL and handed to the WASM
 * module as bytes.
 *
 * Every entry point degrades to "not cached" rather than throwing: a private
 * window with IndexedDB blocked should still be able to transcribe after a
 * fresh download.
 */

const DB_NAME = 'clip-stacker-whisper';
const DB_VERSION = 1;
const STORE = 'models';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const request = run(tx.objectStore(STORE));
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

/** Cached bytes for `url`, or null when nothing is stored. */
export async function readCachedModel(url: string): Promise<Uint8Array | null> {
  const stored = await withStore<ArrayBuffer>('readonly', (store) => store.get(url));
  return stored ? new Uint8Array(stored) : null;
}

export async function writeCachedModel(url: string, bytes: Uint8Array): Promise<void> {
  const copy = bytes.slice().buffer;
  await withStore('readwrite', (store) => store.put(copy, url));
}

export async function hasCachedModel(url: string): Promise<boolean> {
  const keys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  return Array.isArray(keys) && keys.includes(url);
}

/**
 * Cached weights for `url`, downloading and caching them on a miss.
 * `onProgress` receives 0–1 while downloading when the server sends a length.
 */
export async function fetchModel(
  url: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number | null) => void } = {},
): Promise<Uint8Array> {
  const cached = await readCachedModel(url);
  if (cached) return cached;

  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Model download failed (${response.status} ${response.statusText})`);
  }

  const total = Number(response.headers.get('content-length') ?? '0');
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeCachedModel(url, bytes);
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      options.onProgress?.(total > 0 ? Math.min(1, received / total) : null);
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  await writeCachedModel(url, bytes);
  return bytes;
}
