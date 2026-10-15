/**
 * The preview's processed-buffer path for clip insert effects: the same C++
 * `InsertChain` the export mix runs per entry (`insert_chain_*` in
 * `native/media_engine/src/audio_mix.cpp`), applied to decoded PCM.
 */

import type { ClipAudioEffects } from '../utils/audioEffects';
import { CS_STATUS, getEmscriptenModule, withHeap } from './emscriptenLoader';
import { isMediaEngineMixEnabled, MEDIA_ENGINE_MODULE } from './mediaEngine';
import { MIX_FX_STRIDE, packAudioEffectRows, sanitizedRate } from './mediaEngineLayout';

interface InsertChainModule {
  _insert_chain_create?(designSampleRate: number, effectsPtr: number, effectCount: number): number;
  _insert_chain_process?(chain: number, planarPtr: number, frames: number, channels: number): number;
  _insert_chain_destroy?(chain: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

/** Frames per `insert_chain_process` call: bounds the heap a long clip needs. */
const INSERT_CHAIN_BLOCK_FRAMES = 1 << 16;

/**
 * Run a clip insert chain in place over planar PCM, from `startFrame` to the
 * end — the preview's processed-buffer path, through the same C++ chain the
 * export mix runs per entry. `playbackRate` designs the filters for the
 * output-domain rate (`sampleRate * playbackRate`), as the mix hears them
 * after resampling.
 *
 * Synchronous; false when the media engine is not loaded or disabled
 * (callers then play the dry buffer — never a Web Audio approximation).
 */
export function applyInsertChainToPcm(
  channelData: Float32Array[],
  sampleRate: number,
  effects: ClipAudioEffects | undefined,
  options: { startFrame?: number; playbackRate?: number } = {},
): boolean {
  const mod = getEmscriptenModule<InsertChainModule>(MEDIA_ENGINE_MODULE);
  if (!mod || !isMediaEngineMixEnabled() || typeof mod._insert_chain_create !== 'function') return false;
  const rows = packAudioEffectRows(effects);
  if (rows.length === 0) return true;
  const planes = Math.min(2, channelData.length);
  if (planes === 0 || !(sampleRate > 0)) return false;
  let length = Infinity;
  for (let c = 0; c < planes; c++) length = Math.min(length, channelData[c]!.length);
  const start = Math.max(0, Math.floor(options.startFrame ?? 0));
  const designRate = sampleRate * sanitizedRate(options.playbackRate);
  const block = Math.max(1, Math.min(INSERT_CHAIN_BLOCK_FRAMES, length - start));

  const ok = withHeap(mod, (heap) => {
    const rowsPtr = heap.f64(rows);
    const pcmPtr = heap.alloc(block * planes * 4);
    const chain = mod._insert_chain_create!(designRate, rowsPtr, rows.length / MIX_FX_STRIDE);
    if (!chain) return false;
    try {
      for (let begin = start; begin < length; begin += block) {
        const frames = Math.min(block, length - begin);
        const input = heap.f32View(pcmPtr, frames * planes);
        for (let c = 0; c < planes; c++) input.set(channelData[c]!.subarray(begin, begin + frames), c * frames);
        if (mod._insert_chain_process!(chain, pcmPtr, frames, planes) !== CS_STATUS.OK) return false;
        const output = heap.f32View(pcmPtr, frames * planes);
        for (let c = 0; c < planes; c++) channelData[c]!.set(output.subarray(c * frames, (c + 1) * frames), begin);
      }
      return true;
    } finally {
      mod._insert_chain_destroy?.(chain);
    }
  });
  return ok === true;
}
