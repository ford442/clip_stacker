/**
 * Shared WebGPU device registry.
 *
 * Every subsystem that needs a `GPUDevice` (live preview, GPU export, text
 * fill, LUT) previously called `navigator.gpu.requestAdapter()` /
 * `requestDevice()` independently, creating one physical GPU device per
 * subsystem. This module is the single place that owns adapter/device
 * acquisition so the whole app shares one device under typical use:
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

export type GpuErrorType = 'validation' | 'out-of-memory' | 'internal' | 'lost';

export interface GpuErrorLogEntry {
  type: GpuErrorType;
  message: string;
  timestamp: number;
}

export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  /**
   * Optional GPU features actually adopted on this device (subset of
   * {@link DESIRED_OPTIONAL_FEATURES} that this adapter supports). Always
   * check `features.has(...)` before using a feature-gated code path —
   * these are best-effort and commonly absent on Safari/Firefox.
   */
  readonly features: Set<GPUFeatureName>;
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
 * missing one (Safari, Firefox, older Chrome) still boots. Callers check
 * `GpuContext.features` before relying on any of these.
 */
const DESIRED_OPTIONAL_FEATURES: GPUFeatureName[] = [
  'timestamp-query',
  'float32-filterable',
  'bgra8unorm-storage',
  'rg11b10ufloat-renderable',
  'dual-source-blending',
];

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
  return DESIRED_OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));
}

const MAX_ERROR_LOG = 20;
const errorLog: GpuErrorLogEntry[] = [];

function recordGpuError(entry: GpuErrorLogEntry): void {
  errorLog.push(entry);
  if (errorLog.length > MAX_ERROR_LOG) errorLog.shift();
}

/** Recent GPU errors (uncaptured device errors + lost events), newest last. */
export function getGpuErrorLog(): GpuErrorLogEntry[] {
  return [...errorLog];
}

export function clearGpuErrorLog(): void {
  errorLog.length = 0;
}

type DeviceLostListener = (info: GPUDeviceLostInfo) => void;
type DeviceRecoveredListener = (ctx: GpuContext) => void;

const lostListeners = new Set<DeviceLostListener>();
const recoveredListeners = new Set<DeviceRecoveredListener>();

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

class GpuContextImpl implements GpuContext {
  private destroyed = false;

  constructor(
    readonly adapter: GPUAdapter,
    readonly device: GPUDevice,
    readonly format: GPUTextureFormat,
    readonly features: Set<GPUFeatureName>,
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

    // Attempt exactly one automatic recreate so an unexpected loss (GPU
    // process crash, driver reset) doesn't strand the app until a full
    // page reload. If this also fails, callers see it the next time they
    // call acquireGpuContext()/ensure() and get a rejected promise.
    void acquireGpuContext()
      .then((ctx) => {
        for (const listener of recoveredListeners) listener(ctx);
      })
      .catch(() => {
        // Nothing we can do automatically beyond this; surfaced to the next caller.
      });
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
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) throw new Error('No WebGPU adapter available');

    const optionalFeatures = resolveOptionalFeatures(adapter);
    const device = await adapter.requestDevice({
      requiredLimits: resolveRequiredLimits(adapter),
      requiredFeatures: optionalFeatures,
      label: GPU_DEVICE_LABEL,
      defaultQueue: { label: GPU_QUEUE_LABEL },
    });
    const format = navigator.gpu.getPreferredCanvasFormat();

    const ctx = new GpuContextImpl(adapter, device, format, new Set(optionalFeatures));
    current = ctx;
    return ctx;
  })();

  try {
    return await pendingAcquire;
  } finally {
    pendingAcquire = null;
  }
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
  errorLog.length = 0;
  lostListeners.clear();
  recoveredListeners.clear();
}
