/** Quality settings forwarded to the FFmpeg (or WebCodecs) encode path. */
export type VideoOutputFormat = 'mp4' | 'prores';

export interface ExportSettings {
  /** H.264 CRF value (0–51; lower = higher quality). Default 18. */
  crf: number;
  /** libx264 preset. Default 'medium'. */
  preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
  /** Target video bitrate in bits/s for the WebCodecs path (0 = auto from CRF). */
  videoBitrate: number;
  /** Output filename (without extension; the selected output format supplies it). */
  filename: string;
  /** Container / video codec for the final rendered file. Omitted = MP4. */
  outputFormat?: VideoOutputFormat;
  /** ProRes profile (1 = LT, 2 = 422, 3 = 422 HQ). Omitted = 422 HQ. */
  proresProfile?: 1 | 2 | 3;
  /** Apply light hqdn3d + deband cleanup to the final export. */
  lightVideoCleanup?: boolean;
  /** Apply high-pass, light denoise and loudness normalization to export audio. */
  audioCleanup?: boolean;
  /** Output resolution as WIDTHxHEIGHT, or 'original' to preserve the existing auto path. */
  outputResolution: string;
  /** Common output-size preset selected in the export UI. */
  resolutionPreset?: ResolutionPreset;
  /**
   * Video codec for the WebCodecs GPU export path. HEVC/AV1 are probed via
   * VideoEncoder.isConfigSupported and fall back to hardware H.264 when
   * unavailable. FFmpeg exports ignore this and always use libx264.
   */
  videoCodec?: 'h264' | 'hevc' | 'av1';
  /**
   * Look-ahead limiter on the export mix bus (media engine only). Omitted =
   * off, so exports without it keep their exact samples.
   */
  masterLimiter?: import('../utils/audioEffects').MasterLimiterSettings;
}

export type ResolutionPreset = 'original' | '720p' | '1080p' | '1440p' | '4k' | 'custom';

export const RESOLUTION_PRESETS = {
  '720p': '1280x720',
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '4k': '3840x2160',
} as const;

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  crf: 18,
  preset: 'medium',
  videoBitrate: 8_000_000,
  filename: 'stacked',
  outputFormat: 'mp4',
  proresProfile: 3,
  lightVideoCleanup: false,
  audioCleanup: false,
  outputResolution: RESOLUTION_PRESETS['1080p'],
  resolutionPreset: '1080p',
  videoCodec: 'h264',
};

/** Preset definitions for common export scenarios. */
export interface ExportPreset {
  /** Unique identifier for the preset (e.g., 'fast', 'balanced'). Used for programmatic lookup. */
  name: string;
  /** User-friendly label displayed in the UI (e.g., "Fast (CRF 23, ultrafast)"). */
  label: string;
  /** H.264 Constant Rate Factor value (0-51; lower = higher quality). */
  crf: number;
  /** libx264 preset for encoding speed/quality tradeoff. */
  preset: ExportSettings['preset'];
  /** Target video bitrate in bits/s for WebCodecs path. */
  videoBitrate: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    name: 'fast',
    label: 'Fast (CRF 23, ultrafast)',
    crf: 23,
    preset: 'ultrafast',
    videoBitrate: 5_000_000,
  },
  {
    name: 'balanced',
    label: 'Balanced (CRF 18, medium)',
    crf: 18,
    preset: 'medium',
    videoBitrate: 8_000_000,
  },
  {
    name: 'high',
    label: 'High Quality (CRF 15, slow)',
    crf: 15,
    preset: 'slow',
    videoBitrate: 12_000_000,
  },
  {
    name: 'archive',
    label: 'Archive (CRF 8, veryslow)',
    crf: 8,
    preset: 'veryslow',
    videoBitrate: 20_000_000,
  },
];

/**
 * Describes which rendering path will be used and why.
 * Exposed before/during render to help users understand performance implications.
 */
export interface RenderPlan {
  /** Which rendering strategy will be used */
  path: 'lossless-concat' | 'effects-reencoding' | 'transitions' | 'pip' | 'textoverlays';
  /** Brief human-readable reason (e.g., "Clip has 0.5s fade", "Transitions enabled") */
  reason: string;
  /** Whether re-encoding will occur (lossless = false, others = true) */
  willReencode: boolean;
  /** User-friendly description for UI display */
  description: string;
  /**
   * Text overlays using `fill: 'shader'` present in the project, if any.
   * FFmpeg's `drawtext` filter only supports a solid `fontcolor`, so these
   * overlays lose their shader look whenever the render falls back to
   * FFmpeg (see `shaderTextFallbackApplied`).
   */
  shaderTextOverlays?: { id: string; text: string }[];
  /**
   * True only on the resolved render plan returned after encoding, when the
   * chosen path actually fell back to solid-color text because it can't
   * preserve shader fills (FFmpeg `drawtext`). Absent on the pre-render
   * estimate and on GPU-compositor renders, which preserve shader fills.
   */
  shaderTextFallbackApplied?: boolean;
  /**
   * Where chroma / luma keying ran, on the resolved plan returned after
   * encoding. Absent when no clip is keyed at all.
   *
   * - `gpu` — the WebGPU/Canvas2D compositor keyed each layer, matching the
   *   preview. FFmpeg's `chromakey` is *not* also applied on this path.
   * - `ffmpeg` — the FFmpeg fallback keyed via `chromakey` / `lumakey`.
   * - `unsupported` — the encoder has no keying step (the MediaRecorder canvas
   *   path plays clips back rather than compositing a plan), so the key is
   *   lost. Same class of limitation as its missing transitions/PiP.
   */
  overlayKeying?: 'gpu' | 'ffmpeg' | 'unsupported';
  /**
   * Which encoder is expected (pre-render estimate) or actually ran (resolved
   * plan, overwritten after encoding) to produce this render. Lets the
   * toolbar say up front whether Render will land on the GPU compositor,
   * FFmpeg, or the Canvas/MediaRecorder path — the same shape as
   * `EncoderPath` in `utils/hybrid-encoder.ts`.
   */
  encoderIntent?: 'webcodecs-av' | 'webcodecs' | 'ffmpeg' | 'canvas';
  /**
   * The WebCodecs video encoder a `webcodecs*` render actually configured:
   * the codec string and the acceleration rung the probe accepted
   * (`no-preference` on a machine with no hardware encoder). Resolved plans only.
   */
  videoEncoder?: { codec: string; hardwareAcceleration: HardwareAcceleration };
  /** True when any finishing pass (noise reduction / color / curves / LUT / sharpen / CA / bloom / grain) is enabled. */
  finishingActive?: boolean;
  /** True when any clip has an active stabilization matrix that will be applied. */
  stabilizeActive?: boolean;
  /** Caption export mode this render will use, when the project has captions. */
  captionMode?: 'none' | 'burn' | 'soft';
  /**
   * True when the project has shader-filled text overlays and `encoderIntent`
   * is a path that can't preserve them (`ffmpeg` or `canvas`) — the pre-render
   * counterpart to `shaderTextFallbackApplied`, which only fires after the
   * fact.
   */
  shaderTextFallbackRisk?: boolean;
  /**
   * Finishing features present in the project that FFmpeg cannot apply:
   * creative LUT, curves & levels, secondary-color window / power-window
   * grades, chromatic aberration and bloom are WebGPU-only (FFmpeg only bakes hue-only secondary grades
   * into a `lut3d`, and has no radial per-channel scale for CA).
   * Populated whenever `encoderIntent` is `'ffmpeg'` and one of these is
   * active; absent otherwise.
   */
  ffmpegFinishingGaps?: string[];
  /**
   * Where a non-default output color (Display P3 / HDR10 / scene-linear
   * working space) was honored. `ignored` means the encode is Rec.709 SDR
   * because the path was FFmpeg or the MediaRecorder canvas.
   */
  wideColor?: 'gpu' | 'ignored';
  /**
   * Where clip picture transforms (rotation / scale / anchor) were applied,
   * when any clip has one.
   *
   * - `gpu` — the compositor sampled every layer through the composed warp
   *   (`clipTransform.ts`), matching the preview, transitions included.
   * - `ffmpeg` — the Force-FFmpeg / no-WebGPU fallback approximated it with
   *   `scale` + `rotate`. See `pictureTransformGaps` for what that loses.
   */
  pictureTransform?: 'gpu' | 'ffmpeg';
  /**
   * Where lane-bus / master FX, sidechain ducks and the loudness target ran,
   * when the project has any. Resolved plans only.
   *
   * - `engine` — the media engine's bus graph mixed the export.
   * - `offline-fallback` — the media engine was unavailable, so the premix
   *   ran on OfflineAudioContext: dry, with no bus FX, ducks or loudness.
   * - `none` — no audio premix ran for this render, so the bus settings
   *   never reached the file.
   */
  audioFx?: 'engine' | 'offline-fallback' | 'none';
  /**
   * Loudness normalization the export applied: the target, what pass 1
   * measured, the gain it applied, and what the delivered file reads.
   */
  loudness?: {
    targetLufs: number;
    measuredLufs: number;
    gainDb: number;
    outputLufs: number;
    outputTruePeakDb: number;
  };
  /**
   * What the FFmpeg picture-transform fallback cannot reproduce (e.g. the
   * optical-flow stabilization warp on a rotated clip — `@ffmpeg/core` has no
   * libvidstab). Present only when `pictureTransform` is `ffmpeg` and
   * something is actually lost.
   */
  pictureTransformGaps?: string[];
}
