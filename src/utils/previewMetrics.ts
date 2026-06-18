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
  private lastLogAt = 0;

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

  snapshot(): PreviewMetricsSnapshot {
    return {
      avgFrameMs: average(this.frameSamples),
      lastFrameMs: this.lastFrameMs,
      avgSeekMs: average(this.seekSamples),
      lastSeekMs: this.lastSeekMs,
      decoderCount: this.decoderCount,
      decoderLimit: this.decoderLimit,
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
    this.lastLogAt = 0;
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
    // eslint-disable-next-line no-console
    console.debug(
      `[preview] frame ${s.avgFrameMs.toFixed(1)}ms · seek ${s.avgSeekMs.toFixed(
        1,
      )}ms · decoders ${s.decoderCount}/${s.decoderLimit}`,
    );
  }
}

/** Process-wide collector shared by the compositors and the preview UI. */
export const previewMetrics = new PreviewMetrics();
