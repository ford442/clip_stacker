/**
 * Speed automation helpers for timeline waveform visualization.
 * Maps source-time peaks to output-time display using ∫ rate dt.
 */

import type { Clip } from '../types';
import {
  integrateRateToSourceOffset,
  remappedClipDuration,
  sampleRemapCurve,
} from './timeRemap';
import { getClipPlaybackRate } from './playbackRate';

export { integrateRateToSourceOffset, sampleRemapCurve };

/**
 * Remap source-time waveform peaks to output-time buckets so the drawn
 * waveform stretches/squashes as the speed automation curve changes.
 */
export function remapWaveformPeaks(
  sourcePeaks: Float32Array,
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'>,
  outputBuckets?: number,
): Float32Array {
  const outputDuration = remappedClipDuration(clip);
  const bucketCount = Math.max(2, outputBuckets ?? sourcePeaks.length);
  const remapped = new Float32Array(bucketCount);

  if (sourcePeaks.length === 0 || outputDuration <= 0) return remapped;

  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration;
  const sourceLen = Math.max(0.001, trimEnd - trimStart);
  const defaultRate = getClipPlaybackRate(clip);
  const keyframes = clip.automation?.playbackRate;

  const sampleSourcePeak = (sourceOffset: number): number => {
    const u = Math.min(1, Math.max(0, sourceOffset / sourceLen));
    const idx = u * (sourcePeaks.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(sourcePeaks.length - 1, lo + 1);
    const frac = idx - lo;
    return sourcePeaks[lo] * (1 - frac) + sourcePeaks[hi] * frac;
  };

  for (let i = 0; i < bucketCount; i++) {
    const t0 = (outputDuration * i) / bucketCount;
    const t1 = (outputDuration * (i + 1)) / bucketCount;
    const src0 = integrateRateToSourceOffset(keyframes, defaultRate, t0);
    const src1 = integrateRateToSourceOffset(keyframes, defaultRate, t1);

    const samples = Math.max(1, Math.ceil((src1 - src0) * 8));
    let max = 0;
    for (let s = 0; s < samples; s++) {
      const u = samples === 1 ? 0.5 : s / (samples - 1);
      const srcOffset = src0 + (src1 - src0) * u;
      max = Math.max(max, sampleSourcePeak(srcOffset));
    }
    remapped[i] = max;
  }

  return remapped;
}
