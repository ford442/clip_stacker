/**
 * Fast silent AAC for FFmpeg paths that previously used anullsrc + full AAC encode.
 *
 * Bake a short silent AAC unit once (WebCodecs preferred; one-shot FFmpeg fallback),
 * then mux with `-stream_loop -1` + `-c:a copy` so silence cost is ~remux, not encode.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import type { StatusCallback } from './ffmpegCommon';
import {
  AAC_BITRATE,
  AAC_CHANNELS,
  AAC_CODEC,
  AAC_FRAME_SAMPLES,
  extractPlanarFrame,
  isAudioEncoderAvailable,
} from '../utils/webcodecs-audio';

/** Virtual filename written into the FFmpeg VFS. */
export const SILENT_AAC_UNIT_NAME = 'silent_unit.m4a';

/** Match intermediate AAC layout used across FFmpeg pass-1 / lossless paths. */
export const SILENT_AAC_SAMPLE_RATE = 44_100;
export const SILENT_AAC_CHANNELS = 2;
export const SILENT_AAC_UNIT_SEC = 1;

let cachedUnitBytes: Uint8Array | null = null;
let unitGenPromise: Promise<Uint8Array> | null = null;

/** Reset module cache (tests only). */
export function resetSilentAacUnitCacheForTesting(): void {
  cachedUnitBytes = null;
  unitGenPromise = null;
}

/** Second-input args: infinite loop of the pre-encoded silent unit (cut with `-t`). */
export function buildSilentAacLoopInputArgs(
  unitName: string = SILENT_AAC_UNIT_NAME,
): string[] {
  return ['-stream_loop', '-1', '-i', unitName];
}

/**
 * Create a silent stereo AudioBuffer (zeros). Prefer the AudioBuffer constructor;
 * fall back to OfflineAudioContext when needed (older runtimes / test envs).
 */
export function createSilentAudioBuffer(
  durationSec: number,
  sampleRate: number = SILENT_AAC_SAMPLE_RATE,
  channels: number = SILENT_AAC_CHANNELS,
): AudioBuffer {
  const length = Math.max(1, Math.ceil(Math.max(0.001, durationSec) * sampleRate));
  if (typeof AudioBuffer !== 'undefined') {
    try {
      return new AudioBuffer({
        length,
        numberOfChannels: channels,
        sampleRate,
      });
    } catch {
      /* fall through */
    }
  }
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('Cannot create silent AudioBuffer in this environment');
  }
  const ctx = new OfflineAudioContext(channels, length, sampleRate);
  return ctx.createBuffer(channels, length, sampleRate);
}

/**
 * Encode a short silent m4a via WebCodecs + mp4-muxer.
 * Returns null when AudioEncoder is unavailable or encoding fails.
 */
export async function encodeSilentAacUnitViaWebCodecs(
  durationSec: number = SILENT_AAC_UNIT_SEC,
): Promise<Uint8Array | null> {
  if (!(await isAudioEncoderAvailable())) return null;
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return null;
  }

  try {
    const supported = await AudioEncoder.isConfigSupported({
      codec: AAC_CODEC,
      sampleRate: SILENT_AAC_SAMPLE_RATE,
      numberOfChannels: SILENT_AAC_CHANNELS,
      bitrate: AAC_BITRATE,
    });
    if (!supported.supported) return null;
  } catch {
    return null;
  }

  const buffer = createSilentAudioBuffer(durationSec, SILENT_AAC_SAMPLE_RATE);
  type ChunkEntry = {
    chunk: EncodedAudioChunk;
    meta?: EncodedAudioChunkMetadata;
  };
  const entries: ChunkEntry[] = [];
  let encodeError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      entries.push({ chunk, meta });
    },
    error: (e) => {
      encodeError = e;
    },
  });

  encoder.configure({
    codec: AAC_CODEC,
    sampleRate: SILENT_AAC_SAMPLE_RATE,
    numberOfChannels: SILENT_AAC_CHANNELS,
    bitrate: AAC_BITRATE,
  });

  let timestampUs = 0;
  for (let offset = 0; offset < buffer.length; offset += AAC_FRAME_SAMPLES) {
    const { data, frames } = extractPlanarFrame(buffer, offset, AAC_FRAME_SAMPLES);
    if (frames <= 0) break;

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: buffer.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: Math.min(buffer.numberOfChannels, AAC_CHANNELS),
      timestamp: timestampUs,
      data: data as BufferSource,
    });

    encoder.encode(audioData);
    audioData.close();
    if (encodeError) {
      encoder.close();
      return null;
    }
    timestampUs += Math.round((frames / buffer.sampleRate) * 1_000_000);
  }

  await encoder.flush();
  encoder.close();
  if (encodeError || entries.length === 0) return null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: {
      codec: 'aac',
      sampleRate: SILENT_AAC_SAMPLE_RATE,
      numberOfChannels: SILENT_AAC_CHANNELS,
    },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  for (const { chunk, meta } of entries) {
    muxer.addAudioChunk(chunk, meta);
  }
  muxer.finalize();

  const bytes = new Uint8Array(muxer.target.buffer);
  return bytes.byteLength > 0 ? bytes : null;
}

async function generateSilentAacUnitViaFfmpeg(
  ffmpeg: IFfmpegRuntime,
  onStatus?: StatusCallback,
): Promise<Uint8Array> {
  onStatus?.('Preparing silent audio unit (one-time AAC encode)…');
  const tmpName = SILENT_AAC_UNIT_NAME;
  try {
    await ffmpeg.deleteFile(tmpName);
  } catch {
    /* ignore */
  }

  // One short encode only — later clips stream-copy a loop of this unit.
  await ffmpeg.exec([
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=${SILENT_AAC_SAMPLE_RATE}:cl=stereo`,
    '-t',
    String(SILENT_AAC_UNIT_SEC),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    String(SILENT_AAC_SAMPLE_RATE),
    '-ac',
    '2',
    tmpName,
  ]);

  const data = (await ffmpeg.readFile(tmpName)) as Uint8Array;
  return new Uint8Array(data);
}

/**
 * Resolve silent unit bytes (session-cached). Prefers WebCodecs; falls back to
 * a single short FFmpeg anullsrc encode.
 */
export async function getSilentAacUnitBytes(
  ffmpeg: IFfmpegRuntime,
  onStatus?: StatusCallback,
): Promise<Uint8Array> {
  if (cachedUnitBytes) return cachedUnitBytes;

  if (!unitGenPromise) {
    unitGenPromise = (async () => {
      try {
        const viaWc = await encodeSilentAacUnitViaWebCodecs(SILENT_AAC_UNIT_SEC);
        if (viaWc && viaWc.byteLength > 0) {
          cachedUnitBytes = viaWc;
          return viaWc;
        }
        const viaFfmpeg = await generateSilentAacUnitViaFfmpeg(ffmpeg, onStatus);
        cachedUnitBytes = viaFfmpeg;
        return viaFfmpeg;
      } catch (err) {
        unitGenPromise = null;
        throw err;
      }
    })();
  }

  return unitGenPromise;
}

/**
 * Ensure the silent AAC unit exists in the FFmpeg virtual filesystem.
 * Safe to call repeatedly (rewrites from cache if VFS was cleared).
 */
export async function ensureSilentAacUnit(
  ffmpeg: IFfmpegRuntime,
  onStatus?: StatusCallback,
): Promise<string> {
  const bytes = await getSilentAacUnitBytes(ffmpeg, onStatus);
  await ffmpeg.writeFile(SILENT_AAC_UNIT_NAME, bytes as any);
  return SILENT_AAC_UNIT_NAME;
}
