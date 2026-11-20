/**
 * WebGPU timeline compositor export: one frame per output timestamp through
 * the preview compositor (`TimelineFrameSession`), encoded with WebCodecs.
 *
 * Two shapes:
 * - **segmented** (default, `renderCache/segmentedExport.ts`): content-keyed
 *   segments, each copied from its source (smart render), reused from the
 *   render cache, or rendered by a fresh encoder and stored;
 * - **continuous**: one encoder over every frame — with the render cache and
 *   smart render off (or `?no_render_cache`), and as the fallback when a
 *   segmented export cannot keep one set of parameter sets.
 */

import { effectiveTextOverlays, withNestedInstances } from '../composition/nestedSequences';
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { computeTotalDuration } from '../timeline/transitions';
import { canCaptureWebGpuCanvasWithText } from './renderEligibility';
import { DEFAULT_FINISHING, type FinishingSettings } from '../finishing/finishing';
import { DEFAULT_COLOR_MANAGEMENT, type ColorManagementSettings } from '../finishing/colorManagement';
import {
  buildPreviewCompositionPlan,
  type CaptionPlanOptions,
} from '../composition/previewComposition';
import type { PreviewCompositionPlan } from '../composition/previewCompositionTypes';
import { isTestHarnessPage } from '../webgpu/previewDecodeFlags';
import { getTimelineClips } from '../timeline/timelineClips';
import { isSequenceClip } from '../timeline/sequenceResolve';
import {
  computeTimelineExportFrameCount,
  TIMELINE_EXPORT_FPS,
  TIMELINE_STATUS_THROTTLE_MS,
} from './webcodecsTimeline';
import {
  buildVideoEncoderConfig,
  resolveEncoderBitrate,
  resolveEncoderCodec,
  webCodecsEncodeProgress,
  WEBCODECS_PROGRESS_STAGES,
  type ResolvedEncoderCodec,
} from './webcodecsCodec';
import { createExportMuxer, muxTimelineAudioIfRequested } from './webcodecsMux';
import { TimelineFrameSession, frameSessionRoute, type FrameEncoderTarget } from './timelineFrameSession';
import type { Mp4Writer } from './container';
import { readVideoPackets, openVideoDemux } from './container/demux';
import {
  canonicalJson,
  finishingIsFrameSeeded,
  quantizePlan,
  renderSettingsHash,
  RENDER_KEY_VERSION,
} from './renderKey';
import { renderCacheConfig } from './renderCache/renderCacheConfig';
import { sharedRenderCache } from './renderCache/sharedRenderCache';
import {
  runSegmentedExport,
  SegmentConfigMismatchError,
  type CopySource,
  type EncodedRange,
  type SegmentedExportReport,
} from './renderCache/segmentedExport';
import { smartRenderBlockers } from './renderCache/smartRender';
import type { SegmentDecoderConfig, SegmentPacket } from './renderCache/segmentRecord';
import { fingerprintMediaCached } from '../project/mediaStore';
import { xxhash64String } from '../utils/xxhash64';
import { BUILD_ID } from '../utils/buildId';

/** Key frame interval of the continuous export (and the segment length cap). */
const GOP_FRAMES = 60;

export interface TimelineExportOptions {
  /** "Force re-encode": smart render copies nothing. */
  forceReencode?: boolean;
}

/** What the last segmented export did (null after a continuous one). */
let lastReport: SegmentedExportReport | null = null;

/** The render-cache / smart-render report of the last timeline export (Copy Debug, `RenderPlan.renderCache`). */
export function getLastRenderCacheReport(): SegmentedExportReport | null {
  return lastReport;
}

export function resetRenderCacheReport(): void {
  lastReport = null;
}

function toSegmentConfig(config: VideoDecoderConfig, width: number, height: number): SegmentDecoderConfig {
  const out: SegmentDecoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth ?? width,
    codedHeight: config.codedHeight ?? height,
  };
  if (config.description) {
    const d = config.description;
    out.description = ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice()
      : new Uint8Array(d).slice();
  }
  if (config.colorSpace) {
    const { primaries, transfer, matrix, fullRange } = config.colorSpace;
    out.colorSpace = {
      ...(primaries != null ? { primaries } : {}),
      ...(transfer != null ? { transfer } : {}),
      ...(matrix != null ? { matrix } : {}),
      ...(fullRange != null ? { fullRange } : {}),
    };
  }
  return out;
}

function packetFrom(chunk: EncodedVideoChunk): SegmentPacket {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, data };
}

/** Encode `[start, end)` with a fresh encoder; its packets and decoder config. */
async function encodeFreshRange(
  session: TimelineFrameSession,
  encoderConfig: VideoEncoderConfig,
  muxer: Mp4Writer,
  width: number,
  height: number,
  start: number,
  end: number,
  onFrame: () => void,
): Promise<EncodedRange> {
  const packets: SegmentPacket[] = [];
  let config: SegmentDecoderConfig | null = null;
  let error: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!config && meta?.decoderConfig) config = toSegmentConfig(meta.decoderConfig, width, height);
      packets.push(packetFrom(chunk));
    },
    error: (e) => {
      error = e;
    },
  });
  const target: FrameEncoderTarget = {
    encoder,
    failure: () => {
      if (error) return error;
      try {
        muxer.throwIfFailed();
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
      return null;
    },
  };
  try {
    encoder.configure(encoderConfig);
    // A segment renders as if after a seek, so a cached copy of it is what this render produces.
    session.resetTemporal();
    await session.encodeRange(target, start, end, GOP_FRAMES, onFrame);
    await encoder.flush();
    if (error) throw error;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (!config) throw new SegmentConfigMismatchError('The encoder reported no decoder config');
  return { packets, config };
}

/** One black frame through a throwaway encoder: the parameter sets this config writes. */
async function probeEncoderConfig(
  encoderConfig: VideoEncoderConfig,
  width: number,
  height: number,
): Promise<SegmentDecoderConfig> {
  let config: SegmentDecoderConfig | null = null;
  let error: Error | null = null;
  const encoder = new VideoEncoder({
    output: (_chunk, meta) => {
      if (!config && meta?.decoderConfig) config = toSegmentConfig(meta.decoderConfig, width, height);
    },
    error: (e) => {
      error = e;
    },
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }
  try {
    encoder.configure(encoderConfig);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    try {
      encoder.encode(frame, { keyFrame: true });
    } finally {
      frame.close();
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (error) throw error;
  if (!config) throw new SegmentConfigMismatchError('The encoder probe reported no decoder config');
  return config;
}

async function openCopySource(clip: Clip): Promise<CopySource | null> {
  if (clip.file.size === 0) return null;
  const demux = await openVideoDemux(clip.file);
  if (demux.hasAlpha) return null;
  return {
    source: { config: demux.config, colorSpace: demux.colorSpace },
    readPackets: (startUs, endUs) => readVideoPackets(clip.file, startUs, endUs),
  };
}

/** Fingerprints of every file a layer can decode (sequence placeholders excluded). */
async function mediaFingerprints(clips: Clip[]): Promise<Map<Blob, string>> {
  const out = new Map<Blob, string>();
  for (const clip of withNestedInstances(clips)) {
    if (isSequenceClip(clip) || clip.offline || clip.file.size === 0 || out.has(clip.file)) continue;
    try {
      out.set(clip.file, await fingerprintMediaCached(clip.file));
    } catch {
      // No fingerprint: the clip's frames are rendered, never cached.
    }
  }
  return out;
}

const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function encodeTimelineComposite(
  clips: Clip[],
  clipGroups: ClipGroup[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  settings: ExportSettings,
  width: number,
  height: number,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  finishing: FinishingSettings = DEFAULT_FINISHING,
  includeWebCodecsAudio = false,
  captionBurnIn: CaptionPlanOptions = {},
  colorManagement: ColorManagementSettings = DEFAULT_COLOR_MANAGEMENT,
  options: TimelineExportOptions = {},
): Promise<Blob> {
  onStatus(`WebGPU timeline export (${width}x${height})...`);
  onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.decodeCompositeEncode, progress: 0, indeterminate: false });
  lastReport = null;

  const timelineClips = getTimelineClips(clips, clipGroups);
  const totalDuration = computeTotalDuration(timelineClips, transitions);
  const totalFrames = computeTimelineExportFrameCount(totalDuration, TIMELINE_EXPORT_FPS);
  // Titles inside nested sequences come out of the plan too.
  const drawnOverlays = effectiveTextOverlays(timelineClips, textOverlays);
  const hasTextOverlays = drawnOverlays.length > 0;
  const hasCaptions = (captionBurnIn.captions?.length ?? 0) > 0;
  const outputColor = colorManagement.outputColor;
  const hdr10 = outputColor === 'hdr10';
  // HDR10: titles and captions are drawn on a transparent 2D canvas and
  // composited in the working space at the graphics white, before the PQ
  // output transform (`ManagedFinishingChain`), so the 10-bit file has them.
  const hdrGraphics = hdr10 && (hasTextOverlays || hasCaptions);
  // Captions are rasterized on the 2D pass (no shader fill), so any cue forces
  // the 2D composite even when every text overlay could have stayed on the GPU.
  // Both still ride the same encode — this is what removes the burn-in
  // post-pass's extra full re-encode.
  const shaderTextOnGpu =
    !hdr10 && hasTextOverlays && !hasCaptions && canCaptureWebGpuCanvasWithText(drawnOverlays);
  const use2dTextComposite = !hdr10 && (hasTextOverlays || hasCaptions) && !shaderTextOnGpu;

  const cacheConfig = renderCacheConfig();
  const segmented = totalFrames > 0 && (cacheConfig.enabled || cacheConfig.smartRender);
  const rawPlan = (frameIndex: number): PreviewCompositionPlan =>
    buildPreviewCompositionPlan(
      clips,
      clipGroups,
      transitions,
      textOverlays,
      settings,
      frameIndex / TIMELINE_EXPORT_FPS,
      height,
      width,
      captionBurnIn,
    );
  // A segmented export draws exactly the plans it keys (`quantizePlan`).
  const planFor = segmented ? (frameIndex: number) => quantizePlan(rawPlan(frameIndex)) : rawPlan;

  const route = { hdrGraphics, shaderTextOnGpu, use2dTextComposite };
  const session = await TimelineFrameSession.create(clips, {
    width,
    height,
    fps: TIMELINE_EXPORT_FPS,
    finishing,
    colorManagement,
    checkFirstFrame: isTestHarnessPage(),
    planFor,
    ...route,
  });

  const bitrate = resolveEncoderBitrate(settings, width, height);
  const encoderCodec = await resolveEncoderCodec(settings.videoCodec, width, height, bitrate, outputColor);
  const encoderConfig = buildVideoEncoderConfig(
    encoderCodec,
    width,
    height,
    bitrate,
    TIMELINE_EXPORT_FPS,
    outputColor,
  );

  let lastStatusAt = 0;
  const progress = (fraction: number) => {
    const now = performance.now();
    if (now - lastStatusAt >= TIMELINE_STATUS_THROTTLE_MS || fraction >= 1) {
      lastStatusAt = now;
      onStatus(`GPU timeline encode: ${(fraction * totalDuration).toFixed(1)}s / ${totalDuration.toFixed(1)}s`);
    }
    onProgress?.(webCodecsEncodeProgress(fraction * totalDuration, totalDuration));
  };

  const finish = async (muxer: Mp4Writer): Promise<Blob> => {
    await muxTimelineAudioIfRequested(
      muxer,
      clips,
      clipGroups,
      transitions,
      includeWebCodecsAudio,
      onStatus,
      onProgress,
    );
    const buffer = await muxer.finalize();
    return new Blob([buffer], { type: 'video/mp4' });
  };

  const frame = { width, height, totalFrames, progress, onStatus };
  try {
    if (segmented) {
      try {
        const muxer = createExportMuxer(width, height, encoderCodec, includeWebCodecsAudio);
        lastReport = await encodeSegmented(session, muxer, frame, {
          clips,
          planFor,
          finishing,
          colorManagement,
          encoderCodec,
          encoderConfig,
          route,
          cacheConfig,
          forceReencode: options.forceReencode === true,
        });
        return await finish(muxer);
      } catch (err) {
        if (!(err instanceof SegmentConfigMismatchError)) throw err;
        onStatus(`Segmented export fell back to one continuous encode (${err.message})...`);
        lastReport = null;
      }
    }
    const muxer = createExportMuxer(width, height, encoderCodec, includeWebCodecsAudio);
    await encodeContinuous(session, muxer, encoderConfig, frame);
    onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.flush, progress: 0.9, indeterminate: false });
    return await finish(muxer);
  } finally {
    session.destroy();
  }
}

interface FrameRun {
  width: number;
  height: number;
  totalFrames: number;
  progress: (fraction: number) => void;
  onStatus: StatusCallback;
}

/** One encoder over every frame, a key frame every GOP. */
async function encodeContinuous(
  session: TimelineFrameSession,
  muxer: Mp4Writer,
  encoderConfig: VideoEncoderConfig,
  run: FrameRun,
): Promise<void> {
  let videoError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      videoError = e;
    },
  });
  videoEncoder.configure(encoderConfig);
  session.resetTemporal();
  try {
    await session.encodeRange(
      {
        encoder: videoEncoder,
        failure: () => {
          if (videoError) return videoError;
          muxer.throwIfFailed();
          return null;
        },
      },
      0,
      run.totalFrames,
      GOP_FRAMES,
      (frameIndex) => run.progress((frameIndex + 1) / Math.max(1, run.totalFrames)),
    );
    run.onStatus('Flushing GPU encoder...');
    await videoEncoder.flush();
    if (videoError) throw videoError;
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
  }
}

interface SegmentedInputs {
  clips: Clip[];
  planFor: (frameIndex: number) => PreviewCompositionPlan;
  finishing: FinishingSettings;
  colorManagement: ColorManagementSettings;
  encoderCodec: ResolvedEncoderCodec;
  encoderConfig: VideoEncoderConfig;
  route: Parameters<typeof frameSessionRoute>[0];
  cacheConfig: ReturnType<typeof renderCacheConfig>;
  forceReencode: boolean;
}

/** The segmented export (`renderCache/segmentedExport.ts`) wired to WebGPU, WebCodecs, OPFS and the demuxer. */
async function encodeSegmented(
  session: TimelineFrameSession,
  muxer: Mp4Writer,
  run: FrameRun,
  input: SegmentedInputs,
): Promise<SegmentedExportReport> {
  const { width, height } = run;
  const { cacheConfig, encoderConfig, finishing, colorManagement } = input;
  const cache = cacheConfig.enabled ? await sharedRenderCache() : null;
  if (cache && cache.usage().budgetBytes !== cacheConfig.budgetBytes) {
    await cache.setBudget(cacheConfig.budgetBytes);
  }
  const fingerprints = await mediaFingerprints(input.clips);
  const settingsHash = renderSettingsHash({ finishing, colorManagement, width, height, buildId: BUILD_ID });
  const settingsKey = xxhash64String(
    canonicalJson({
      v: RENDER_KEY_VERSION,
      settings: settingsHash,
      encoder: encoderConfig,
      route: frameSessionRoute(input.route),
      fps: TIMELINE_EXPORT_FPS,
      gop: GOP_FRAMES,
    }),
  );
  return runSegmentedExport({
    totalFrames: run.totalFrames,
    frameDurationUs: Math.round(1_000_000 / TIMELINE_EXPORT_FPS),
    width,
    height,
    planFor: input.planFor,
    keyContext: {
      clipsById: new Map(withNestedInstances(input.clips).map((clip) => [clip.id, clip])),
      mediaKey: (clip) => fingerprints.get(clip.file) ?? null,
      settingsHash,
    },
    frameSeeded: finishingIsFrameSeeded(finishing),
    settingsKey,
    cache,
    smartRender: cacheConfig.smartRender
      ? {
          blockers: smartRenderBlockers({
            smartRender: true,
            forceReencode: input.forceReencode,
            muxerCodec: input.encoderCodec.muxerCodec,
            finishing,
            colorManagement,
          }),
          openSource: openCopySource,
        }
      : null,
    encodeRange: (start, end, onFrame) =>
      encodeFreshRange(session, encoderConfig, muxer, width, height, start, end, onFrame),
    probeEncoderConfig: () =>
      probeEncoderConfig(encoderConfig, width, height).catch((err: unknown) => {
        // An encoder that will not take the probe frame cannot be planned against: encode continuously.
        throw new SegmentConfigMismatchError(
          `the encoder probe failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }),
    sink: muxer,
    onProgress: run.progress,
    onStatus: run.onStatus,
    yieldNow,
  });
}
