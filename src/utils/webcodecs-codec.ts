/**
 * WebCodecs encoder codec selection, bitrate mapping, and availability probes.
 */

import type { ExportSettings } from '../types';
import { parseOutputResolution } from './resolution';
import { TIMELINE_EXPORT_FPS } from './webcodecs-timeline';
import {
  ColorPipelineExportError,
  colorSpaceForOutput,
  displayP3UnavailableReason,
  hdr10UnavailableReason,
  type OutputColor,
  type OutputVideoColorSpace,
} from './colorManagement';

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
  /** `Mp4Writer` video track codec id. */
  muxerCodec: 'avc' | 'hevc' | 'av1';
  /**
   * The acceleration hint the probe accepted (see
   * {@link ENCODER_ACCELERATION_LADDER}). Unset on a bare candidate, which
   * builds a `prefer-hardware` config.
   */
  hardwareAcceleration?: HardwareAcceleration;
}

/**
 * Acceleration hints tried in order for encode. Chrome treats
 * `prefer-hardware` as *require hardware*, so on machines without a hardware
 * encoder (common on Linux and in VMs) only `no-preference` configures.
 */
export const ENCODER_ACCELERATION_LADDER: readonly HardwareAcceleration[] = Object.freeze([
  'prefer-hardware',
  'no-preference',
]);

/**
 * Acceleration hints tried in order for decode. `prefer-software` is the last
 * rung because some drivers advertise a hardware decoder that then rejects
 * the stream's profile; a software decode is still far better than dropping
 * the layer back to `<video>` seeks.
 */
export const DECODER_ACCELERATION_LADDER: readonly HardwareAcceleration[] = Object.freeze([
  'prefer-hardware',
  'no-preference',
  'prefer-software',
]);

/**
 * TS's bundled `lib.dom.d.ts` hasn't caught up to the WebCodecs spec's
 * `VideoEncoderConfig.colorSpace` (output color tagging) — declared here so
 * we can set it without an `any` escape hatch. Real browsers already accept
 * this field.
 */
export interface VideoEncoderConfigWithColorSpace extends VideoEncoderConfig {
  colorSpace?: OutputVideoColorSpace;
}

/** Export favors quality/size over encode latency (VBR); live capture would want CBR instead. */
export const EXPORT_BITRATE_MODE: VideoEncoderBitrateMode = 'variable';

/**
 * The finishing pass chain and preview shaders operate in Rec.709 — tag
 * encoded output the same way so players don't apply a different (commonly
 * BT.601) matrix than what was actually rendered.
 */
export const REC709_COLOR_SPACE: Readonly<VideoColorSpaceInit> = Object.freeze({
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
});

type H264Profile = 'high' | 'main' | 'baseline';

/** profile_idc byte, high to low compression efficiency for a given bitrate. */
const H264_PROFILE_IDC: Record<H264Profile, string> = {
  high: '64',
  main: '4d',
  baseline: '42',
};

/** HEVC Main 10, level 4.1 (≤ 1080p) — HDR10 candidate. Not an 8-bit Main fallback. */
export const HEVC_MAIN10_CODEC = 'hvc1.2.4.L123.B0';

/** AV1 Main, 10-bit, level 4.0 (≤ 1080p). HDR10 candidate. The 8-bit string is `av01.0.08M.08`. */
export const AV1_10BIT_CODEC = 'av01.0.08M.10';

/** Luma picture size (MaxLumaPs) limits shared by the HEVC and AV1 level tables. */
const LUMA_PS_1080P = 2_228_224;
const LUMA_PS_2160P = 8_912_896;

/**
 * HEVC codec string with a level adequate for the target picture size and
 * frame rate (Main tier). Level 4.1 (`L123`) up to 1080p, 5.0 / 5.1
 * (`L150` / `L153`) for 2160p at ≤ 30 / > 30 fps, 6.0 / 6.1 beyond.
 * A fixed 4.1 makes strict encoders reject a 4K configure — and HDR10 has no
 * H.264 fallback, so that used to fail the whole export.
 */
export function hevcCodecString(
  width: number,
  height: number,
  profile: 'main' | 'main10' = 'main',
  fps: number = TIMELINE_EXPORT_FPS,
): string {
  const lumaPs = width * height;
  const fast = fps > 30;
  const level =
    lumaPs <= LUMA_PS_1080P ? 123
    : lumaPs <= LUMA_PS_2160P ? (fast ? 153 : 150)
    : fast ? 183 : 180;
  const head = profile === 'main10' ? 'hvc1.2.4' : 'hvc1.1.6';
  return `${head}.L${level}.B0`;
}

/**
 * AV1 codec string (Main profile) with a `seq_level_idx` adequate for the
 * target picture size and frame rate: 4.0 / 4.1 (`08` / `09`) up to 1080p,
 * 5.0 / 5.1 (`12` / `13`) for 2160p, 6.0 / 6.1 (`16` / `17`) beyond.
 */
export function av1CodecString(
  width: number,
  height: number,
  bitDepth: 8 | 10 = 8,
  fps: number = TIMELINE_EXPORT_FPS,
): string {
  const lumaPs = width * height;
  const fast = fps > 30;
  const level =
    lumaPs <= LUMA_PS_1080P ? (fast ? 9 : 8)
    : lumaPs <= LUMA_PS_2160P ? (fast ? 13 : 12)
    : fast ? 17 : 16;
  return `av01.0.${String(level).padStart(2, '0')}M.${bitDepth === 10 ? '10' : '08'}`;
}

/**
 * H.264 codec string with a level adequate for the target resolution.
 * Defaults to Constrained Baseline (`42`) for callers that don't care about
 * profile; export instead probes High → Main → Baseline via
 * {@link codecCandidates} since hardware encoders inside MP4 + Chrome
 * virtually always support Main/High, and Baseline costs compression
 * efficiency for no compatibility win there.
 */
export function h264CodecString(
  width: number,
  height: number,
  profile: H264Profile = 'baseline',
): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = macroblocks > 8192 ? '0033' : macroblocks > 3600 ? '0028' : '001e';
  return `avc1.${H264_PROFILE_IDC[profile]}${level}`;
}

/** Ordered candidate list for the requested codec; H.264 is always the last resort. */
export function codecCandidates(
  preference: ExportVideoCodec | undefined,
  width: number,
  height: number,
  outputColor: OutputColor = 'rec709-sdr',
  fps: number = TIMELINE_EXPORT_FPS,
): ResolvedEncoderCodec[] {
  if (outputColor === 'hdr10') {
    return [
      { codec: hevcCodecString(width, height, 'main10', fps), muxerCodec: 'hevc' },
      { codec: av1CodecString(width, height, 10, fps), muxerCodec: 'av1' },
    ];
  }
  const h264: ResolvedEncoderCodec[] = (['high', 'main', 'baseline'] as const).map((profile) => ({
    codec: h264CodecString(width, height, profile),
    muxerCodec: 'avc' as const,
  }));
  const hevc: ResolvedEncoderCodec = {
    codec: hevcCodecString(width, height, 'main', fps),
    muxerCodec: 'hevc',
  };
  const av1: ResolvedEncoderCodec = { codec: av1CodecString(width, height, 8, fps), muxerCodec: 'av1' };
  switch (preference) {
    case 'hevc':
      return [hevc, ...h264];
    case 'av1':
      return [av1, ...h264];
    default:
      return h264;
  }
}

/**
 * Build the exact `VideoEncoderConfig` used for both `isConfigSupported`
 * probing and the real `configure()` call, so a config the probe accepted
 * can never be rejected by the real call (they're the same object shape).
 */
export function buildVideoEncoderConfig(
  candidate: ResolvedEncoderCodec,
  width: number,
  height: number,
  bitrate: number,
  framerate: number = TARGET_FPS,
  outputColor: OutputColor = 'rec709-sdr',
): VideoEncoderConfigWithColorSpace {
  return {
    codec: candidate.codec,
    width,
    height,
    bitrate,
    bitrateMode: EXPORT_BITRATE_MODE,
    framerate,
    hardwareAcceleration: candidate.hardwareAcceleration ?? 'prefer-hardware',
    latencyMode: VIDEO_ENCODER_LATENCY_MODE,
    colorSpace: colorSpaceForOutput(outputColor),
    // MP4 stores length-prefixed (avc) samples, not Annex B.
    ...(candidate.muxerCodec === 'avc' ? { avc: { format: 'avc' } } : {}),
  };
}

let lastResolvedCodec: ResolvedEncoderCodec | null = null;
let lastEncoderColorSpace: OutputVideoColorSpace | null = null;

/** The codec `resolveEncoderCodec` last resolved to — surfaced in Copy Debug. */
export function getLastResolvedEncoderCodec(): ResolvedEncoderCodec | null {
  return lastResolvedCodec;
}

/** Color tags from the last successful `resolveEncoderCodec` / probe. */
export function getLastEncoderColorSpace(): OutputVideoColorSpace | null {
  return lastEncoderColorSpace;
}

export function __setLastResolvedEncoderCodecForTests(codec: ResolvedEncoderCodec | null): void {
  lastResolvedCodec = codec;
}

/**
 * Probe VideoEncoder.isConfigSupported for the requested codec, preferring
 * High → Main → Baseline H.264 profiles (falling back further to HEVC/AV1's
 * own H.264 fallback when neither is available in this browser), first with
 * hardware acceleration and then without (see {@link ENCODER_ACCELERATION_LADDER}).
 * Codec order wins within one rung, acceleration across rungs, so a hardware
 * H.264 encode is chosen over a software HEVC one. `bitrate` must match what
 * the real `configure()` call will use — an unmatched probe can report a
 * config supported that the real encoder then rejects.
 */
async function firstSupportedCandidate(
  preference: ExportVideoCodec | undefined,
  width: number,
  height: number,
  bitrate: number,
  outputColor: OutputColor,
): Promise<ResolvedEncoderCodec | null> {
  const candidates = codecCandidates(preference, width, height, outputColor);
  for (const hardwareAcceleration of ENCODER_ACCELERATION_LADDER) {
    for (const base of candidates) {
      const candidate = { ...base, hardwareAcceleration };
      try {
        const config = buildVideoEncoderConfig(candidate, width, height, bitrate, TARGET_FPS, outputColor);
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported === true) return candidate;
      } catch {
        // Unparseable codec string on this browser — try the next candidate.
      }
    }
  }
  return null;
}

/** No probed encoder config was accepted — the caller falls back to FFmpeg. */
export class NoSupportedEncoderError extends Error {
  constructor(width: number, height: number) {
    super(`No WebCodecs video encoder accepts a ${width}x${height} export on this machine`);
    this.name = 'NoSupportedEncoderError';
  }
}

/**
 * Resolve the codec + acceleration the export will configure. Only ever
 * returns a config `isConfigSupported` accepted: an unprobed guess would only
 * fail later, asynchronously, inside `configure()`.
 */
export async function resolveEncoderCodec(
  preference: ExportVideoCodec | undefined,
  width: number,
  height: number,
  bitrate: number,
  outputColor: OutputColor = 'rec709-sdr',
): Promise<ResolvedEncoderCodec> {
  const supported = await firstSupportedCandidate(preference, width, height, bitrate, outputColor);
  if (supported) {
    lastResolvedCodec = supported;
    lastEncoderColorSpace = colorSpaceForOutput(outputColor);
    return supported;
  }
  if (outputColor === 'hdr10') {
    throw new ColorPipelineExportError(hdr10UnavailableReason());
  }
  if (outputColor === 'display-p3') {
    throw new ColorPipelineExportError(displayP3UnavailableReason());
  }
  throw new NoSupportedEncoderError(width, height);
}

/**
 * Whether this browser can encode `output` with tags that match the picture.
 * Does not record the result as the last export codec.
 */
export async function probeOutputColorSupport(
  output: OutputColor,
  width: number,
  height: number,
  bitrate: number,
  preference?: ExportVideoCodec,
): Promise<{ supported: boolean; reason: string }> {
  if (output === 'rec709-sdr') return { supported: true, reason: '' };
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') {
    return { supported: false, reason: 'VideoEncoder is not available in this browser.' };
  }
  const supported = await firstSupportedCandidate(preference, width, height, bitrate, output);
  if (supported) return { supported: true, reason: '' };
  return {
    supported: false,
    reason: output === 'hdr10' ? hdr10UnavailableReason() : displayP3UnavailableReason(),
  };
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
  return (await probeH264EncoderAcceleration(width, height)) !== null;
}

/**
 * First rung of {@link ENCODER_ACCELERATION_LADDER} at which a Constrained
 * Baseline H.264 encoder configures at this size, or null when none does.
 */
export async function probeH264EncoderAcceleration(
  width: number,
  height: number,
): Promise<HardwareAcceleration | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const hardwareAcceleration of ENCODER_ACCELERATION_LADDER) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: h264CodecString(width, height),
        width,
        height,
        hardwareAcceleration,
      });
      if (support.supported === true) return hardwareAcceleration;
    } catch {
      // Try the next rung.
    }
  }
  return null;
}
