import { decodeAudioBuffer } from '../media/waveform';

interface CacheEntry {
  objectUrl: string;
  buffer: AudioBuffer;
}

/**
 * Decodes and caches `AudioBuffer`s keyed by clip id. Re-decodes when the
 * clip's `objectUrl` changes (e.g. after RIFE reprocessing).
 */
export class ClipAudioCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AudioBuffer | null>>();

  /**
   * Return a cached buffer or decode one (48 kHz, `decodeAudio`). Null when
   * decode fails. An AudioBuffer is not tied to a context, so preview and
   * export share these.
   */
  async get(clipId: string, objectUrl: string): Promise<AudioBuffer | null> {
    const existing = this.entries.get(clipId);
    if (existing && existing.objectUrl === objectUrl) {
      return existing.buffer;
    }

    const inflightKey = `${clipId}:${objectUrl}`;
    const pending = this.inflight.get(inflightKey);
    if (pending) return pending;

    const decodePromise = (async (): Promise<AudioBuffer | null> => {
      try {
        const buffer = await decodeAudioBuffer(objectUrl);
        this.entries.set(clipId, { objectUrl, buffer });
        return buffer;
      } catch {
        return null;
      } finally {
        this.inflight.delete(inflightKey);
      }
    })();

    this.inflight.set(inflightKey, decodePromise);
    return decodePromise;
  }

  /** Drop buffers for clip ids not in `keepIds`. */
  prune(keepIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!keepIds.has(id)) this.entries.delete(id);
    }
  }

  /** Drop one clip's decoded buffer (streaming export frees PCM as it goes). */
  delete(clipId: string): void {
    this.entries.delete(clipId);
  }

  has(clipId: string, objectUrl: string): boolean {
    const entry = this.entries.get(clipId);
    return Boolean(entry && entry.objectUrl === objectUrl);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
