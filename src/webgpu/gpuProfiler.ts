/**
 * `?gpu_profile`: GPU time per finishing pass, compositor, transition and
 * export readback, from `timestamp-query`.
 *
 * A span is two timestamps, each written by an empty compute pass with
 * `timestampWrites` in the encoder that does the work — so no pass class has
 * to know about profiling, and a disabled profiler costs one null check.
 * After each frame `endFrame()` resolves the used queries into a buffer and
 * reads it back through a small ring (a frame is skipped when every slot is
 * still mapping, never stalled); durations feed an exponential moving
 * average per label. Chrome quantizes timestamps to 100 µs unless the WebGPU
 * developer features flag is on, which is plenty for "bloom 1.8 ms".
 *
 * One profiler per realm (the preview worker posts its snapshot to main).
 */

const MAX_SPANS_PER_FRAME = 48;
const QUERY_COUNT = MAX_SPANS_PER_FRAME * 2;
const READBACK_SLOTS = 3;
/** Weight of the newest frame in the moving average. */
const EMA_ALPHA = 0.2;

export type GpuProfileSnapshot = Record<string, number>;

interface PendingSpan {
  label: string;
  begin: number;
  end: number;
}

interface ReadbackSlot {
  buffer: GPUBuffer;
  busy: boolean;
}

let profilingRequested = false;
let active: GpuProfiler | null = null;
const listeners = new Set<(snapshot: GpuProfileSnapshot) => void>();

/** Ask for `timestamp-query` on this realm's device (call before the first acquire). */
export function requestGpuProfiling(on: boolean): void {
  profilingRequested = on;
}

export function isGpuProfilingRequested(): boolean {
  return profilingRequested;
}

/**
 * Called by the device registry once a device exists: builds the profiler
 * when profiling was requested and the device adopted `timestamp-query`.
 */
export function installGpuProfiler(device: GPUDevice): void {
  active?.destroy();
  active = null;
  if (!profilingRequested) return;
  if (!device.features?.has?.('timestamp-query')) return;
  try {
    active = new GpuProfiler(device);
  } catch {
    active = null;
  }
}

/** The realm's profiler for `device`, or null when profiling is off. */
export function gpuProfilerFor(device: GPUDevice | null | undefined): GpuProfiler | null {
  return active && device && active.device === device ? active : null;
}

/** Notified with the averaged per-label milliseconds after each read-back frame. */
export function onGpuProfile(listener: (snapshot: GpuProfileSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current averages (empty when profiling is off or nothing ran yet). */
export function getGpuProfileSnapshot(): GpuProfileSnapshot {
  return active ? active.snapshot() : {};
}

/** "bloom 1.8 ms · NR nlm 6.2 ms", slowest first. */
export function formatGpuProfile(snapshot: GpuProfileSnapshot, limit = Infinity): string {
  return Object.entries(snapshot)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, ms]) => `${label} ${ms.toFixed(1)} ms`)
    .join(' · ');
}

/** Exponential moving average of `next` into `previous` (first sample taken as is). */
export function blendProfileSample(previous: number | undefined, next: number): number {
  return previous === undefined ? next : previous + (next - previous) * EMA_ALPHA;
}

/** Span durations (ms) from resolved nanosecond timestamps; repeats of a label add up. */
export function spanDurationsMs(
  spans: readonly PendingSpan[],
  timestamps: BigInt64Array | BigUint64Array,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const span of spans) {
    const begin = timestamps[span.begin];
    const end = timestamps[span.end];
    if (begin === undefined || end === undefined) continue;
    const ns = Number(end - begin);
    // A reset or quantized-to-zero timestamp pair reads as 0 or negative.
    if (!(ns >= 0) || !Number.isFinite(ns)) continue;
    out[span.label] = (out[span.label] ?? 0) + ns / 1e6;
  }
  return out;
}

export class GpuProfiler {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly slots: ReadbackSlot[];
  private spans: PendingSpan[] = [];
  private nextQuery = 0;
  private readonly averages = new Map<string, number>();
  private destroyed = false;

  constructor(readonly device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_COUNT });
    this.resolveBuffer = device.createBuffer({
      size: QUERY_COUNT * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.slots = Array.from({ length: READBACK_SLOTS }, () => ({
      buffer: device.createBuffer({
        size: QUERY_COUNT * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      busy: false,
    }));
  }

  /** Start a span in `encoder`; pass the handle to {@link end}. Null when the frame is full. */
  begin(encoder: GPUCommandEncoder, label: string): number | null {
    if (this.destroyed || this.nextQuery + 2 > QUERY_COUNT) return null;
    const begin = this.nextQuery;
    this.spans.push({ label, begin, end: begin + 1 });
    this.nextQuery += 2;
    this.mark(encoder, begin);
    return this.spans.length - 1;
  }

  end(encoder: GPUCommandEncoder, handle: number | null): void {
    if (handle === null || this.destroyed) return;
    const span = this.spans[handle];
    if (span) this.mark(encoder, span.end);
  }

  /** Time `record` (which encodes into `encoder`) as `label`. */
  span<T>(encoder: GPUCommandEncoder, label: string, record: () => T): T {
    const handle = this.begin(encoder, label);
    try {
      return record();
    } finally {
      this.end(encoder, handle);
    }
  }

  /**
   * Resolve this frame's spans and read them back. Call after the frame's
   * last submit; the next frame's spans start fresh.
   */
  endFrame(): void {
    if (this.destroyed || this.spans.length === 0) return;
    const spans = this.spans;
    const count = this.nextQuery;
    this.spans = [];
    this.nextQuery = 0;
    const slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) return;
    const encoder = this.device.createCommandEncoder();
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, count * 8);
    this.device.queue.submit([encoder.finish()]);
    slot.busy = true;
    void slot.buffer
      .mapAsync(GPUMapMode.READ, 0, count * 8)
      .then(() => {
        const timestamps = new BigUint64Array(slot.buffer.getMappedRange(0, count * 8).slice(0));
        slot.buffer.unmap();
        this.record(spanDurationsMs(spans, timestamps));
      })
      .catch(() => {
        // Device lost or destroyed mid-map: drop this frame's numbers.
      })
      .finally(() => {
        slot.busy = false;
      });
  }

  snapshot(): GpuProfileSnapshot {
    return Object.fromEntries(this.averages);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    for (const slot of this.slots) slot.buffer.destroy();
  }

  private mark(encoder: GPUCommandEncoder, queryIndex: number): void {
    const pass = encoder.beginComputePass({
      timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: queryIndex },
    });
    pass.end();
  }

  private record(durations: Record<string, number>): void {
    for (const [label, ms] of Object.entries(durations)) {
      this.averages.set(label, blendProfileSample(this.averages.get(label), ms));
    }
    const snapshot = this.snapshot();
    for (const listener of listeners) listener(snapshot);
  }
}

/** Test-only: forget the realm's profiler and listeners. */
export function __resetGpuProfilerForTests(): void {
  active?.destroy();
  active = null;
  profilingRequested = false;
  listeners.clear();
}
