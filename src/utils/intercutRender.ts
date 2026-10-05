/**
 * Frame-grid render plan for the intercut generator.
 *
 * The concat demuxer's `inpoint`/`outpoint` is packet-granular: every cut
 * drags in the GOP before the inpoint and the AAC frames around it, so the
 * picture runs long and `+genpts` stacks the extra audio packets onto the same
 * timestamp. Instead, every slice is snapped to a 30 fps output grid and both
 * picture and sound are cut from that one grid:
 *
 * - video: one filter pass per source (`fps` → `select` → `setpts`) places each
 *   slice's frames on its output frames, then `interleave` merges the sources;
 * - audio: each source is decoded once to PCM and spliced in JS at
 *   `frame × INTERCUT_SAMPLES_PER_FRAME`, so a cut in the sound lands on the
 *   exact sample where the picture cuts.
 */

import type { IntercutSlice, IntercutSlot } from './intercut';

export const INTERCUT_OUTPUT_FPS = 30;
export const INTERCUT_AUDIO_SAMPLE_RATE = 44100;
export const INTERCUT_AUDIO_CHANNELS = 2;
/** 44100 / 30 — whole samples per output frame, so cuts never fall mid-sample. */
export const INTERCUT_SAMPLES_PER_FRAME =
  INTERCUT_AUDIO_SAMPLE_RATE / INTERCUT_OUTPUT_FPS;
/** Equal-power crossfade at each cut; long enough to kill the click, short enough to stay a hard cut. */
export const INTERCUT_AUDIO_CROSSFADE_SEC = 0.005;

/** A slice snapped to the output frame grid. */
export interface IntercutFrameSlice {
  slot: IntercutSlot;
  /** First source frame, counted from the source's trim origin at `INTERCUT_OUTPUT_FPS`. */
  sourceFrame: number;
  /** First output frame. */
  outputFrame: number;
  frameCount: number;
}

export interface IntercutFramePlan {
  slices: IntercutFrameSlice[];
  totalFrames: number;
}

/**
 * Snap slices (inpoints relative to each source's trim origin) to the output
 * frame grid. Output boundaries come from the cumulative planned time, so
 * rounding never accumulates into drift. Slices that round to zero frames are
 * dropped (a strobe faster than the frame rate cannot be shown anyway).
 *
 * A source's slices never overlap: with `freezeHidden`, rounding could make
 * one slice end a frame after the next one of the same source starts, and the
 * shared frame would then belong to two output positions.
 */
export function quantizeIntercutSlices(
  slices: IntercutSlice[],
  fps = INTERCUT_OUTPUT_FPS,
): IntercutFramePlan {
  const out: IntercutFrameSlice[] = [];
  const nextFree: Partial<Record<IntercutSlot, number>> = {};
  let elapsed = 0;
  let totalFrames = 0;
  for (const slice of slices) {
    const duration = Math.max(0, slice.outpoint - slice.inpoint);
    const startFrame = Math.round(elapsed * fps);
    elapsed += duration;
    const endFrame = Math.round(elapsed * fps);
    const frameCount = endFrame - startFrame;
    if (frameCount <= 0) continue;
    const sourceFrame = Math.max(
      Math.max(0, Math.round(slice.inpoint * fps)),
      nextFree[slice.slot] ?? 0,
    );
    out.push({ slot: slice.slot, sourceFrame, outputFrame: startFrame, frameCount });
    nextFree[slice.slot] = sourceFrame + frameCount;
    totalFrames = endFrame;
  }
  return { slices: out, totalFrames };
}

export interface IntercutVideoInput {
  slot: IntercutSlot;
  /** FFmpeg input index. */
  inputIndex: number;
}

/**
 * `filter_complex` graph that cuts every source onto the output grid.
 *
 * After `fps`, a source's pts are its frame numbers from the trim origin
 * (time base 1/fps), so `select` and `setpts` work in whole frames and the
 * output pts is the output frame number. Selecting before `scale` keeps
 * hidden frames from being scaled at all.
 */
/**
 * One source's soundtrack from its trim origin, silence-padded to the output.
 * Used by the steady-streams policy: the bed does not cut or freeze with picture.
 */
export function steadyStreamPcm(
  source: Int16Array | undefined,
  totalFrames: number,
  samplesPerFrame = INTERCUT_SAMPLES_PER_FRAME,
): Int16Array {
  const out = new Int16Array(Math.max(0, totalFrames) * samplesPerFrame * 2);
  if (!source || out.length === 0) return out;
  out.set(source.subarray(0, out.length));
  return out;
}

/**
 * Equal-power sum of steady beds (gain 1/sqrt(n)) so the library player, which
 * only plays the default track, still hears every source. Clipped to int16.
 */
export function mixSteadyStreams(streams: Int16Array[]): Int16Array {
  if (streams.length === 0) return new Int16Array(0);
  const len = streams[0]!.length;
  const out = new Int16Array(len);
  const gain = 1 / Math.sqrt(streams.length);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const stream of streams) sum += (stream[i] ?? 0) * gain;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sum)));
  }
  return out;
}

export function buildIntercutVideoFilterGraph(
  plan: IntercutFramePlan,
  inputs: IntercutVideoInput[],
  width: number,
  height: number,
  fps = INTERCUT_OUTPUT_FPS,
): string {
  const branches: string[] = [];
  const labels: string[] = [];
  for (const input of inputs) {
    const own = plan.slices.filter((s) => s.slot === input.slot);
    if (own.length === 0) continue;
    const select = own
      .map((s) => `between(pts,${s.sourceFrame},${s.sourceFrame + s.frameCount - 1})`)
      .join('+');
    const setpts = own
      .map(
        (s) =>
          `between(PTS,${s.sourceFrame},${s.sourceFrame + s.frameCount - 1})*(PTS+${s.outputFrame - s.sourceFrame})`,
      )
      .join('+');
    const label = `[v${input.slot}]`;
    branches.push(
      `[${input.inputIndex}:v]fps=${fps},select='${select}',setpts='${setpts}',` +
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${label}`,
    );
    labels.push(label);
  }
  if (labels.length === 0) {
    throw new Error('Intercut render plan has no frames.');
  }
  if (labels.length === 1) {
    branches[0] = branches[0]!.replace(/\[v[ABC]\]$/, '[vout]');
  } else {
    branches.push(`${labels.join('')}interleave=nb_inputs=${labels.length}[vout]`);
  }
  return branches.join(';');
}

export interface Pcm16 {
  sampleRate: number;
  channels: number;
  /** Interleaved samples. */
  samples: Int16Array;
}

/** Read a 16-bit PCM WAV (as FFmpeg's `pcm_s16le` muxer writes it). */
export function parseWavPcm16(bytes: Uint8Array): Pcm16 {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Intercut audio: not a RIFF/WAVE file.');
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; code: number } | null =
    null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('Intercut audio: WAV data before fmt chunk.');
      // 1 = PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE (FFmpeg writes it for some layouts).
      if ((format.code !== 1 && format.code !== 0xfffe) || format.bits !== 16) {
        throw new Error(`Intercut audio: expected 16-bit PCM WAV (format ${format.code}, ${format.bits}-bit).`);
      }
      // An unfinalized header can claim more than was written; trust the bytes.
      const available = Math.min(size, bytes.byteLength - body);
      const count = Math.floor(available / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { sampleRate: format.sampleRate, channels: format.channels, samples };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('Intercut audio: WAV has no data chunk.');
}

/** 16-bit PCM WAV bytes for interleaved samples. */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number, channels: number): Uint8Array {
  const dataSize = samples.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const writeTag = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) out[offset + i] = text.charCodeAt(i);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}

/** Up/down-mix interleaved PCM to stereo (FFmpeg is asked for stereo; this is a guard). */
export function toStereo(pcm: Pcm16): Int16Array {
  if (pcm.channels === 2) return pcm.samples;
  const frames = Math.floor(pcm.samples.length / Math.max(1, pcm.channels));
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const left = pcm.samples[i * pcm.channels]!;
    const right = pcm.channels > 1 ? pcm.samples[i * pcm.channels + 1]! : left;
    out[i * 2] = left;
    out[i * 2 + 1] = right;
  }
  return out;
}

export interface AssembleIntercutAudioOptions {
  /** Where each output frame's sound comes from (usually the video plan's slices). */
  slices: IntercutFrameSlice[];
  totalFrames: number;
  /** Interleaved stereo PCM per slot, starting at the source's trim origin. Missing = silence. */
  sources: Partial<Record<IntercutSlot, Int16Array>>;
  samplesPerFrame?: number;
  crossfadeSamples?: number;
}

/**
 * Splice stereo PCM exactly on the frame grid. Output length is always
 * `totalFrames × samplesPerFrame`, so the audio can never run long or short
 * of the picture. At a cut, the outgoing source keeps playing past its slice
 * for `crossfadeSamples` under an equal-power fade — the output stays the
 * same length, and the cut lands where the picture cuts.
 */
export function assembleIntercutAudio(options: AssembleIntercutAudioOptions): Int16Array {
  const spf = options.samplesPerFrame ?? INTERCUT_SAMPLES_PER_FRAME;
  const fadeLen = Math.max(
    0,
    Math.round(
      options.crossfadeSamples ?? INTERCUT_AUDIO_CROSSFADE_SEC * INTERCUT_AUDIO_SAMPLE_RATE,
    ),
  );
  const out = new Int16Array(options.totalFrames * spf * 2);
  const sampleAt = (slot: IntercutSlot, sample: number, channel: number): number => {
    const pcm = options.sources[slot];
    if (!pcm || sample < 0) return 0;
    const idx = sample * 2 + channel;
    return idx < pcm.length ? pcm[idx]! : 0;
  };

  let prev: { slot: IntercutSlot; sourceEnd: number } | null = null;
  for (const slice of options.slices) {
    const dst = slice.outputFrame * spf;
    const src = slice.sourceFrame * spf;
    const len = Math.min(slice.frameCount * spf, out.length / 2 - dst);
    if (len <= 0) continue;
    // A slice that simply continues the previous one is not a cut.
    const continues = prev !== null && prev.slot === slice.slot && prev.sourceEnd === src;
    const fade = prev && !continues ? Math.min(fadeLen, Math.floor(len / 2)) : 0;
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < 2; ch++) {
        let value = sampleAt(slice.slot, src + i, ch);
        if (i < fade && prev) {
          const x = (i + 0.5) / fade;
          value =
            value * Math.sin((Math.PI / 2) * x) +
            sampleAt(prev.slot, prev.sourceEnd + i, ch) * Math.cos((Math.PI / 2) * x);
        }
        out[(dst + i) * 2 + ch] = Math.max(-32768, Math.min(32767, Math.round(value)));
      }
    }
    prev = { slot: slice.slot, sourceEnd: src + len };
  }
  return out;
}
