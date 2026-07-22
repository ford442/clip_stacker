/**
 * Decode the audio track of an audio or video file into an AudioBuffer.
 * Works for both audio and video containers via `decodeAudioData`.
 */
export async function decodeAudioBuffer(
  objectUrl: string,
  audioCtx: BaseAudioContext,
): Promise<AudioBuffer> {
  const response = await fetch(objectUrl);
  const arrayBuffer = await response.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}

/**
 * Extract normalized peak samples from the audio track of an audio or video file.
 * Uses the Web Audio API to decode the audio data client-side.
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

  const audioCtx = new AudioContext();
  try {
    const audioBuffer = await decodeAudioBuffer(objectUrl, audioCtx);
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
  } finally {
    // Always close the AudioContext to free resources
    audioCtx.close();
  }
}
