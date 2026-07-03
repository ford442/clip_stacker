/**
 * CanvasRenderer — browser-native compositing engine for the hybrid rendering pipeline.
 *
 * Plays clips sequentially onto a 2D canvas using hidden <video> elements and a
 * requestAnimationFrame loop.  Integrates the Web Audio API (AnalyserNode) for
 * real-time audio-reactive effects such as a warm bass-driven glow overlay.
 *
 * Usage:
 *   const renderer = new CanvasRenderer(canvas, { audioReactive: true });
 *   await renderer.renderClips(clips, (progress) => setStatus(...));
 */

import type { Clip } from "../types";
import { getClipDuration } from "./project";
import { ClipMediaPool, seekVideoTo } from "./clipMediaPool";
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
  type PreviewTextLayer,
  type TimelineCompositor,
  type TimelineRenderOptions,
} from "./previewComposition";
import { ffmpegColorToCss, sanitizeFfmpegColor } from "./color";
import { resolveScrollingX } from "./textOverlay";
import { previewMetrics } from "./previewMetrics";
import {
  combineLetterboxWithLayerUv,
  computeLetterboxUv,
  uvRectToSourcePixels,
} from "../webgpu/exportCompositor";

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;

/** Fraction-of-a-frame tolerance used when deciding a clip has ended. */
const FRAME_TOLERANCE_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RendererOptions {
  /** Output canvas width in pixels (default 1280). */
  width?: number;
  /** Output canvas height in pixels (default 720). */
  height?: number;
  /** Target frames per second used for end-of-clip detection (default 30). */
  fps?: number;
  /**
   * Enable audio-reactive visual effects.
   * When true, bass-frequency energy drives a subtle warm glow overlay.
   */
  audioReactive?: boolean;
}

export interface RenderProgress {
  clipIndex: number;
  totalClips: number;
  clipTitle: string;
  /** Seconds elapsed within the current clip. */
  clipElapsed: number;
  /** Seconds elapsed across the full render. */
  totalElapsed: number;
}

export type ProgressCallback = (progress: RenderProgress) => void;

// ---------------------------------------------------------------------------
// CanvasRenderer
// ---------------------------------------------------------------------------

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly options: Required<RendererOptions>;

  /** Set to true to abort the render at the next clip boundary. */
  private abortRequested = false;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("CanvasRenderer: could not get 2D rendering context");
    this.canvas = canvas;
    this.ctx = ctx;
    this.options = {
      width: options.width ?? TARGET_WIDTH,
      height: options.height ?? TARGET_HEIGHT,
      fps: options.fps ?? TARGET_FPS,
      audioReactive: options.audioReactive ?? true,
    };
    this.canvas.width = this.options.width;
    this.canvas.height = this.options.height;
  }

  /** Request an early abort of an in-progress `renderClips` call. */
  stop(): void {
    this.abortRequested = true;
  }

  /**
   * Render clips sequentially onto the canvas.
   * Each clip is played back in real-time; the rAF loop draws every decoded frame.
   * Resolves once all clips have been composited (or `stop()` was called).
   */
  async renderClips(
    clips: Clip[],
    onProgress?: ProgressCallback,
  ): Promise<void> {
    this.abortRequested = false;
    let totalElapsed = 0;

    for (let i = 0; i < clips.length; i++) {
      if (this.abortRequested) break;

      const clip = clips[i];
      const duration = getClipDuration(clip);

      onProgress?.({
        clipIndex: i,
        totalClips: clips.length,
        clipTitle: clip.title,
        clipElapsed: 0,
        totalElapsed,
      });

      await this.renderSingleClip(
        clip,
        i,
        clips.length,
        duration,
        totalElapsed,
        onProgress,
      );

      totalElapsed += duration;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — per-clip render orchestration
  // ---------------------------------------------------------------------------

  private async renderSingleClip(
    clip: Clip,
    clipIndex: number,
    totalClips: number,
    duration: number,
    totalElapsedAtStart: number,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    // Set up Web Audio analysis for this clip.
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let freqData: Uint8Array<ArrayBuffer> | null = null;

    if (this.options.audioReactive) {
      try {
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        freqData = new Uint8Array(
          analyser.frequencyBinCount,
        ) as Uint8Array<ArrayBuffer>;
        // Note: analyser → silentGain → destination wiring is done inside
        // renderVideoClip / renderAudioClip where the source node is created.
      } catch {
        // AudioContext unavailable (e.g., autoplay policy) — skip reactivity.
        audioCtx = null;
        analyser = null;
        freqData = null;
      }
    }

    try {
      if (clip.kind === "audio") {
        await this.renderAudioClip(
          clip,
          duration,
          clipIndex,
          totalClips,
          totalElapsedAtStart,
          onProgress,
          audioCtx,
          analyser,
          freqData,
        );
      } else {
        const trimStart = clip.trimStart;
        const trimEnd = Number.isFinite(clip.trimEnd)
          ? clip.trimEnd
          : clip.duration;
        await this.renderVideoClip(
          clip,
          trimStart,
          trimEnd,
          duration,
          clipIndex,
          totalClips,
          totalElapsedAtStart,
          onProgress,
          audioCtx,
          analyser,
          freqData,
        );
      }
    } finally {
      if (audioCtx) {
        try {
          await audioCtx.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — video clip rendering
  // ---------------------------------------------------------------------------

  private async renderVideoClip(
    clip: Clip,
    trimStart: number,
    trimEnd: number,
    duration: number,
    clipIndex: number,
    totalClips: number,
    totalElapsedAtStart: number,
    onProgress?: ProgressCallback,
    audioCtx?: AudioContext | null,
    analyser?: AnalyserNode | null,
    freqData?: Uint8Array<ArrayBuffer> | null,
  ): Promise<void> {
    const video = document.createElement("video");
    // Start muted — the AudioContext takes over audio routing below.
    video.muted = true;
    video.playsInline = true;
    video.style.cssText =
      "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;";
    document.body.appendChild(video);

    try {
      // Route video audio through the analyser for frequency analysis.
      // A zero-gain node at the end ensures no audible output from this path
      // (the video file's audio is captured separately by FFmpeg for muxing).
      if (audioCtx && analyser) {
        try {
          const source = audioCtx.createMediaElementSource(video);
          const silentGain = audioCtx.createGain();
          silentGain.gain.value = 0;
          source.connect(analyser);
          analyser.connect(silentGain);
          silentGain.connect(audioCtx.destination);
          // Un-mute the element so the AudioContext actually receives audio data.
          video.muted = false;
        } catch {
          // createMediaElementSource may throw if the element was already used.
        }
      }

      video.src = clip.objectUrl;
      video.currentTime = trimStart;
      await waitForSeeked(video);
      await video.play();

      await new Promise<void>((resolve) => {
        let rafHandle = 0;
        let done = false;

        const drawFrame = () => {
          if (done || this.abortRequested) {
            cancelAnimationFrame(rafHandle);
            resolve();
            return;
          }

          const mediaTime = video.currentTime;
          const elapsed = Math.max(0, mediaTime - trimStart);

          if (
            mediaTime >=
              trimEnd - FRAME_TOLERANCE_FRACTION / this.options.fps ||
            video.ended
          ) {
            done = true;
            cancelAnimationFrame(rafHandle);
            resolve();
            return;
          }

          this.drawVideoFrame(
            video,
            clip,
            elapsed,
            duration,
            analyser,
            freqData,
          );

          onProgress?.({
            clipIndex,
            totalClips,
            clipTitle: clip.title,
            clipElapsed: elapsed,
            totalElapsed: totalElapsedAtStart + elapsed,
          });

          rafHandle = requestAnimationFrame(drawFrame);
        };

        video.addEventListener(
          "ended",
          () => {
            done = true;
            resolve();
          },
          { once: true },
        );
        video.addEventListener(
          "error",
          () => {
            done = true;
            resolve();
          },
          { once: true },
        );

        rafHandle = requestAnimationFrame(drawFrame);
      });
    } finally {
      video.pause();
      video.src = "";
      if (document.body.contains(video)) document.body.removeChild(video);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — audio-only clip rendering
  // ---------------------------------------------------------------------------

  private async renderAudioClip(
    clip: Clip,
    duration: number,
    clipIndex: number,
    totalClips: number,
    totalElapsedAtStart: number,
    onProgress?: ProgressCallback,
    audioCtx?: AudioContext | null,
    analyser?: AnalyserNode | null,
    freqData?: Uint8Array<ArrayBuffer> | null,
  ): Promise<void> {
    const audio = new Audio(clip.objectUrl);
    audio.currentTime = clip.trimStart;

    if (audioCtx && analyser) {
      try {
        const source = audioCtx.createMediaElementSource(audio);
        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0;
        source.connect(analyser);
        analyser.connect(silentGain);
        silentGain.connect(audioCtx.destination);
        // Un-mute the element so AudioContext receives the audio data.
        audio.muted = false;
      } catch {
        /* ignore */
      }
    }

    const trimEnd = Number.isFinite(clip.trimEnd)
      ? clip.trimEnd
      : clip.duration;

    try {
      await audio.play();

      await new Promise<void>((resolve) => {
        let rafHandle = 0;
        let done = false;

        const drawFrame = () => {
          if (done || this.abortRequested) {
            cancelAnimationFrame(rafHandle);
            resolve();
            return;
          }

          if (audio.currentTime >= trimEnd || audio.ended) {
            done = true;
            cancelAnimationFrame(rafHandle);
            resolve();
            return;
          }

          const elapsed = Math.max(0, audio.currentTime - clip.trimStart);

          // Black background for audio-only clips.
          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

          if (analyser && freqData) {
            analyser.getByteFrequencyData(freqData);
            this.drawAudioReactiveOverlay(freqData);
          }

          onProgress?.({
            clipIndex,
            totalClips,
            clipTitle: clip.title,
            clipElapsed: elapsed,
            totalElapsed: totalElapsedAtStart + elapsed,
          });

          rafHandle = requestAnimationFrame(drawFrame);
        };

        audio.addEventListener(
          "ended",
          () => {
            done = true;
            resolve();
          },
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => {
            done = true;
            resolve();
          },
          { once: true },
        );

        rafHandle = requestAnimationFrame(drawFrame);
      });
    } finally {
      audio.pause();
      audio.src = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Private — frame compositing helpers
  // ---------------------------------------------------------------------------

  private drawVideoFrame(
    video: HTMLVideoElement,
    clip: Clip,
    elapsed: number,
    duration: number,
    analyser: AnalyserNode | null | undefined,
    freqData: Uint8Array<ArrayBuffer> | null | undefined,
  ): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    // Fill black (letterbox background).
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    // Draw video with letterbox scaling.
    const rect = calculateLetterboxRect(
      video.videoWidth || width,
      video.videoHeight || height,
      width,
      height,
    );
    ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height);

    // Audio-reactive warm glow on top of the video.
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      this.drawAudioReactiveOverlay(freqData);
    }

    // Video fade in/out overlay.
    const fadeAlpha = computeFadeAlpha(
      elapsed,
      duration,
      clip.videoFadeIn,
      clip.videoFadeOut,
    );
    if (fadeAlpha < 1) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - fadeAlpha).toFixed(4)})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  /**
   * Draw a subtle audio-reactive overlay driven by bass frequency energy.
   * A warm radial glow pulses in sync with the low-frequency content of the
   * currently playing clip's audio.
   */
  private drawAudioReactiveOverlay(freqData: Uint8Array<ArrayBuffer>): void {
    if (freqData.length === 0) return;

    // Average the low-frequency (bass) bins — roughly 0–500 Hz.
    const bassEnd = Math.max(1, Math.floor(freqData.length / 4));
    let sum = 0;
    for (let i = 0; i < bassEnd; i++) sum += freqData[i];
    const bassLevel = sum / bassEnd / 255; // normalised 0..1

    if (bassLevel < 0.05) return; // below threshold — skip

    // Scale to a gentle alpha: 0 at bassLevel=0.05, max ~12% at bassLevel=1.
    const alpha = Math.min(0.12, (bassLevel - 0.05) * 0.133);
    const { width, height } = this.canvas;

    const grad = this.ctx.createRadialGradient(
      width / 2,
      height / 2,
      0,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.65,
    );
    grad.addColorStop(0, `rgba(255,180,60,${alpha.toFixed(4)})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");

    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, width, height);
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (shared with webcodecs.ts logic)
// ---------------------------------------------------------------------------

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && !video.seeking) {
      resolve();
      return;
    }
    const onSeeked = () => {
      off();
      resolve();
    };
    const onError = () => {
      off();
      reject(new Error("Video seek failed"));
    };
    const off = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
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

function computeFadeAlpha(
  elapsed: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let alpha = 1;
  if (fadeIn > 0 && elapsed < fadeIn) alpha = Math.min(alpha, elapsed / fadeIn);
  if (fadeOut > 0 && elapsed > duration - fadeOut)
    alpha = Math.min(alpha, (duration - elapsed) / fadeOut);
  return Math.max(0, Math.min(1, alpha));
}

// ---------------------------------------------------------------------------
// Canvas2D timeline compositor (WebGPU preview fallback)
//
// Mirrors the WebGPU TimelinePreviewEngine: draws the same composition plan,
// one source-over layer at a time, with fades/crossfades pre-baked into each
// layer's opacity. source-over with globalAlpha matches the WebGPU path's
// premultiplied-alpha blend exactly, so the two backends are visually equal.
// ---------------------------------------------------------------------------

/** A decoded drawable plus its intrinsic dimensions, keyed by clip id. */
export interface FrameSource {
  image: CanvasImageSource;
  /** Intrinsic source width (e.g. video.videoWidth). */
  width: number;
  /** Intrinsic source height (e.g. video.videoHeight). */
  height: number;
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function drawClipLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewClipLayer,
  source: FrameSource,
): void {
  const destWidth = layer.rect.width;
  const destHeight = layer.rect.height;
  const srcW = source.width || destWidth;
  const srcH = source.height || destHeight;

  const letterbox = computeLetterboxUv(srcW, srcH, destWidth, destHeight);
  const uv = combineLetterboxWithLayerUv(letterbox, layer.uvScale, layer.uvOffset);
  const crop = uvRectToSourcePixels(srcW, srcH, uv);

  const inner = calculateLetterboxRect(srcW, srcH, destWidth, destHeight);
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = clampOpacity(layer.opacity);
  ctx.drawImage(
    source.image,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    layer.rect.x + inner.x,
    layer.rect.y + inner.y,
    inner.width,
    inner.height,
  );
  ctx.globalAlpha = prevAlpha;
}

// Default fallbacks when an overlay carries an invalid FFmpeg color.
const DEFAULT_FONT_COLOR = "white";
const DEFAULT_BOX_COLOR = "black@0.5";

/** Draw one text overlay (box + glyphs) onto the 2D context. */
function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewTextLayer,
  globalTime: number,
  frameWidth: number,
  scale: number,
): void {
  const overlay = layer.overlay;
  if (!overlay.text) return;

  const prevAlpha = ctx.globalAlpha;
  const baseAlpha = clampOpacity(layer.opacity);
  // Font size is authored in output space; scale it to match a downscaled
  // preview canvas (layer.x/y are already scaled by the plan).
  const fontsize = overlay.fontsize * scale;
  ctx.textBaseline = "top";
  ctx.font = `${fontsize}px sans-serif`;

  const textWidth = ctx.measureText(overlay.text).width;
  const textHeight = fontsize;

  // Static overlays use the plan's x; scrolling ones are recomputed here with
  // the measured text width so the ticker start matches the export path.
  const x = overlay.scrolling
    ? resolveScrollingX(overlay.scrollSpeed, globalTime, frameWidth, textWidth)
    : layer.x;

  if (overlay.box) {
    const { color, alpha } = ffmpegColorToCss(
      sanitizeFfmpegColor(overlay.boxColor, DEFAULT_BOX_COLOR),
    );
    const pad = Math.round(fontsize * 0.2);
    ctx.globalAlpha = clampOpacity(baseAlpha * alpha);
    ctx.fillStyle = color;
    ctx.fillRect(
      x - pad,
      layer.y - pad,
      textWidth + pad * 2,
      textHeight + pad * 2,
    );
  }

  const { color, alpha } = ffmpegColorToCss(
    sanitizeFfmpegColor(overlay.fontcolor, DEFAULT_FONT_COLOR),
  );
  ctx.globalAlpha = clampOpacity(baseAlpha * alpha);
  ctx.fillStyle = color;
  ctx.fillText(overlay.text, x, layer.y);
  ctx.globalAlpha = prevAlpha;
}

/**
 * Composite one frame of a preview plan's *video* layers onto a 2D context.
 *
 * `frameSources` provides the decoded image (typically a seeked <video>) for
 * each clip layer, keyed by `clipId`. Clip layers whose source is missing are
 * skipped. Text overlays are NOT drawn here — they are a separate final pass
 * (see {@link drawTextOverlays}) so they can render identically on top of the
 * WebGPU or Canvas2D video composite.
 */
export function compositeFrame(
  ctx: CanvasRenderingContext2D,
  plan: PreviewCompositionPlan,
  frameSources: ReadonlyMap<string, FrameSource>,
): void {
  const { canvasWidth, canvasHeight } = plan;

  // Letterbox background (also clears the previous frame).
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  for (const layer of plan.layers) {
    if (layer.kind === "text") continue;
    const source = frameSources.get(layer.clipId);
    if (!source) continue;
    drawClipLayer(ctx, layer, source);
  }
}

/**
 * Final compositing pass: draw a plan's text overlays onto a 2D context. Used
 * for both preview backends — the WebGPU path draws onto a stacked overlay
 * canvas, the Canvas2D path onto the same overlay canvas above its video
 * composite. Does not clear the context (the caller owns the surface).
 */
export function drawTextOverlays(
  ctx: CanvasRenderingContext2D,
  plan: PreviewCompositionPlan,
): void {
  for (const layer of plan.layers) {
    if (layer.kind !== "text") continue;
    drawTextLayer(ctx, layer, plan.globalTime, plan.canvasWidth, plan.scale);
  }
}

/**
 * Resize a dedicated 2D overlay canvas to the plan's dimensions, clear it, and
 * render the text overlays. The canvas is expected to be stacked transparently
 * over the video composite canvas.
 */
export function renderTextOverlayCanvas(
  canvas: HTMLCanvasElement,
  plan: PreviewCompositionPlan,
): void {
  if (canvas.width !== plan.canvasWidth) canvas.width = plan.canvasWidth;
  if (canvas.height !== plan.canvasHeight) canvas.height = plan.canvasHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTextOverlays(ctx, plan);
}

/**
 * Canvas2D timeline preview compositor — the fallback used when WebGPU is
 * unavailable or over the layer budget. Supports arbitrary `globalTime` seeks.
 */
export class TimelineCanvas2DRenderer implements TimelineCompositor {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly mediaPool: ClipMediaPool;
  private clipsById: Map<string, Clip>;

  private constructor(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    mediaPool: ClipMediaPool,
    clips: Clip[],
  ) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.mediaPool = mediaPool;
    this.clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  }

  static create(
    canvas: HTMLCanvasElement,
    clips: Clip[],
  ): TimelineCanvas2DRenderer {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("TimelineCanvas2DRenderer: 2D context unavailable");
    }
    return new TimelineCanvas2DRenderer(
      ctx,
      canvas,
      new ClipMediaPool(),
      clips,
    );
  }

  resizeCanvas(width: number, height: number): void {
    if (width > 0 && height > 0) {
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
    }
  }

  async renderTimelineFrame(
    clips: Clip[],
    groups: Parameters<typeof buildPreviewCompositionPlan>[1],
    transitions: Parameters<typeof buildPreviewCompositionPlan>[2],
    overlays: Parameters<typeof buildPreviewCompositionPlan>[3],
    settings: Parameters<typeof buildPreviewCompositionPlan>[4],
    globalTime: number,
    options?: TimelineRenderOptions,
  ): Promise<PreviewCompositionPlan> {
    this.syncClips(clips);
    const plan = buildPreviewCompositionPlan(
      clips,
      groups,
      transitions,
      overlays,
      settings,
      globalTime,
      options?.maxHeight,
      options?.maxWidth,
    );
    if (options?.isCancelled?.()) return plan;
    this.resizeCanvas(plan.canvasWidth, plan.canvasHeight);
    if (options?.isCancelled?.()) return plan;
    await this.renderPlan(plan, options);
    return plan;
  }

  async renderPlan(
    plan: PreviewCompositionPlan,
    options?: TimelineRenderOptions,
  ): Promise<void> {
    if (options?.isCancelled?.()) return;

    const frameSources = new Map<string, FrameSource>();
    const drawnClipIds = new Set<string>();

    for (const layer of plan.layers) {
      if (options?.isCancelled?.()) return;
      if (layer.kind === "text") continue;

      if (layer.mediaObjectUrl) {
        const video = this.mediaPool.getVideoForUrl(
          layer.clipId,
          layer.mediaObjectUrl,
        );
        const seekStart = performance.now();
        await seekVideoTo(video, layer.sourceTime);
        if (options?.isCancelled?.()) return;
        previewMetrics.recordSeek(performance.now() - seekStart);
        drawnClipIds.add(layer.clipId);
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;

        frameSources.set(layer.clipId, {
          image: video,
          width: video.videoWidth,
          height: video.videoHeight,
        });
        continue;
      }

      const clip = this.clipsById.get(layer.clipId);
      if (!clip || clip.kind !== "video") continue;

      if (clip.stillImage) {
        const img = this.mediaPool.getStillImage(clip);
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          });
        }
        if (img.naturalWidth <= 0) continue;
        drawnClipIds.add(layer.clipId);
        frameSources.set(layer.clipId, {
          image: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
        continue;
      }

      const video = this.mediaPool.getVideo(clip);
      const seekStart = performance.now();
      await seekVideoTo(video, layer.sourceTime);
      if (options?.isCancelled?.()) return;
      previewMetrics.recordSeek(performance.now() - seekStart);
      drawnClipIds.add(layer.clipId);
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;

      frameSources.set(layer.clipId, {
        image: video,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    }

    if (options?.isCancelled?.()) return;
    compositeFrame(this.ctx, plan, frameSources);

    // Cap live decoders, protecting the clips drawn this frame (those nearest
    // the playhead), and report pool occupancy for dev metrics.
    this.mediaPool.enforceBudget(drawnClipIds);
    previewMetrics.setDecoderCount(this.mediaPool.size, this.mediaPool.limit);
  }

  syncClips(clips: Clip[]): void {
    this.clipsById = new Map(clips.map((clip) => [clip.id, clip]));
    this.mediaPool.pruneExcept(new Set(clips.map((clip) => clip.id)));
  }

  pauseDecoders(): void {
    this.mediaPool.pauseAll();
  }

  destroy(): void {
    this.mediaPool.destroy();
  }
}
