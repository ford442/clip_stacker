/**
 * WebCodecs-based encoder for GPU-accelerated video export.
 *
 * Architecture:
 *  - Video: VideoDecoder (WebCodecs demux/decode, see webcodecs-decoder.ts)
 *    → WebGPU or Canvas compositor → VideoEncoder (hardware H.264/HEVC/AV1)
 *    → mp4-muxer (video-only)
 *  - Decode fallback: HTMLVideoElement → requestVideoFrameCallback capture when
 *    a clip cannot be demuxed/decoded with WebCodecs
 *  - Audio: muxed separately via FFmpeg (muxVideoWithAudio) — FFmpeg WASM is
 *    intentionally scoped to audio extract/mux and explicit "Force FFmpeg" only
 *
 * When transitions are active and WebGPU is available, the timeline compositor
 * renders identical WGSL transition frames as preview (WYSIWYG export).
 *
 * Falls back gracefully; callers should wrap in try/catch and fall back to FFmpeg.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { getClipDuration } from './project';
import { parseOutputResolution } from './resolution';
import { computeTotalDuration } from './transitions';
import { shouldUseTimelineGpuExport } from './renderEligibility';
import { DEFAULT_COLOR_GRADE, type ColorGradeSettings } from './lut';
import { buildPreviewCompositionPlan } from './previewComposition';
import { drawTextOverlays, renderTextOverlaysAsync } from './canvas-renderer';
import { ExportCompositor, isWebGpuExportAvailable } from '../webgpu/exportCompositor';
import { ClipFrameDecoder } from './webcodecs-decoder';
import { TimelinePreviewEngine } from '../webgpu/timelinePreview';
import { getTimelineClips } from './timelineClips';

const TARGET_FPS = 30;
const WEBCODECS_PROGRESS_START = 0.05;
const WEBCODECS_PROGRESS_RANGE = 0.82;

export type GpuCompositorKind = 'auto' | 'webgpu' | 'canvas';

interface ResolvedCompositor {
  kind: 'webgpu' | 'canvas';
  gpuCompositor: ExportCompositor | null;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
}

function mapWebCodecsProgress(elapsedDuration: number, totalDuration: number): number | undefined {
  if (totalDuration <= 0) return undefined;
  return WEBCODECS_PROGRESS_START + (elapsedDuration / totalDuration) * WEBCODECS_PROGRESS_RANGE;
}

// ---------------------------------------------------------------------------
// Encoder codec selection
// ---------------------------------------------------------------------------

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

declare global {
  interface HTMLVideoElement {
    requestVideoFrameCallback(
      callback: (now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void,
    ): number;
    cancelVideoFrameCallback(handle: number): void;
  }
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

async function resolveCompositor(
  width: number,
  height: number,
  preference: GpuCompositorKind,
): Promise<ResolvedCompositor> {
  const useWebGpu =
    preference === 'webgpu' ||
    (preference === 'auto' && (await isWebGpuExportAvailable()));

  if (useWebGpu) {
    try {
      const gpuCompositor = await ExportCompositor.create(width, height);
      return {
        kind: 'webgpu',
        gpuCompositor,
        canvas: gpuCompositor.canvas,
        ctx: null,
      };
    } catch {
      if (preference === 'webgpu') throw new Error('WebGPU compositor unavailable');
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D canvas for GPU export');
  return { kind: 'canvas', gpuCompositor: null, canvas, ctx };
}

/**
 * Encode timeline video with hardware H.264. Audio is intentionally omitted;
 * callers should mux source audio with FFmpeg via muxVideoWithAudio().
 */
export async function encodeVideoWithWebCodecs(
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  compositorPreference: GpuCompositorKind = 'auto',
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  clipGroups: ClipGroup[] = [],
  colorGrade: ColorGradeSettings = DEFAULT_COLOR_GRADE,
): Promise<Blob> {
  const { width, height } = parseOutputResolution(settings.outputResolution);

  if (shouldUseTimelineGpuExport(clips, transitions, textOverlays, colorGrade)) {
    const webGpuOk = await isWebGpuExportAvailable();
    if (!webGpuOk) {
      throw new Error('WebGPU required for GPU timeline compositor export');
    }
    return encodeTimelineComposite(
      clips,
      clipGroups,
      transitions,
      textOverlays,
      settings,
      width,
      height,
      onStatus,
      onProgress,
      colorGrade,
    );
  }

  onStatus(
    compositorPreference === 'webgpu'
      ? 'Initializing WebGPU + hardware encoder...'
      : 'Initializing GPU hardware encoder...',
  );
  onProgress?.({ stage: 'Initializing GPU encoder', progress: 0, indeterminate: false });

  const compositor = await resolveCompositor(width, height, compositorPreference);
  onStatus(
    compositor.kind === 'webgpu'
      ? `WebGPU compositor active (${width}x${height})`
      : `Canvas compositor active (${width}x${height})`,
  );

  const encoderCodec = await resolveEncoderCodec(settings.videoCodec, width, height);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: encoderCodec.muxerCodec, width, height },
    fastStart: 'in-memory',
  });

  let videoError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { videoError = e; },
  });

  videoEncoder.configure({
    codec: encoderCodec.codec,
    width,
    height,
    bitrate: settings.videoBitrate,
    framerate: TARGET_FPS,
    hardwareAcceleration: 'prefer-hardware',
  });

  let videoTimeUs = 0;
  const totalDuration = clips.reduce((sum, clip) => sum + getClipDuration(clip), 0);
  let elapsedDuration = 0;

  try {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      onStatus(`GPU encode [${i + 1}/${clips.length}]: "${clip.title}"...`);
      onProgress?.({
        stage: `GPU encode: ${clip.title}`,
        progress: mapWebCodecsProgress(elapsedDuration, totalDuration),
        indeterminate: totalDuration <= 0,
      });

      videoTimeUs = await encodeVideoFrames(
        videoEncoder,
        compositor,
        clip,
        videoTimeUs,
        width,
        height,
        colorGrade,
      );
      if (videoError) throw videoError;

      elapsedDuration += getClipDuration(clip);
      onProgress?.({
        stage: `GPU encode: ${clip.title}`,
        progress: mapWebCodecsProgress(elapsedDuration, totalDuration),
        indeterminate: totalDuration <= 0,
      });
    }

    onStatus('Flushing GPU encoder...');
    onProgress?.({ stage: 'Flushing GPU encoder', progress: 0.9, indeterminate: false });
    await videoEncoder.flush();
    if (videoError) throw videoError;

    muxer.finalize();
    onProgress?.({ stage: 'Finalizing GPU video', progress: 0.92, indeterminate: false });

    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    compositor.gpuCompositor?.destroy();
  }
}

/** @deprecated Use encodeVideoWithWebCodecs + muxVideoWithAudio instead. */
export async function encodeClipsWithWebCodecs(
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  transitions: ClipTransition[] = [],
): Promise<Blob> {
  return encodeVideoWithWebCodecs(clips, settings, onStatus, onProgress, 'auto', transitions);
}

async function encodeTimelineComposite(
  clips: Clip[],
  clipGroups: ClipGroup[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  settings: ExportSettings,
  width: number,
  height: number,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  colorGrade: ColorGradeSettings = DEFAULT_COLOR_GRADE,
): Promise<Blob> {
  onStatus(`WebGPU timeline export (${width}x${height})...`);
  onProgress?.({ stage: 'GPU timeline encode', progress: 0, indeterminate: false });

  const timelineClips = getTimelineClips(clips, clipGroups);
  const totalDuration = computeTotalDuration(timelineClips, transitions);
  const videoCanvas = document.createElement('canvas');
  videoCanvas.width = width;
  videoCanvas.height = height;

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const exportCtx = exportCanvas.getContext('2d');
  if (!exportCtx) throw new Error('Could not create export canvas');

  const engine = await TimelinePreviewEngine.create(videoCanvas, clips);

  const encoderCodec = await resolveEncoderCodec(settings.videoCodec, width, height);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: encoderCodec.muxerCodec, width, height },
    fastStart: 'in-memory',
  });

  let videoError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { videoError = e; },
  });

  videoEncoder.configure({
    codec: encoderCodec.codec,
    width,
    height,
    bitrate: settings.videoBitrate,
    framerate: TARGET_FPS,
    hardwareAcceleration: 'prefer-hardware',
  });

  const frameDurationUs = Math.round(1_000_000 / TARGET_FPS);
  const step = 1 / TARGET_FPS;
  let frameIndex = 0;

  try {
    for (let globalTime = 0; globalTime < totalDuration; globalTime += step) {
      onStatus(`GPU timeline encode: ${globalTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s`);
      onProgress?.({
        stage: 'GPU timeline encode',
        progress: mapWebCodecsProgress(globalTime, totalDuration),
        indeterminate: totalDuration <= 0,
      });

      const plan = buildPreviewCompositionPlan(
        clips,
        clipGroups,
        transitions,
        textOverlays,
        settings,
        globalTime,
        height,
        width,
      );
      await engine.renderPlan(plan, { colorGrade });

      exportCtx.drawImage(videoCanvas, 0, 0);
      if (textOverlays.length > 0) {
        const hasShader = textOverlays.some((o) => o.fill === 'shader');
        if (hasShader) {
          await renderTextOverlaysAsync(exportCtx.canvas, plan);
        } else {
          drawTextOverlays(exportCtx, plan);
        }
      }

      const frame = new VideoFrame(exportCanvas, {
        timestamp: frameIndex * frameDurationUs,
        duration: frameDurationUs,
      });
      videoEncoder.encode(frame, { keyFrame: frameIndex % 60 === 0 });
      frame.close();
      frameIndex++;
      if (videoError) throw videoError;
    }

    onStatus('Flushing GPU encoder...');
    await videoEncoder.flush();
    if (videoError) throw videoError;
    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    engine.destroy();
  }
}

async function encodeVideoFrames(
  encoder: VideoEncoder,
  compositor: ResolvedCompositor,
  clip: Clip,
  startTimeUs: number,
  targetWidth: number,
  targetHeight: number,
  colorGrade: ColorGradeSettings = DEFAULT_COLOR_GRADE,
): Promise<number> {
  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const clipDuration = trimEnd - trimStart;

  if (clip.kind === 'audio') {
    drawBlackFrame(compositor, targetWidth, targetHeight);
    const frame = new VideoFrame(compositor.canvas, {
      timestamp: startTimeUs,
      duration: Math.round(clipDuration * 1_000_000),
    });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    return startTimeUs + Math.round(clipDuration * 1_000_000);
  }

  // Preferred hot path: WebCodecs VideoDecoder demux/decode — exact frame
  // delivery with no <video> seek in the loop. Falls back to element capture
  // for containers/codecs the decoder path cannot handle.
  try {
    return await encodeVideoFramesFromDecoder(
      encoder,
      compositor,
      clip,
      startTimeUs,
      targetWidth,
      targetHeight,
      colorGrade,
      trimStart,
      trimEnd,
      clipDuration,
    );
  } catch {
    // Fall through to the HTMLVideoElement capture path below.
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
  document.body.appendChild(video);

  try {
    video.src = clip.objectUrl;
    video.currentTime = trimStart;
    await waitForSeeked(video);
    video.playbackRate = 3.0;

    let frameCount = 0;

    if (video.requestVideoFrameCallback) {
      await new Promise<void>((resolve, reject) => {
        let done = false;

        const onFrame = (_now: DOMHighResTimeStamp, meta: { mediaTime: number }) => {
          if (done) return;

          const mediaTime = meta.mediaTime;
          if (mediaTime >= trimEnd - 1 / TARGET_FPS) {
            done = true;
            resolve();
            return;
          }

          const elapsed = Math.max(0, mediaTime - trimStart);
          const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);
          drawCompositedFrame(
            compositor,
            video,
            elapsed,
            clipDuration,
            clip,
            targetWidth,
            targetHeight,
            colorGrade,
          );

          const frame = new VideoFrame(compositor.canvas, {
            timestamp,
            duration: Math.round(1_000_000 / TARGET_FPS),
          });
          encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
          frame.close();
          frameCount++;

          video.requestVideoFrameCallback!(onFrame);
        };

        video.addEventListener('ended', () => { done = true; resolve(); }, { once: true });
        video.addEventListener('error', reject, { once: true });
        video.requestVideoFrameCallback!(onFrame);
        video.play().catch(reject);
      });
    } else {
      const stepSeconds = 1 / TARGET_FPS;
      let t = trimStart;
      while (t < trimEnd) {
        video.currentTime = t;
        await waitForSeeked(video);

        const elapsed = t - trimStart;
        const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);
        drawCompositedFrame(
          compositor,
          video,
          elapsed,
          clipDuration,
          clip,
          targetWidth,
          targetHeight,
          colorGrade,
        );

        const frame = new VideoFrame(compositor.canvas, {
          timestamp,
          duration: Math.round(1_000_000 / TARGET_FPS),
        });
        encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
        frame.close();
        frameCount++;
        t += stepSeconds;
      }
    }
  } finally {
    video.src = '';
    if (document.body.contains(video)) document.body.removeChild(video);
  }

  return startTimeUs + Math.round(clipDuration * 1_000_000);
}

/** Encoded chunks allowed in flight before pausing frame submission. */
const MAX_ENCODE_QUEUE_DEPTH = 16;

function waitForEncoderDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const target = encoder as unknown as EventTarget;
    if (typeof target.addEventListener === 'function') {
      target.addEventListener('dequeue', () => resolve(), { once: true });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Decoder-driven frame delivery: VideoDecoder → ring buffer → compositor →
 * VideoEncoder, no HTMLVideoElement in the loop. Runs at decode speed rather
 * than playback speed.
 */
async function encodeVideoFramesFromDecoder(
  encoder: VideoEncoder,
  compositor: ResolvedCompositor,
  clip: Clip,
  startTimeUs: number,
  targetWidth: number,
  targetHeight: number,
  colorGrade: ColorGradeSettings,
  trimStart: number,
  trimEnd: number,
  clipDuration: number,
): Promise<number> {
  const decoder = await ClipFrameDecoder.open(clip.file, { trimStart, trimEnd });
  let frameCount = 0;

  try {
    for await (const frame of decoder.frames()) {
      const elapsed = Math.max(0, frame.timestamp / 1_000_000 - trimStart);
      try {
        drawCompositedVideoFrame(
          compositor,
          frame,
          elapsed,
          clipDuration,
          clip,
          targetWidth,
          targetHeight,
          colorGrade,
        );
      } finally {
        frame.close();
      }

      const encodedFrame = new VideoFrame(compositor.canvas, {
        timestamp: startTimeUs + Math.round(elapsed * 1_000_000),
        duration: Math.round(1_000_000 / TARGET_FPS),
      });
      encoder.encode(encodedFrame, { keyFrame: frameCount % 60 === 0 });
      encodedFrame.close();
      frameCount++;

      if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE_DEPTH) {
        await waitForEncoderDequeue(encoder);
      }
    }
  } finally {
    decoder.close();
  }

  if (frameCount === 0) {
    throw new Error('VideoDecoder path produced no frames');
  }
  return startTimeUs + Math.round(clipDuration * 1_000_000);
}

/** Composite a decoded VideoFrame (decoder path) with letterbox + fades + grade. */
function drawCompositedVideoFrame(
  compositor: ResolvedCompositor,
  frame: VideoFrame,
  elapsed: number,
  duration: number,
  clip: Clip,
  targetWidth: number,
  targetHeight: number,
  colorGrade: ColorGradeSettings,
): void {
  if (compositor.kind === 'webgpu' && compositor.gpuCompositor) {
    compositor.gpuCompositor.renderFrame(
      frame,
      elapsed,
      duration,
      clip.videoFadeIn,
      clip.videoFadeOut,
    );
    compositor.gpuCompositor.applyColorGrade(colorGrade);
    return;
  }

  const ctx = compositor.ctx!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  const destRect = calculateLetterboxRect(
    frame.displayWidth || targetWidth,
    frame.displayHeight || targetHeight,
    targetWidth,
    targetHeight,
  );
  ctx.drawImage(frame, destRect.x, destRect.y, destRect.width, destRect.height);
  applyFadeOverlay(ctx, compositor.canvas, elapsed, duration, clip.videoFadeIn, clip.videoFadeOut);
}

function drawBlackFrame(compositor: ResolvedCompositor, width: number, height: number): void {
  if (compositor.kind === 'webgpu' && compositor.gpuCompositor) {
    compositor.gpuCompositor.clearBlack();
    return;
  }
  compositor.ctx!.fillStyle = '#000';
  compositor.ctx!.fillRect(0, 0, width, height);
}

function drawCompositedFrame(
  compositor: ResolvedCompositor,
  video: HTMLVideoElement,
  elapsed: number,
  duration: number,
  clip: Clip,
  targetWidth: number,
  targetHeight: number,
  colorGrade: ColorGradeSettings = DEFAULT_COLOR_GRADE,
): void {
  if (compositor.kind === 'webgpu' && compositor.gpuCompositor) {
    const frame = new VideoFrame(video, { timestamp: Math.round(elapsed * 1_000_000) });
    compositor.gpuCompositor.renderFrame(
      frame,
      elapsed,
      duration,
      clip.videoFadeIn,
      clip.videoFadeOut,
    );
    frame.close();
    compositor.gpuCompositor.applyColorGrade(colorGrade);
    return;
  }

  const ctx = compositor.ctx!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  const destRect = calculateLetterboxRect(
    video.videoWidth || targetWidth,
    video.videoHeight || targetHeight,
    targetWidth,
    targetHeight,
  );
  ctx.drawImage(video, destRect.x, destRect.y, destRect.width, destRect.height);
  applyFadeOverlay(ctx, compositor.canvas, elapsed, duration, clip.videoFadeIn, clip.videoFadeOut);
}

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && !video.seeking) {
      resolve();
      return;
    }
    const onSeeked = () => { off(); resolve(); };
    const onError = () => { off(); reject(new Error('Video seek failed')); };
    const off = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function calculateLetterboxRect(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const videoAspect = videoWidth / videoHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  let destWidth: number;
  let destHeight: number;

  if (videoAspect > canvasAspect) {
    destWidth = canvasWidth;
    destHeight = canvasWidth / videoAspect;
  } else {
    destHeight = canvasHeight;
    destWidth = canvasHeight * videoAspect;
  }

  return {
    x: (canvasWidth - destWidth) / 2,
    y: (canvasHeight - destHeight) / 2,
    width: destWidth,
    height: destHeight,
  };
}

function applyFadeOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  elapsed: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
): void {
  const alpha = computeFadeAlpha(elapsed, duration, fadeIn, fadeOut);
  if (alpha < 1) {
    ctx.fillStyle = `rgba(0,0,0,${(1 - alpha).toFixed(4)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function computeFadeAlpha(elapsed: number, duration: number, fadeIn: number, fadeOut: number): number {
  let alpha = 1;
  if (fadeIn > 0 && elapsed < fadeIn) alpha = Math.min(alpha, elapsed / fadeIn);
  if (fadeOut > 0 && elapsed > duration - fadeOut) {
    alpha = Math.min(alpha, (duration - elapsed) / fadeOut);
  }
  return Math.max(0, Math.min(1, alpha));
}
