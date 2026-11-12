import { decodeAudio } from '../audio/decodeAudio';
import type { Clip } from '../types';

/**
 * False for media with no audio track to decode: stills, and files probed as
 * silent. `decodeAudioData` rejects those with "Unable to decode audio data",
 * so callers skip extraction instead of triggering (and logging) the failure.
 * Unknown (`hasAudio` omitted) counts as having audio. A sequence clip has
 * no file of its own (its audio is its sequence's clips).
 */
export function clipHasExtractableAudio(clip: Pick<Clip, 'hasAudio' | 'stillImage' | 'source'>): boolean {
  return !clip.stillImage && clip.hasAudio !== false && clip.source?.type !== 'sequence';
}

/**
 * Decode the audio track of an audio or video file into an AudioBuffer at
 * 48 kHz (`decodeAudio`: an OfflineAudioContext, so the result never depends
 * on the output device).
 */
export function decodeAudioBuffer(objectUrl: string, signal?: AbortSignal): Promise<AudioBuffer> {
  return decodeAudio(objectUrl, signal ? { signal } : {});
}

/**
 * Extract normalized peak samples from the audio track of an audio or video file.
 * Decodes with `decodeAudio` (no real-time AudioContext per extraction).
 *
 * @param objectUrl  Object URL pointing to the media file.
 * @param numSamples Number of peak buckets to return (default 120).
 * @returns          Float32Array of values in [0, 1].
 */
export interface ExtractWaveformPeaksOptions {
  signal?: AbortSignal;
}

export async function extractWaveformPeaks(
  objectUrl: string,
  numSamples = 120,
  options: ExtractWaveformPeaksOptions = {},
): Promise<Float32Array> {
  const { signal } = options;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const audioBuffer = await decodeAudioBuffer(objectUrl, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Mix all channels down to a mono peak array
  const numChannels = audioBuffer.numberOfChannels;
  const totalSamples = audioBuffer.length;
  const blockSize = Math.max(1, Math.floor(totalSamples / numSamples));
  const peaks = new Float32Array(numSamples);

  // Gather per-channel data once
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  for (let i = 0; i < numSamples; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, totalSamples);
    let max = 0;
    for (let j = start; j < end; j++) {
      for (let c = 0; c < numChannels; c++) {
        const abs = Math.abs(channels[c][j]);
        if (abs > max) max = abs;
      }
    }
    peaks[i] = max;
  }

  return peaks;
}
