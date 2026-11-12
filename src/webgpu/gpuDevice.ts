/**
 * Shared WebGPU device registry — one per JS realm.
 *
 * Every subsystem that needs a `GPUDevice` (live preview, GPU export, text
 * fill, LUT) previously called `navigator.gpu.requestAdapter()` /
 * `requestDevice()` independently, creating one physical GPU device per
 * subsystem. This module is the single place that owns adapter/device
 * acquisition, so every subsystem *in one realm* shares one device:
 *
 * - **main** — GPU export, text fill, the main-thread preview fallback, and
 *   the startup probe.
 * - **preview worker** — its own module instance, so its own device. Its
 *   losses and errors never reach main's listeners; the worker forwards them
 *   (`gpu-lost` / `gpu-error` messages) and main records them with
 *   {@link recordRemoteGpuError} so Copy Debug shows both realms.
 *
 *   const ctx = await acquireGpuContext();
 *   const pipeline = ctx.device.createRenderPipeline(...);
 *
 * It also centralizes the two things bare `requestDevice()` calls were
 * missing: `device.lost` handling (so a GPU-process crash doesn't require a
 * full page reload) and an `uncapturederror` hook (so GPU validation/OOM
 * errors show up in the debug report instead of only the browser console).
 *
 * Consumers must NOT call `device.destroy()` on the shared device — it is
 * owned by this module. Destroy only the buffers/textures/pipelines you
 * created. If you hold onto a `GpuContext` across an `await`, call
 * `ctx.ensure()` first to pick up a freshly-recreated device if the
 * previous one was lost in the meantime.
 */

import { installGpuProfiler, isGpuProfilingRequested } from './gpuProfiler';

export type GpuErrorType = 'validation' | 'out-of-memory' | 'internal' | 'lost';

/** Which JS realm's device an error came from. */
export type GpuRealm = 'main' | 'preview-worker';

export interface GpuErrorLogEntry {
  type: GpuErrorType;
  message: string;
  timestamp: number;
  /** Omitted for this realm's own entries (read as `main` on the main thread). */
  realm?: GpuRealm;
}

export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  /**
   * Optional GPU features actually adopted on this device (the subset of
   * {@link requestedOptionalFeatures} this adapter supports). Always check
   * `features.has(...)` before using a feature-gated code path — these are
   * best-effort and commonly absent on Safari/Firefox.
   */
  readonly features: Set<GPUFeatureName>;
  /**
   * The adapter is a software / CPU fallback (SwiftShader, WARP). Live
   * preview refuses it (`assertPreviewAdapter`) unless the page allows it.
   */
  readonly isFallbackAdapter: boolean;
  /** Returns this context if still live, otherwise acquires a fresh one. */
  ensure(): Promise<GpuContext>;
  /** Destroys the underlying device. Only call this if you truly own the app's GPU lifecycle (e.g. tests). */
  destroy(): void;
}

/** Device/queue labels so `about:gpu` and PIX-style captures read clearly. */
const GPU_DEVICE_LABEL = 'clip_stacker-preview';
const GPU_QUEUE_LABEL = 'clip_stacker-preview-queue';

/**
 * Limits we'd like beyond the WebGPU defaults, sized for up to 8K export
 * (7680×4320) and large 3D LUT textures. Each is clamped to what the
 * adapter actually reports — requesting more than `adapter.limits.<key>`
 * throws, so we never ask for more than the hardware advertises.
 */
const DESIRED_LIMITS: Record<string, number> = {
  maxTextureDimension2D: 16384,
  maxBufferSize: 512 * 1024 * 1024,
  maxStorageBufferBindingSize: 512 * 1024 * 1024,
  maxColorAttachmentBytesPerSample: 64,
};

/**
 * Optional features adopted when the adapter supports them, and otherwise
 * silently skipped — never passed as a hard requirement, so an adapter
 * missing one (Safari, Firefox, older Chrome) still boots. Only features a
 * code path reads are asked for: an enabled feature can cost the driver
 * (timestamp queries, for one, keep extra state per pass).
 *
 * - `shader-f16` — half-precision maths in the colour transform pass.
 * - `timestamp-query` — only under `?gpu_profile` (`requestGpuProfiling`).
 */
export function requestedOptionalFeatures(profiling = isGpuProfilingRequested()): GPUFeatureName[] {
  const features: GPUFeatureName[] = ['shader-f16' as GPUFeatureName];
  if (profiling) features.push('timestamp-query');
  return features;
}

/** `GPUAdapterInfo.isFallbackAdapter`, else the older `GPUAdapter.isFallbackAdapter`. */
export function adapterIsFallback(adapter: GPUAdapter): boolean {
  const withInfo = adapter as GPUAdapter & {
    info?: { isFallbackAdapter?: boolean };
    isFallbackAdapter?: boolean;
  };
  return Boolean(withInfo.info?.isFallbackAdapter ?? withInfo.isFallbackAdapter ?? false);
}

let fallbackAdapterAllowed = false;

/**
 * Let live preview run on a fallback adapter in this realm. Main resolves it
 * from `?test_harness` (the regression harness runs on SwiftShader) and
 * passes it to the preview worker.
 */
export function allowFallbackAdapterForPreview(allowed: boolean): void {
  fallbackAdapterAllowed = allowed;
}

export class FallbackAdapterError extends Error {
  constructor() {
    super(
      'WebGPU is running on a software fallback adapter, too slow for live preview. ' +
        'Enable hardware acceleration in the browser settings.',
    );
    this.name = 'FallbackAdapterError';
  }
}

/** Throws {@link FallbackAdapterError} when live preview would run on a fallback adapter. */
export function assertPreviewAdapter(ctx: Pick<GpuContext, 'isFallbackAdapter'>): void {
  if (ctx.isFallbackAdapter && !fallbackAdapterAllowed) throw new FallbackAdapterError();
}

/**
 * Device-loss recovery: each recreate waits 250 ms, 500 ms, … up to 4 s, and
 * after {@link MAX_DEVICE_RECOVERY_ATTEMPTS} attempts without a stable device
 * it stops and reports recovery failed. A device that lived
 * {@link STABLE_DEVICE_MS} resets the count.
 */
export const DEVICE_RECOVERY_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;
export const MAX_DEVICE_RECOVERY_ATTEMPTS = 5;
const STABLE_DEVICE_MS = 30_000;

function resolveRequiredLimits(adapter: GPUAdapter): Record<string, number> {
  const limits = adapter.limits as unknown as Record<string, number>;
  const required: Record<string, number> = {};
  for (const [key, desired] of Object.entries(DESIRED_LIMITS)) {
    const supported = limits[key];
    if (typeof supported === 'number') {
      required[key] = Math.min(desired, supported);
    }
  }
  return required;
}

function resolveOptionalFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  return requestedOptionalFeatures().filter((feature) => adapter.features.has(feature));
}

const MAX_ERROR_LOG = 20;
const errorLog: GpuErrorLogEntry[] = [];

type GpuErrorListener = (entry: GpuErrorLogEntry) => void;
const errorListeners = new Set<GpuErrorListener>();

function pushErrorLog(entry: GpuErrorLogEntry): void {
  errorLog.push(entry);
  if (errorLog.length > MAX_ERROR_LOG) errorLog.shift();
}

function recordGpuError(entry: GpuErrorLogEntry): void {
  pushErrorLog(entry);
  for (const listener of errorListeners) listener(entry);
}

/**
 * Log an error another realm's device reported (the preview worker forwards
 * its own). Listeners are not notified — they observe this realm's device.
 */
export function recordRemoteGpuError(entry: GpuErrorLogEntry & { realm: GpuRealm }): void {
  pushErrorLog(entry);
}

/** Notified for every error this realm's device records, device loss included. */
export function onGpuError(listener: GpuErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/** Recent GPU errors (uncaptured device errors + lost events, every realm), newest last. */
export function getGpuErrorLog(): GpuErrorLogEntry[] {
  return [...errorLog];
}

export function clearGpuErrorLog(): void {
  errorLog.length = 0;
}

type DeviceLostListener = (info: GPUDeviceLostInfo) => void;
type DeviceRecoveredListener = (ctx: GpuContext) => void;
type DeviceRecoveryFailedListener = (error: Error) => void;

const lostListeners = new Set<DeviceLostListener>();
const recoveredListeners = new Set<DeviceRecoveredListener>();
const recoveryFailedListeners = new Set<DeviceRecoveryFailedListener>();

/** Notified when the shared device is lost (e.g. GPU process crash, browser reclaim). */
export function onGpuDeviceLost(listener: DeviceLostListener): () => void {
  lostListeners.add(listener);
  return () => lostListeners.delete(listener);
}

/** Notified once the automatic recreate after a device loss succeeds. */
export function onGpuDeviceRecovered(listener: DeviceRecoveredListener): () => void {
  recoveredListeners.add(listener);
  return () => recoveredListeners.delete(listener);
}

/** Notified when the automatic recreate after a device loss fails — GPU work is over for now. */
export function onGpuDeviceRecoveryFailed(listener: DeviceRecoveryFailedListener): () => void {
  recoveryFailedListeners.add(listener);
  return () => recoveryFailedListeners.delete(listener);
}

let recoveryAttempts = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRecovery(): void {
  if (recoveryTimer !== null) return;
  if (recoveryAttempts >= MAX_DEVICE_RECOVERY_ATTEMPTS) {
    const error = new Error(
      `WebGPU device lost repeatedly; gave up after ${MAX_DEVICE_RECOVERY_ATTEMPTS} recovery attempts`,
    );
    for (const listener of recoveryFailedListeners) listener(error);
    return;
  }
  const delay =
    DEVICE_RECOVERY_BACKOFF_MS[Math.min(recoveryAttempts, DEVICE_RECOVERY_BACKOFF_MS.length - 1)]!;
  recoveryAttempts++;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    acquireGpuContext()
      .then((ctx) => {
        for (const listener of recoveredListeners) listener(ctx);
      })
      .catch(() => {
        // Try again after a longer wait, or report failure once capped.
        scheduleRecovery();
      });
  }, delay);
}

class GpuContextImpl implements GpuContext {
  private destroyed = false;
  private readonly createdAt = Date.now();

  constructor(
    readonly adapter: GPUAdapter,
    readonly device: GPUDevice,
    readonly format: GPUTextureFormat,
    readonly features: Set<GPUFeatureName>,
    readonly isFallbackAdapter: boolean,
  ) {
    void this.device.lost.then((info) => this.handleLost(info));
    this.device.onuncapturederror = (event) => {
      const error = event.error;
      const type: GpuErrorType =
        typeof GPUValidationError !== 'undefined' && error instanceof GPUValidationError
          ? 'validation'
          : typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError
            ? 'out-of-memory'
            : 'internal';
      recordGpuError({ type, message: error.message, timestamp: Date.now() });
    };
  }

  private handleLost(info: GPUDeviceLostInfo): void {
    // `reason === 'destroyed'` means we called destroy() ourselves — expected, not a crash.
    if (this.destroyed) return;

    recordGpuError({ type: 'lost', message: info.message, timestamp: Date.now() });
    if (current === this) current = null;
    for (const listener of lostListeners) listener(info);

    // Recreate automatically so an unexpected loss (GPU process crash,
    // driver reset) doesn't strand the app until a reload — with a backoff
    // and a cap, so a device that keeps dying is not recreated in a loop.
    // After the cap, the next acquireGpuContext() / ensure() still tries.
    if (Date.now() - this.createdAt >= STABLE_DEVICE_MS) recoveryAttempts = 0;
    scheduleRecovery();
  }

  async ensure(): Promise<GpuContext> {
    if (!this.destroyed && current === this) return this;
    return acquireGpuContext();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (current === this) current = null;
    this.device.destroy();
  }
}

let current: GpuContextImpl | null = null;
let pendingAcquire: Promise<GpuContext> | null = null;

/**
 * Acquire the shared `GpuContext`, creating the adapter/device on first
 * call. Concurrent callers during creation share the same in-flight
 * promise so a burst of `PreviewEngine.create()` / `TextFillRenderer.create()`
 * calls at startup never races into multiple devices.
 */
export async function acquireGpuContext(): Promise<GpuContext> {
  if (current) return current;
  if (pendingAcquire) return pendingAcquire;

  pendingAcquire = (async () => {
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU is not available in this browser');
    }
    const adapter = await takeAdapter();
    if (!adapter) throw new Error('No WebGPU adapter available');

    const optionalFeatures = resolveOptionalFeatures(adapter);
    const device = await adapter.requestDevice({
      requiredLimits: resolveRequiredLimits(adapter),
      requiredFeatures: optionalFeatures,
      label: GPU_DEVICE_LABEL,
      defaultQueue: { label: GPU_QUEUE_LABEL },
    });
    const format = navigator.gpu.getPreferredCanvasFormat();

    const ctx = new GpuContextImpl(
      adapter,
      device,
      format,
      new Set(optionalFeatures),
      adapterIsFallback(adapter),
    );
    current = ctx;
    installGpuProfiler(device);
    return ctx;
  })();

  try {
    return await pendingAcquire;
  } finally {
    pendingAcquire = null;
  }
}

let probedAdapter: Promise<GPUAdapter | null> | null = null;

function requestHighPerformanceAdapter(): Promise<GPUAdapter | null> {
  return navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
}

/**
 * The adapter for the next device: the one {@link probeGpuAdapter} found, if
 * it has not been used yet (an adapter makes one device), else a new one.
 */
async function takeAdapter(): Promise<GPUAdapter | null> {
  const probed = probedAdapter;
  probedAdapter = null;
  return (probed ? await probed.catch(() => null) : null) ?? requestHighPerformanceAdapter();
}

/**
 * Boot probe without a device: `requestAdapter` only. The main thread uses
 * this, so it holds no `GPUDevice` until the first export or text fill
 * actually needs one (the preview worker owns its own). The adapter is
 * kept for that first {@link acquireGpuContext}.
 */
export async function probeGpuAdapter(): Promise<GPUAdapter | null> {
  if (current) return current.adapter;
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new Error('WebGPU is not available in this browser');
  }
  probedAdapter ??= requestHighPerformanceAdapter();
  return probedAdapter;
}

/** Whether a shared device currently exists (without allocating one). */
export function hasGpuContext(): boolean {
  return current !== null;
}

/**
 * Return the shared `GPUDevice` if this JS realm already acquired one.
 * Never calls `requestAdapter` / `requestDevice`.
 */
export function peekGpuDevice(): GPUDevice | null {
  return current?.device ?? null;
}

/** Optional GPU features adopted on the shared device, for diagnostics (Copy Debug). */
export function peekGpuFeatures(): Set<GPUFeatureName> | null {
  return current?.features ?? null;
}

/** Test/dev-only: force the singleton to forget its current device. */
export function __resetGpuContextForTests(): void {
  current = null;
  pendingAcquire = null;
  probedAdapter = null;
  recoveryAttempts = 0;
  if (recoveryTimer !== null) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  fallbackAdapterAllowed = false;
  errorLog.length = 0;
  errorListeners.clear();
  lostListeners.clear();
  recoveredListeners.clear();
  recoveryFailedListeners.clear();
}
