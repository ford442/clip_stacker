/**
 * Remap an AudioBuffer along a clip's playbackRate automation curve
 * (pitch-preserving WSOLA via WASM, with a JS OLA fallback).
 */

import type { Clip } from '../types';
import { getClipPlaybackRate } from './playbackRate';
import {
  clipHasRateAutomation,
  integrateRateToSourceOffset,
  remappedClipDuration,
} from './timeRemap';
import { wasmRemapPlanar } from '../wasm/timeStretch';

const HOP = 256;

function toPlanar(buffer: AudioBuffer, startFrame: number, frameCount: number): Float32Array {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const planar = new Float32Array(frameCount * channels);
  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(ch);
    const dstOffset = ch * frameCount;
    for (let i = 0; i < frameCount; i++) {
      const idx = startFrame + i;
      planar[dstOffset + i] = idx >= 0 && idx < src.length ? src[idx] : 0;
    }
  }
  return planar;
}

function fromPlanar(
  ctx: BaseAudioContext,
  planar: Float32Array,
  frames: number,
  channels: number,
  sampleRate: number,
): AudioBuffer {
  const out = ctx.createBuffer(channels, frames, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    out.copyToChannel(planar.subarray(ch * frames, (ch + 1) * frames), ch);
  }
  return out;
}

/** Build source-frame offsets for each synthesis hop center. */
export function buildSourceOffsetMap(
  clip: Pick<Clip, 'playbackRate' | 'automation'>,
  outFrames: number,
  sampleRate: number,
  hop: number,
): Float32Array {
  const numHops = Math.max(1, Math.ceil(outFrames / hop) + 1);
  const offsets = new Float32Array(numHops);
  const defaultRate = getClipPlaybackRate(clip);
  const track = clip.automation?.playbackRate;
  for (let h = 0; h < numHops; h++) {
    const tOut = (h * hop) / sampleRate;
    const sourceSec = integrateRateToSourceOffset(track, defaultRate, tOut);
    offsets[h] = sourceSec * sampleRate;
  }
  return offsets;
}

/** JS OLA fallback when WASM is unavailable (same hop geometry). */
function jsRemapPlanar(
  input: Float32Array,
  inFrames: number,
  channels: number,
  offsets: Float32Array,
  outFrames: number,
  hop: number,
): Float32Array {
  const win = hop * 2;
  const window = new Float32Array(win);
  for (let i = 0; i < win; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, win - 1)));
  }
  const output = new Float32Array(outFrames * channels);
  const norm = new Float32Array(outFrames);

  const sampleAt = (ch: number, pos: number): number => {
    const base = ch * inFrames;
    if (inFrames <= 0) return 0;
    if (pos <= 0) return input[base];
    if (pos >= inFrames - 1) return input[base + inFrames - 1];
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    return input[base + i0] * (1 - frac) + input[base + Math.min(inFrames - 1, i0 + 1)] * frac;
  };

  for (let h = 0; h < offsets.length; h++) {
    const outCenter = h * hop;
    if (outCenter >= outFrames) break;
    const srcCenter = offsets[h];
    const outStart = outCenter - hop;
    const srcStart = srcCenter - hop;
    for (let i = 0; i < win; i++) {
      const outIdx = outStart + i;
      if (outIdx < 0 || outIdx >= outFrames) continue;
      const w = window[i];
      const srcPos = srcStart + i;
      for (let ch = 0; ch < channels; ch++) {
        output[ch * outFrames + outIdx] += sampleAt(ch, srcPos) * w;
      }
      norm[outIdx] += w;
    }
  }

  for (let i = 0; i < outFrames; i++) {
    if (norm[i] > 1e-6) {
      for (let ch = 0; ch < channels; ch++) {
        output[ch * outFrames + i] /= norm[i];
      }
    }
  }
  return output;
}

/**
 * Produce a pitch-preserved buffer spanning the remapped output duration.
 * Source is trimmed to the clip's trim window before stretching.
 * Returns null when the source window is empty.
 */
export async function remapClipAudioBuffer(
  clip: Pick<
    Clip,
    'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'
  >,
  source: AudioBuffer,
  audioCtx: BaseAudioContext,
): Promise<AudioBuffer | null> {
  const sr = source.sampleRate;
  const channels = Math.min(2, Math.max(1, source.numberOfChannels));
  const trimStart = Math.max(0, clip.trimStart);
  const trimEnd = Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration;
  const sourceLenSec = Math.max(0, Math.min(source.duration, trimEnd) - trimStart);
  if (sourceLenSec <= 1e-4) return null;

  const startFrame = Math.floor(trimStart * sr);
  const inFrames = Math.max(1, Math.floor(sourceLenSec * sr));
  const outSec = remappedClipDuration(clip);
  const outFrames = Math.max(1, Math.floor(outSec * sr));

  const planarIn = toPlanar(source, startFrame, inFrames);
  const offsets = buildSourceOffsetMap(clip, outFrames, sr, HOP);

  let planarOut = await wasmRemapPlanar(
    planarIn,
    inFrames,
    channels,
    offsets,
    outFrames,
    HOP,
  );
  if (!planarOut) {
    planarOut = jsRemapPlanar(planarIn, inFrames, channels, offsets, outFrames, HOP);
  }

  return fromPlanar(audioCtx, planarOut, outFrames, channels, sr);
}

/** True when schedule should play a remapped buffer at rate 1. */
export function scheduleNeedsRateRemap(
  clip: Pick<Clip, 'automation'>,
): boolean {
  return clipHasRateAutomation(clip);
}
