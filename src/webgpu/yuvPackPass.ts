/**
 * GPU side of `finishing/yuvPack.ts`: one compute dispatch that packs an
 * encoded R'G'B' texture into planar I420 / I420P10 in a storage buffer.
 * The buffer and bind group are kept until the frame size or the source
 * texture changes, so a steady export allocates nothing per frame.
 */

import shader from './shaders/yuvPack.wgsl?raw';
import {
  i420Layout,
  YUV_PACK_MODE_ID,
  type I420Layout,
  type YuvPackMode,
} from '../finishing/yuvPack';

const WORKGROUP_SIZE = 64;
const MAX_WORKGROUPS_PER_DIM = 65535;
const UNIFORM_WORDS = 8;

/** Workgroup grid for `wordCount` words (2D once one dimension would overflow). */
export function yuvPackDispatchSize(wordCount: number): [number, number] {
  const groups = Math.ceil(wordCount / WORKGROUP_SIZE);
  if (groups <= MAX_WORKGROUPS_PER_DIM) return [Math.max(1, groups), 1];
  return [MAX_WORKGROUPS_PER_DIM, Math.ceil(groups / MAX_WORKGROUPS_PER_DIM)];
}

export function packYuvUniforms(layout: I420Layout, mode: YuvPackMode): Uint32Array<ArrayBuffer> {
  return new Uint32Array([
    layout.width,
    layout.height,
    layout.chromaWidth,
    layout.chromaHeight,
    layout.totalSamples,
    layout.bufferBytes / 4,
    YUV_PACK_MODE_ID[mode],
    0,
  ]);
}

export class YuvPackPass {
  private output: GPUBuffer | null = null;
  private outputLayout: I420Layout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private boundTexture: GPUTexture | null = null;

  private constructor(
    private readonly pipeline: GPUComputePipeline,
    private readonly uniformBuffer: GPUBuffer,
    readonly mode: YuvPackMode,
  ) {}

  static create(device: GPUDevice, mode: YuvPackMode): YuvPackPass {
    const module = device.createShaderModule({ code: shader });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const uniformBuffer = device.createBuffer({
      size: UNIFORM_WORDS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return new YuvPackPass(pipeline, uniformBuffer, mode);
  }

  /** Layout of the last packed frame. */
  get layout(): I420Layout | null {
    return this.outputLayout;
  }

  /**
   * Record the pack of `source` (encoded R'G'B', same size as the frame) into
   * `encoder`. Returns the storage buffer holding the planes (owned by the
   * pass; valid until the next `encode` with another size).
   */
  encode(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    source: GPUTexture,
  ): { buffer: GPUBuffer; layout: I420Layout } {
    const layout = this.ensureOutput(device, source.width, source.height);
    if (this.boundTexture !== source || !this.bindGroup) {
      this.bindGroup = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: { buffer: this.output! } },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      });
      this.boundTexture = source;
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    const [x, y] = yuvPackDispatchSize(layout.bufferBytes / 4);
    pass.dispatchWorkgroups(x, y);
    pass.end();
    return { buffer: this.output!, layout };
  }

  private ensureOutput(device: GPUDevice, width: number, height: number): I420Layout {
    const current = this.outputLayout;
    if (this.output && current && current.width === width && current.height === height) {
      return current;
    }
    const layout = i420Layout(width, height, this.mode);
    this.output?.destroy();
    this.output = device.createBuffer({
      size: layout.bufferBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.outputLayout = layout;
    this.bindGroup = null;
    device.queue.writeBuffer(this.uniformBuffer, 0, packYuvUniforms(layout, this.mode));
    return layout;
  }

  destroy(): void {
    this.output?.destroy();
    this.output = null;
    this.outputLayout = null;
    this.bindGroup = null;
    this.boundTexture = null;
    this.uniformBuffer.destroy();
  }
}
