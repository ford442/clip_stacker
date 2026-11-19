/**
 * Stem (output tap) checks shared by the tap tests: collect a tapped mix
 * stream whole, and measure how far the master is from the float sum of its
 * taps, in units in the last place.
 */
import type { MixMeterReading, TapMeterReading, TimelineMixChunk } from './mediaEngine';

/** What both `TimelineMixStream` and the worker's `MixStream` offer. */
export interface TappedStream extends AsyncIterable<TimelineMixChunk> {
  readonly totalFrames: number;
  readonly channels: number;
  readMeters(): MixMeterReading | null;
  readTapMeters(): TapMeterReading[] | null;
  close(): void;
}

export interface TappedMix {
  /** The master, interleaved. */
  out: Float32Array;
  /** One interleaved signal per tap, in tap order. */
  taps: Float32Array[];
  meters: MixMeterReading | null;
  tapMeters: TapMeterReading[] | null;
}

/** Every chunk of `stream`, taps included, then its meters; closes the stream. */
export async function collectTapped(stream: TappedStream): Promise<TappedMix> {
  const floats = stream.totalFrames * stream.channels;
  const out = new Float32Array(floats);
  const taps: Float32Array[] = [];
  try {
    for await (const chunk of stream) {
      const at = chunk.startFrame * stream.channels;
      out.set(chunk.frames, at);
      chunk.taps?.forEach((tap, t) => {
        let whole = taps[t];
        if (!whole) {
          whole = new Float32Array(floats);
          taps[t] = whole;
        }
        whole.set(tap, at);
      });
    }
    return { out, taps, meters: stream.readMeters(), tapMeters: stream.readTapMeters() };
  } finally {
    stream.close();
  }
}

const scratch = new Float32Array(1);
const scratchBits = new Int32Array(scratch.buffer);

/** A float's bits as an integer that orders like the float (+0 and -0 both 0). */
function orderedBits(value: number): number {
  scratch[0] = value;
  const bits = scratchBits[0] ?? 0;
  return bits < 0 ? -(bits & 0x7fffffff) : bits;
}

/**
 * Largest ulp distance between `master` and the f32 sum of `taps` (summed in
 * tap order, as the engine sums its lanes).
 */
export function worstSumUlps(master: Float32Array, taps: Float32Array[]): number {
  let worst = 0;
  for (let i = 0; i < master.length; i++) {
    let sum = 0;
    for (const tap of taps) sum = Math.fround(sum + (tap[i] ?? 0));
    worst = Math.max(worst, Math.abs(orderedBits(sum) - orderedBits(master[i] ?? 0)));
  }
  return worst;
}

/** Bit-for-bit equality of two sample buffers. */
export function sameBits(a: Float32Array, b: Float32Array): boolean {
  const bytes = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  return a.length === b.length && bytes(a).equals(bytes(b));
}
