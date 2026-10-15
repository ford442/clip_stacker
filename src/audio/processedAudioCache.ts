/**
 * Preview half of clip insert effects: the decoded (or rate-remapped) buffer
 * run through the media engine's C++ insert chain, cached per clip, then
 * scheduled like any other buffer.
 *
 * This is how preview and export hear the same EQ / compressor without a
 * second implementation: the export mix runs the identical `InsertChain` per
 * entry. A clip with no enabled block, or a session without the media engine
 * (`?no_media_engine`, failed load), plays the dry buffer — there is
 * deliberately no `BiquadFilterNode` fallback. An edit replaces the cache
 * key, so the buffer is rebuilt (the Inspector debounces drags).
 *
 * Remaining preview/export differences, both small: the preview designs the
 * filters at the AudioContext rate instead of the 48 kHz export rate (only
 * audible near Nyquist), and the bus limiter is export-only.
 */

import type { AudioScheduleEntry } from './schedule';
import { audioEffectsSignature } from '../utils/audioEffects';
import {
  isMediaEngineMixEnabled,
  loadMediaEngineModule,
} from '../wasm/mediaEngine';
import { applyInsertChainToPcm } from '../wasm/mediaEngineInsertChain';

interface ProcessedEntry {
  source: AudioBuffer;
  key: string;
  buffer: AudioBuffer;
}

function entryRate(entry: AudioScheduleEntry): number {
  if (entry.rateRemap) return 1;
  return Number.isFinite(entry.playbackRate) && entry.playbackRate > 0 ? entry.playbackRate : 1;
}

export class ProcessedAudioCache {
  private readonly entries = new Map<string, ProcessedEntry>();
  private readonly inflight = new Map<string, Promise<AudioBuffer>>();

  /**
   * `source` with the entry's insert chain applied from its trim start (where
   * the export mix's chain starts), or `source` itself when there is nothing
   * to apply or the media engine is unavailable.
   */
  async get(entry: AudioScheduleEntry, source: AudioBuffer, ctx: BaseAudioContext): Promise<AudioBuffer> {
    const signature = audioEffectsSignature(entry.audioEffects);
    if (!signature || !isMediaEngineMixEnabled()) return source;

    const rate = entryRate(entry);
    const startFrame = Math.max(0, Math.round(entry.bufferOffset * source.sampleRate));
    const key = `${signature}|${startFrame}|${rate}`;
    const cached = this.entries.get(entry.clipId);
    if (cached && cached.source === source && cached.key === key) return cached.buffer;

    const inflightKey = `${entry.clipId}|${key}`;
    const pending = this.inflight.get(inflightKey);
    if (pending) return pending;

    const work = (async () => {
      try {
        if (!(await loadMediaEngineModule())) return source;
        const channels = Math.min(2, source.numberOfChannels);
        const planes: Float32Array<ArrayBuffer>[] = [];
        for (let c = 0; c < channels; c++) planes.push(new Float32Array(source.getChannelData(c)));
        if (!applyInsertChainToPcm(planes, source.sampleRate, entry.audioEffects, { startFrame, playbackRate: rate })) {
          return source;
        }
        // The export mix reads only the first two channels; so does this buffer.
        const buffer = ctx.createBuffer(channels, source.length, source.sampleRate);
        for (let c = 0; c < channels; c++) buffer.copyToChannel(planes[c]!, c);
        this.entries.set(entry.clipId, { source, key, buffer });
        return buffer;
      } finally {
        this.inflight.delete(inflightKey);
      }
    })();
    this.inflight.set(inflightKey, work);
    return work;
  }

  prune(keepIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!keepIds.has(id)) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
