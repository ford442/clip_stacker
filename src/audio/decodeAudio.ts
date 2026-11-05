/**
 * The one way the app decodes audio: `OfflineAudioContext.decodeAudioData`
 * at a fixed rate (48 kHz unless asked otherwise).
 *
 * `decodeAudioData` resamples to its context's rate, so decoding on the
 * real-time context made every result depend on the output device (44.1 kHz
 * on one machine, 48 kHz on the next): beat timestamps, waveform peaks and
 * export PCM drifted with it. An offline context never touches the output
 * device and never needs a user gesture.
 *
 * Callers: clip playback / export buffers (`ClipAudioCache`), waveform peaks,
 * beat analysis, and Whisper transcription.
 */

/** The export premix rate (48 kHz AAC); every decode defaults to it. */
export const DECODE_SAMPLE_RATE = 48_000;

export interface DecodeAudioOptions {
  /** Output rate of the decoded buffer (default 48 kHz). */
  sampleRate?: number;
  signal?: AbortSignal;
}

export type DecodeSource = Blob | ArrayBuffer | string;

type OfflineCtor = typeof OfflineAudioContext;

function offlineCtor(): OfflineCtor | undefined {
  if (typeof OfflineAudioContext !== 'undefined') return OfflineAudioContext;
  return (globalThis as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
}

/** One decode context per rate: `decodeAudioData` never renders, so it can be reused. */
const decoders = new Map<number, OfflineAudioContext>();

function decoderFor(sampleRate: number): OfflineAudioContext {
  const existing = decoders.get(sampleRate);
  if (existing) return existing;
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error('This browser cannot decode audio (no OfflineAudioContext).');
  const ctx = new Ctor(1, 1, sampleRate);
  decoders.set(sampleRate, ctx);
  return ctx;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

async function bytesOf(source: DecodeSource, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return source;
  if (typeof source === 'string') {
    const response = await fetch(source, signal ? { signal } : undefined);
    return response.arrayBuffer();
  }
  return source.arrayBuffer();
}

/**
 * Decode `source` (a Blob / File, its bytes, or an object / http URL) into an
 * `AudioBuffer` at `options.sampleRate` (48 kHz). Rejects like
 * `decodeAudioData` for media without a decodable audio track, and with an
 * `AbortError` when `signal` fires.
 */
export async function decodeAudio(source: DecodeSource, options: DecodeAudioOptions = {}): Promise<AudioBuffer> {
  const { signal } = options;
  const sampleRate = options.sampleRate ?? DECODE_SAMPLE_RATE;
  if (signal?.aborted) throw abortError();
  const bytes = await bytesOf(source, signal);
  if (signal?.aborted) throw abortError();
  // decodeAudioData detaches its input; pass a copy when the caller keeps the bytes.
  const input = source instanceof ArrayBuffer ? bytes.slice(0) : bytes;
  const buffer = await decoderFor(sampleRate).decodeAudioData(input);
  if (signal?.aborted) throw abortError();
  return buffer;
}

/** Test-only: forget the cached decode contexts. */
export function __resetDecodeAudioForTests(): void {
  decoders.clear();
}
