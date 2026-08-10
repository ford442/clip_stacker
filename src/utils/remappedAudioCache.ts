/**
 * Resolve the AudioBuffer for a schedule entry — optionally pitch-preserving
 * remapped when `rateRemap` is set.
 */

import type { AudioScheduleEntry } from '../audio/schedule';
import type { ClipAudioCache } from '../audio/clipAudioCache';
import { remapClipAudioBuffer } from './remapAudio';

interface RemapCacheEntry {
  key: string;
  buffer: AudioBuffer;
}

/** Session cache for remapped buffers (keyed by clip + curve signature). */
export class RemappedAudioCache {
  private readonly entries = new Map<string, RemapCacheEntry>();

  private signature(entry: AudioScheduleEntry): string {
    const clip = entry.rateRemapClip;
    const keys = clip?.automation?.playbackRate ?? [];
    const curve = keys.map((k) => `${k.t}:${k.value}`).join(',');
    return [
      entry.clipId,
      entry.objectUrl,
      clip?.trimStart ?? 0,
      clip?.trimEnd ?? 'nan',
      clip?.playbackRate ?? 1,
      curve,
      entry.duration,
    ].join('|');
  }

  async get(
    entry: AudioScheduleEntry,
    sourceCache: ClipAudioCache,
    ctx: BaseAudioContext,
  ): Promise<AudioBuffer | null> {
    if (!entry.rateRemap || !entry.rateRemapClip) {
      return sourceCache.get(entry.clipId, entry.objectUrl, ctx);
    }

    const key = this.signature(entry);
    const existing = this.entries.get(entry.clipId);
    if (existing && existing.key === key) return existing.buffer;

    const source = await sourceCache.get(entry.clipId, entry.objectUrl, ctx);
    if (!source) return null;

    const remapped = await remapClipAudioBuffer(entry.rateRemapClip, source, ctx);
    if (!remapped) return null;
    this.entries.set(entry.clipId, { key, buffer: remapped });
    return remapped;
  }

  clear(): void {
    this.entries.clear();
  }

  prune(keepIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!keepIds.has(id)) this.entries.delete(id);
    }
  }
}
