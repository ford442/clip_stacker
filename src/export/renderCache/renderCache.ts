/**
 * The render cache: encoded segments addressed by content
 * (`<settingsKey>/<segmentKey>.chunk`), kept least-recently-used under a byte
 * budget. Export reads a segment back instead of rendering and encoding it
 * again (`segmentedExport.ts`).
 *
 * An index file (`index.json`) remembers each entry's size and last use, so
 * eviction order survives a reload. On open it is reconciled with what is
 * actually on disk: files the index does not know are adopted (last use =
 * file time), entries whose file is gone are dropped. A file that does not
 * parse is removed and reads as a miss.
 *
 * Every operation runs on one queue, so a write, an eviction and a clear
 * never interleave. During an export the segments it plans to read are
 * pinned: eviction passes over them, so a planned hit cannot turn into a
 * miss halfway through (the budget may be exceeded until the export ends).
 */

import type { CacheBackend } from './cacheBackend';
import { DEFAULT_RENDER_CACHE_BUDGET, type RenderCacheUsage } from './renderCacheConfig';
import {
  decodeSegmentRecord,
  decoderConfigIdentity,
  encodeSegmentRecord,
  type SegmentRecord,
} from './segmentRecord';

export const INDEX_PATH = 'index.json';
const INDEX_VERSION = 1;


export interface RenderCacheEntry {
  bytes: number;
  lastUsed: number;
  /** Output frames the segment covers (0 when adopted from disk unindexed). */
  frames: number;
  /** `decoderConfigIdentity` of its packets ('' when unknown). */
  config: string;
}


interface IndexFile {
  v: number;
  entries: Record<string, RenderCacheEntry>;
}

export function renderCachePath(settingsKey: string, segmentKey: string): string {
  return `${settingsKey}/${segmentKey}.chunk`;
}

export class RenderCache {
  private readonly entries = new Map<string, RenderCacheEntry>();
  private readonly pinned = new Map<string, number>();
  private readonly listeners = new Set<(usage: RenderCacheUsage) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  private budgetBytes: number;
  private readonly now: () => number;
  private clock = 0;
  private dirty = false;

  constructor(
    readonly backend: CacheBackend,
    options: { budgetBytes?: number; now?: () => number } = {},
  ) {
    this.budgetBytes = Math.max(0, options.budgetBytes ?? DEFAULT_RENDER_CACHE_BUDGET);
    this.now = options.now ?? Date.now;
  }

  /** Load and reconcile the index (once). Every other method waits for it. */
  ready(): Promise<void> {
    this.loaded ??= this.enqueue(() => this.load());
    return this.loaded;
  }

  usage(): RenderCacheUsage {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bytes;
    return {
      bytes,
      entries: this.entries.size,
      budgetBytes: this.budgetBytes,
      persistent: this.backend.persistent,
      backend: this.backend.kind,
    };
  }

  onChange(listener: (usage: RenderCacheUsage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The index entry, without touching its last use. Call after `ready()`. */
  peek(settingsKey: string, segmentKey: string): RenderCacheEntry | null {
    return this.entries.get(renderCachePath(settingsKey, segmentKey)) ?? null;
  }

  /** Protect these entries from eviction until the returned release is called. */
  pin(paths: Iterable<string>): () => void {
    const list = [...paths];
    for (const path of list) this.pinned.set(path, (this.pinned.get(path) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const path of list) {
        const count = (this.pinned.get(path) ?? 1) - 1;
        if (count <= 0) this.pinned.delete(path);
        else this.pinned.set(path, count);
      }
      void this.enqueue(() => this.evictToBudget()).catch(() => undefined);
    };
  }

  /** The cached segment, or null for a miss (an unreadable file is removed). */
  async read(settingsKey: string, segmentKey: string): Promise<SegmentRecord | null> {
    await this.ready();
    const path = renderCachePath(settingsKey, segmentKey);
    return this.enqueue(async () => {
      const entry = this.entries.get(path);
      if (!entry) return null;
      const bytes = await this.backend.read(path).catch(() => null);
      let record: SegmentRecord | null = null;
      if (bytes) {
        try {
          record = decodeSegmentRecord(bytes);
        } catch {
          record = null;
        }
      }
      if (!record) {
        this.entries.delete(path);
        await this.backend.remove(path).catch(() => undefined);
        await this.persist();
        return null;
      }
      entry.lastUsed = this.tick();
      if (!entry.frames) entry.frames = record.frameCount;
      if (!entry.config) entry.config = decoderConfigIdentity(record.config);
      // A hit only reorders the LRU: written with the next store or `flush()`.
      this.dirty = true;
      return record;
    });
  }

  /**
   * Store a segment, then evict least-recently-used entries down to the
   * budget. Resolves false when nothing was stored (larger than the whole
   * budget, or the write failed — a full disk is a miss next time, not an
   * export failure).
   */
  async write(settingsKey: string, segmentKey: string, record: SegmentRecord): Promise<boolean> {
    await this.ready();
    const path = renderCachePath(settingsKey, segmentKey);
    const bytes = encodeSegmentRecord(record);
    return this.enqueue(async () => {
      if (bytes.byteLength > this.budgetBytes) return false;
      try {
        await this.backend.write(path, bytes);
      } catch {
        // Quota: make room and try once more.
        await this.evictToBudget(this.budgetBytes / 2);
        try {
          await this.backend.write(path, bytes);
        } catch {
          return false;
        }
      }
      this.entries.set(path, {
        bytes: bytes.byteLength,
        lastUsed: this.tick(),
        frames: record.frameCount,
        config: decoderConfigIdentity(record.config),
      });
      await this.evictToBudget();
      await this.persist();
      return true;
    });
  }

  /** Write the index if hits reordered it since the last write. */
  async flush(): Promise<void> {
    await this.ready();
    await this.enqueue(async () => {
      if (this.dirty) await this.persist();
    });
  }

  async setBudget(budgetBytes: number): Promise<void> {
    await this.ready();
    this.budgetBytes = Math.max(0, budgetBytes);
    await this.enqueue(async () => {
      await this.evictToBudget();
      await this.persist();
    });
  }

  /** Remove every cached segment. */
  async clear(): Promise<void> {
    await this.ready();
    await this.enqueue(async () => {
      this.entries.clear();
      await this.backend.clear();
      await this.persist();
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Last-use stamps strictly increase, even within one millisecond. */
  private tick(): number {
    this.clock = Math.max(this.clock + 1, this.now());
    return this.clock;
  }

  private async load(): Promise<void> {
    let index: IndexFile | null = null;
    try {
      const bytes = await this.backend.read(INDEX_PATH);
      if (bytes) {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as IndexFile;
        if (parsed?.v === INDEX_VERSION && parsed.entries && typeof parsed.entries === 'object') index = parsed;
      }
    } catch {
      index = null;
    }
    const files = await this.backend.list().catch(() => []);
    for (const file of files) {
      if (!file.path.endsWith('.chunk')) continue;
      const known = index?.entries[file.path];
      this.entries.set(file.path, {
        bytes: file.size,
        lastUsed: known?.lastUsed ?? file.lastModified,
        frames: known?.frames ?? 0,
        config: known?.config ?? '',
      });
      this.clock = Math.max(this.clock, known?.lastUsed ?? file.lastModified);
    }
    await this.evictToBudget();
    await this.persist();
  }

  private async evictToBudget(target = this.budgetBytes): Promise<void> {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    if (total <= target) return;
    const order = [...this.entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [path, entry] of order) {
      if (total <= target) break;
      if (this.pinned.has(path)) continue;
      try {
        await this.backend.remove(path);
      } catch {
        continue;
      }
      this.entries.delete(path);
      total -= entry.bytes;
    }
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    const index: IndexFile = { v: INDEX_VERSION, entries: Object.fromEntries(this.entries) };
    try {
      await this.backend.write(INDEX_PATH, new TextEncoder().encode(JSON.stringify(index)));
    } catch {
      // The index is a hint; a reload re-adopts the files without it.
    }
    const usage = this.usage();
    for (const listener of this.listeners) listener(usage);
  }
}
