/**
 * WebCodecs encoder codec selection, bitrate mapping, and availability probes.
 */

import type { ExportSettings } from '../types';
import { parseOutputResolution } from './resolution';
import { TIMELINE_EXPORT_FPS } from './webcodecs-timeline';

/** Frame rate used for sequential clip WebCodecs export (matches timeline export). */
export const TARGET_FPS = TIMELINE_EXPORT_FPS;

export const WEBCODECS_PROGRESS_START = 0.05;
export const WEBCODECS_PROGRESS_RANGE = 0.82;

/** Export uses quality-first hardware encode (not realtime, which can drop quality). */
export const VIDEO_ENCODER_LATENCY_MODE = 'quality' as const;

export type ExportVideoCodec = NonNullable<ExportSettings['videoCodec']>;

export interface ResolvedEncoderCodec {
  /** WebCodecs codec string passed to VideoEncoder.configure. */
  codec: string;
  /** mp4-muxer video track codec id. */
  muxerCodec: 'avc' | 'hevc' | 'av1';
}

/** H.264 baseline codec string with a level adequate for the target resolution. */
export function h264CodecString(width: number, height: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  if (macroblocks > 8192) return 'avc1.420033'; // level 5.1 — 4K
  if (macroblocks > 3600) return 'avc1.420028'; // level 4.0 — 1080p
  return 'avc1.42001e'; // level 3.0 — ≤720p
}

/** Ordered candidate list for the requested codec; H.264 is always the last resort. */
export function codecCandidates(
  preference: ExportVideoCodec | undefined,
  width: number,
  height: number,
): ResolvedEncoderCodec[] {
  const h264: ResolvedEncoderCodec = { codec: h264CodecString(width, height), muxerCodec: 'avc' };
  const hevc: ResolvedEncoderCodec = { codec: 'hvc1.1.6.L123.B0', muxerCodec: 'hevc' };
  const av1: ResolvedEncoderCodec = { codec: 'av01.0.08M.08', muxerCodec: 'av1' };
  switch (preference) {
    case 'hevc':
      return [hevc, h264];
    case 'av1':
      return [av1, h264];
    default:
      return [h264];
  }
}

/**
 * Probe VideoEncoder.isConfigSupported for the requested codec, falling back
 * to hardware H.264 when HEVC/AV1 encoding is not available in this browser.
 */
export async function resolveEncoderCodec(
  preference: ExportVideoCodec | undefined,
  width: number,
  height: number,
): Promise<ResolvedEncoderCodec> {
  const candidates = codecCandidates(preference, width, height);
  for (const candidate of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.codec,
        width,
        height,
        hardwareAcceleration: 'prefer-hardware',
      });
      if (support.supported === true) return candidate;
    } catch {
      // Unparseable codec string on this browser — try the next candidate.
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * Map H.264 CRF to an approximate bits-per-pixel for WebCodecs bitrate.
 * CRF 18 ≈ 0.1 bpp at 30 fps; halves every ~6 CRF (mirrors libx264 intuition).
 */
export function crfToBitsPerPixel(crf: number): number {
  const clamped = Math.max(0, Math.min(51, crf));
  return 0.1 * Math.pow(0.5, (clamped - 18) / 6);
}

/**
 * Resolve VideoEncoder bitrate from ExportSettings.
 * `videoBitrate > 0` wins; `0` means auto-derive from CRF × resolution × fps.
 */
export function resolveEncoderBitrate(
  settings: Pick<ExportSettings, 'videoBitrate' | 'crf'>,
  width: number,
  height: number,
  fps: number = TARGET_FPS,
): number {
  if (settings.videoBitrate > 0) return settings.videoBitrate;
  const bpp = crfToBitsPerPixel(settings.crf);
  const derived = Math.round(width * height * fps * bpp);
  // Keep encoder configs in a sane range for browser hardware encoders.
  return Math.max(500_000, Math.min(50_000_000, derived));
}

/** Progress stage labels for the decode → composite → encode hot path. */
export const WEBCODECS_PROGRESS_STAGES = {
  init: 'Initializing GPU encoder',
  decodeCompositeEncode: 'Decode → composite → encode',
  flush: 'Flushing hardware encoder',
  audio: 'WebCodecs audio encode',
  finalize: 'Finalizing GPU video',
} as const;

export function mapWebCodecsProgress(elapsedDuration: number, totalDuration: number): number | undefined {
  if (totalDuration <= 0) return undefined;
  return WEBCODECS_PROGRESS_START + (elapsedDuration / totalDuration) * WEBCODECS_PROGRESS_RANGE;
}

export async function isWebCodecsAvailable(
  width = parseOutputResolution().width,
  height = parseOutputResolution().height,
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return false;
  }
  try {
    const videoSupport = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001e',
      width,
      height,
      hardwareAcceleration: 'prefer-hardware',
    });
    return videoSupport.supported === true;
  } catch {
    return false;
  }
}

export function waitForEncoderDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const target = encoder as unknown as EventTarget;
    if (typeof target.addEventListener === 'function') {
      target.addEventListener('dequeue', () => resolve(), { once: true });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
