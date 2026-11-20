/**
 * Dev-only performance metrics for the live timeline preview.
 *
 * Collects frame render time, seek latency, and live decoder-pool occupancy so
 * regressions in scrub/playback smoothness are observable. A throttled console
 * line is emitted only under `import.meta.env.DEV`; in production the recorders
 * are cheap no-op-ish updates and nothing is logged.
 */

/** How many recent samples feed the rolling averages. */
const SAMPLE_WINDOW = 30;
/** Minimum gap between dev console lines (ms). */
const LOG_THROTTLE_MS = 1000;

function rollingPush(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > SAMPLE_WINDOW) samples.shift();
}

function average(samples: number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

export interface PreviewMetricsSnapshot {
  /** Rolling-average frame render time (ms). */
  avgFrameMs: number;
  /** Most recent frame render time (ms). */
  lastFrameMs: number;
  /** Rolling-average seek latency (ms). */
  avgSeekMs: number;
  /** Most recent seek latency (ms). */
  lastSeekMs: number;
  /** Live decoders held by the media pool. */
  decoderCount: number;
  /** Configured decoder cap (for context in the log line). */
  decoderLimit: number;
  /** Layers of the last frame served by the in-worker VideoDecoder. */
  decoderSourcedLayers: number;
  /** Layers of the last frame that still needed an `<video>` seek on main. */
  elementSourcedLayers: number;
  /** Layers of the last frame read from a preview proxy (either path). */
  proxySourcedLayers: number;
  /** Layers of the last frame read from the full-res original (either path). */
  originalSourcedLayers: number;
  /**
   * `?gpu_profile`: averaged GPU milliseconds per pass of the preview
   * (compositor, transition, each finishing pass). Empty when off.
   */
  gpuPassMs: Record<string, number>;
  /** RAM preview: frames presented from the cache since the last reset. */
  cacheHits: number;
  /** RAM preview: frames drawn and stored. */
  cacheMisses: number;
  /**
   * Frames skipped during playback (on the 30 fps grid) since playback last
   * started: a frame slot that passed with no frame presented for it.
   */
  droppedFrames: number;
  /** Frames presented during the current / last playback. */
  playedFrames: number;
}

/** Returns true when running under Vite's dev flag (guarded for non-Vite envs). */
function isDev(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

export class PreviewMetrics {
  private frameSamples: number[] = [];
  private seekSamples: number[] = [];
  private lastFrameMs = 0;
  private lastSeekMs = 0;
  private decoderCount = 0;
  private decoderLimit = 0;
  private decoderSourcedLayers = 0;
  private elementSourcedLayers = 0;
  private proxySourcedLayers = 0;
  private gpuPassMs: Record<string, number> = {};
  private lastLogAt = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private droppedFrames = 0;
  private playedFrames = 0;
  private lastPlayedFrame: number | null = null;

  recordFrame(ms: number): void {
    this.lastFrameMs = ms;
    rollingPush(this.frameSamples, ms);
  }

  recordSeek(ms: number): void {
    this.lastSeekMs = ms;
    rollingPush(this.seekSamples, ms);
  }

  setDecoderCount(count: number, limit?: number): void {
    this.decoderCount = count;
    if (typeof limit === "number") this.decoderLimit = limit;
  }

  /**
   * Record how the last rendered frame's layers were sourced. The happy path
   * is `element === 0` — no `HTMLVideoElement.currentTime` during scrub.
   * `proxy` counts the layers (of both) read from a preview proxy, so a scrub
   * that silently decoded the full-res file shows up as `original > 0`.
   */
  setFrameSources(sources: { decoder: number; element: number; proxy?: number }): void {
    this.decoderSourcedLayers = sources.decoder;
    this.elementSourcedLayers = sources.element;
    this.proxySourcedLayers = Math.min(sources.proxy ?? 0, sources.decoder + sources.element);
  }

  /** How the last frame used the RAM preview (`'off'`: not cacheable / disabled). */
  recordCacheResult(result: 'hit' | 'miss' | 'off'): void {
    if (result === 'hit') this.cacheHits += 1;
    else if (result === 'miss') this.cacheMisses += 1;
  }

  /** Playback (re)started: count drops from here. */
  startPlayback(): void {
    this.droppedFrames = 0;
    this.playedFrames = 0;
    this.lastPlayedFrame = null;
  }

  /**
   * A frame was presented during playback: `frame` is its number on the
   * 30 fps grid. Slots skipped since the previous one count as dropped.
   */
  recordPlayedFrame(frame: number): void {
    if (this.lastPlayedFrame !== null && frame > this.lastPlayedFrame + 1) {
      this.droppedFrames += frame - this.lastPlayedFrame - 1;
    }
    if (this.lastPlayedFrame === null || frame > this.lastPlayedFrame) {
      this.playedFrames += 1;
      this.lastPlayedFrame = frame;
    }
  }

  /** The preview realm's GPU timings (`gpuProfiler` snapshot). */
  setGpuProfile(passMs: Record<string, number>): void {
    this.gpuPassMs = { ...passMs };
  }

  snapshot(): PreviewMetricsSnapshot {
    return {
      avgFrameMs: average(this.frameSamples),
      lastFrameMs: this.lastFrameMs,
      avgSeekMs: average(this.seekSamples),
      lastSeekMs: this.lastSeekMs,
      decoderCount: this.decoderCount,
      decoderLimit: this.decoderLimit,
      decoderSourcedLayers: this.decoderSourcedLayers,
      elementSourcedLayers: this.elementSourcedLayers,
      proxySourcedLayers: this.proxySourcedLayers,
      originalSourcedLayers:
        this.decoderSourcedLayers + this.elementSourcedLayers - this.proxySourcedLayers,
      gpuPassMs: { ...this.gpuPassMs },
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      droppedFrames: this.droppedFrames,
      playedFrames: this.playedFrames,
    };
  }

  /** Reset all collected samples (used in tests). */
  reset(): void {
    this.frameSamples = [];
    this.seekSamples = [];
    this.lastFrameMs = 0;
    this.lastSeekMs = 0;
    this.decoderCount = 0;
    this.decoderLimit = 0;
    this.decoderSourcedLayers = 0;
    this.elementSourcedLayers = 0;
    this.proxySourcedLayers = 0;
    this.gpuPassMs = {};
    this.lastLogAt = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.startPlayback();
  }

  /**
   * Emit a throttled dev-only console line. No-op outside dev or within the
   * throttle window. `now` is injectable for tests.
   */
  maybeLog(now: number = performance.now()): void {
    if (!isDev()) return;
    if (now - this.lastLogAt < LOG_THROTTLE_MS) return;
    this.lastLogAt = now;
    const s = this.snapshot();
    console.debug(
      `[preview] frame ${s.avgFrameMs.toFixed(1)}ms · seek ${s.avgSeekMs.toFixed(
        1,
      )}ms · decoders ${s.decoderCount}/${s.decoderLimit} · layers ${s.decoderSourcedLayers} decoded / ${s.elementSourcedLayers} seeked · ${s.proxySourcedLayers} proxy / ${s.originalSourcedLayers} original`,
    );
  }
}

/** Process-wide collector shared by the compositors and the preview UI. */
export const previewMetrics = new PreviewMetrics();
