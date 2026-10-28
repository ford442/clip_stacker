/**
 * Working-media store: large blobs keyed by a stable content key.
 *
 * #279 replaces the backing with OPFS (IndexedDB fallback) so entries survive
 * a reload. Until then the only implementation is in memory: callers program
 * against the async {@link MediaStore} interface, so swapping the backing does
 * not touch them, but nothing here outlives the tab.
 *
 * Proxies are the first tenant (`proxyStoreKey` in `proxyMedia.ts`); original
 * clip bytes move in with #279.
 */

export interface MediaStore {
  /** Store (or replace) `blob` under `key`. */
  put(key: string, blob: Blob): Promise<void>;
  /** The blob stored under `key`, or null when absent (never throws for a miss). */
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  /** Remove `key`. Deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
  /** Whether entries survive a page reload (false for the in-memory store). */
  readonly persistent: boolean;
}

export function createMemoryMediaStore(): MediaStore {
  const entries = new Map<string, Blob>();
  return {
    persistent: false,
    async put(key, blob) {
      entries.set(key, blob);
    },
    async get(key) {
      return entries.get(key) ?? null;
    },
    async has(key) {
      return entries.has(key);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

let activeStore: MediaStore = createMemoryMediaStore();

/** The process-wide working-media store. */
export function getMediaStore(): MediaStore {
  return activeStore;
}

/** Swap the backing store (tests, and the #279 OPFS store at boot). */
export function setMediaStore(store: MediaStore): void {
  activeStore = store;
}

/** Bytes hashed from each end of a file by {@link fingerprintMedia}. */
export const FINGERPRINT_EDGE_BYTES = 1024 * 1024;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cheap, stable content key for a media file: SHA-256 over its byte length
 * plus the first and last {@link FINGERPRINT_EDGE_BYTES}. Hashing a multi-GB
 * camera file end to end would stall import for seconds; the container header
 * (head) and index/trailer (tail) already differ between any two real clips.
 */
export async function fingerprintMedia(blob: Blob): Promise<string> {
  const size = blob.size;
  const head = blob.slice(0, Math.min(size, FINGERPRINT_EDGE_BYTES));
  const tail = size > FINGERPRINT_EDGE_BYTES ? blob.slice(Math.max(FINGERPRINT_EDGE_BYTES, size - FINGERPRINT_EDGE_BYTES)) : null;
  const sizeBytes = new TextEncoder().encode(`${size}:`);
  const parts: BlobPart[] = [sizeBytes, await head.arrayBuffer()];
  if (tail) parts.push(await tail.arrayBuffer());
  const bytes = await new Blob(parts).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}
