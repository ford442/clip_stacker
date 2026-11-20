/**
 * RAM preview: composed preview frames kept on the GPU, keyed by the same
 * content key as the render cache (`export/renderKey.ts`), so playback over
 * frames that were already drawn presents them instead of decoding and
 * compositing again — a heavy stack (NLM denoise, bloom, keys) plays in real
 * time once rendered.
 *
 * Lives in the preview worker beside its compositor. A store copies the
 * swapchain texture (the canvas is `COPY_SRC`) into a private texture; a hit
 * draws it back with a `textureLoad` blit (`shaders/frameBlit.wgsl`), so the
 * presented pixels are exactly the stored ones. Both must run in the task
 * that drew / presents the frame, like the scopes' copy.
 *
 * What the key covers is what the worker draws: the video composite and
 * finishing. Titles and captions are drawn by main on the overlay canvas
 * above it, so they are not part of a preview key (editing one never
 * invalidates the ring). Temporal noise reduction makes a frame depend on
 * the frames before it, so with it on nothing is cached.
 */

import type { Clip } from '../types';
import type { PreviewCompositionPlan } from '../composition/previewCompositionTypes';
import { isGrainActive, type FinishingSettings } from '../finishing/finishing';
import type { ColorManagementSettings } from '../finishing/colorManagement';
import { grainFrameSeedFromTime } from '../finishing/grain';
import { finishingIsTemporal, frameKey, renderSettingsHash } from '../export/renderKey';
import frameBlitShader from './shaders/frameBlit.wgsl?raw';

export const FRAME_BLIT_SHADER: string = frameBlitShader;


const MB = 1024 ** 2;

/**
 * GPU memory the ring may hold: the device's `maxBufferSize` (a rough proxy
 * for its memory class — `gpuDevice.ts` asks for up to 512 MiB, weak
 * adapters grant 256 MiB), clamped to 192 MiB … 1 GiB and to at least 60
 * frames of this canvas size.
 */
export function previewCacheBudgetBytes(
  limits: Pick<GPUSupportedLimits, 'maxBufferSize'> | null | undefined,
  width: number,
  height: number,
): number {
  const frame = Math.max(1, width * height * 4);
  const fromAdapter = limits?.maxBufferSize ?? 256 * MB;
  const clamped = Math.min(1024 * MB, Math.max(192 * MB, fromAdapter));
  return Math.max(clamped, frame * 60);
}

/** A byte-budgeted LRU map (most recently used last). Pure; the GPU cache's bookkeeping. */
export class FrameLru<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private total = 0;

  constructor(
    private budget: number,
    private readonly dispose: (value: T) => void,
  ) {}

  get bytes(): number {
    return this.total;
  }

  get budgetBytes(): number {
    return this.budget;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The value, marked most recently used. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    if (bytes > this.budget) {
      this.dispose(value);
      return;
    }
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
    this.dispose(entry.value);
  }

  setBudget(budget: number): void {
    this.budget = budget;
    this.evict();
  }

  clear(): void {
    for (const { value } of this.entries.values()) this.dispose(value);
    this.entries.clear();
    this.total = 0;
  }

  /** Entries, least recently used first. */
  *values(): IterableIterator<[string, T]> {
    for (const [key, entry] of this.entries) yield [key, entry.value];
  }

  private evict(): void {
    for (const key of this.entries.keys()) {
      if (this.total <= this.budget) break;
      this.delete(key);
    }
  }
}

export interface PreviewFrameKeyInput {
  plan: PreviewCompositionPlan;
  clipsById: ReadonlyMap<string, Clip>;
  mediaKey: (clip: Clip) => string | null;
  finishing: FinishingSettings | undefined;
  colorManagement: ColorManagementSettings | undefined;
  /** An HDR10 project on an HDR display previews on another canvas format. */
  displayHdr: boolean;
  buildId: string;
}

/**
 * Key of what the worker draws for `plan` (video layers + finishing), or
 * null when it cannot be cached (temporal noise reduction, an uncacheable
 * layer). Key the quantized plan you render.
 */
export function previewFrameKey(input: PreviewFrameKeyInput): string | null {
  if (finishingIsTemporal(input.finishing)) return null;
  const { plan } = input;
  const video: PreviewCompositionPlan = {
    ...plan,
    layers: plan.layers.filter((layer) => layer.kind === 'base' || layer.kind === 'pip'),
  };
  const settingsHash = renderSettingsHash({
    finishing: input.finishing,
    colorManagement: input.colorManagement,
    width: plan.canvasWidth,
    height: plan.canvasHeight,
    buildId: `${input.buildId}:preview:${input.displayHdr ? 'hdr' : 'sdr'}`,
  });
  return frameKey(video, {
    clipsById: input.clipsById,
    mediaKey: input.mediaKey,
    settingsHash,
    grainSeed: isGrainActive(input.finishing?.grain) ? grainFrameSeedFromTime(plan.globalTime) : null,
  }).key;
}

interface CachedFrame {
  texture: GPUTexture;
  /** Output frame number it was drawn for (on the `PREVIEW_CACHE_FPS` grid). */
  frame: number;
}

export interface PreviewFrameCacheStats {
  entries: number;
  bytes: number;
  budgetBytes: number;
}

export class PreviewFrameCache {
  private readonly lru: FrameLru<CachedFrame>;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private module: GPUShaderModule | null = null;

  constructor(
    private readonly device: GPUDevice,
    budgetBytes: number,
  ) {
    this.lru = new FrameLru<CachedFrame>(budgetBytes, (entry) => entry.texture.destroy());
  }

  has(key: string): boolean {
    return this.lru.has(key);
  }

  stats(): PreviewFrameCacheStats {
    return { entries: this.lru.size, bytes: this.lru.bytes, budgetBytes: this.lru.budgetBytes };
  }

  /** `[key, frame number]` of every cached frame. */
  frames(): Array<[string, number]> {
    return [...this.lru.values()].map(([key, entry]) => [key, entry.frame]);
  }

  setBudget(budgetBytes: number): void {
    this.lru.setBudget(budgetBytes);
  }

  /** Copy the just-drawn swapchain texture under `key`. False when it is already gone. */
  store(key: string, frame: number, source: GPUTexture): boolean {
    const { width, height, format } = source;
    const texture = this.device.createTexture({
      size: { width, height },
      format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: source }, { texture }, { width, height });
      this.device.queue.submit([encoder.finish()]);
    } catch {
      texture.destroy();
      return false;
    }
    this.lru.set(key, { texture, frame }, width * height * bytesPerTexel(format));
    return true;
  }

  /** Draw the frame cached under `key` onto `target`. False on a miss or a size change. */
  present(key: string, target: GPUTexture): boolean {
    const entry = this.lru.get(key);
    if (!entry) return false;
    if (entry.texture.width !== target.width || entry.texture.height !== target.height || entry.texture.format !== target.format) {
      this.lru.delete(key);
      return false;
    }
    const pipeline = this.pipelineFor(target.format);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: entry.texture.createView() }],
      }),
    );
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  clear(): void {
    this.lru.clear();
  }

  destroy(): void {
    this.lru.clear();
    this.pipelines.clear();
    this.module = null;
  }

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      this.module ??= this.device.createShaderModule({ code: FRAME_BLIT_SHADER, label: 'frameBlit.wgsl' });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs_main' },
        fragment: { module: this.module, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(format, pipeline);
    }
    return pipeline;
  }
}

function bytesPerTexel(format: GPUTextureFormat): number {
  return format === 'rgba16float' ? 8 : format === 'rgba32float' ? 16 : 4;
}
