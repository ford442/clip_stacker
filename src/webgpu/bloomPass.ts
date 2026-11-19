/**
 * Bloom / glow / light wrap — finishing pass after chromatic aberration,
 * before grain. A prefilter → downsample pyramid → additive tent upsample →
 * composite chain over rgba16float levels (see `finishing/bloom.ts` for the
 * model). Every draw shares one command encoder with the rest of the chain.
 */

import bloomShaderSource from './shaders/bloom.wgsl?raw';
import { shaderForSceneLinear } from '../finishing/colorManagement';
import type { BloomPass } from '../finishing/finishing';
import {
  BLOOM_UNIFORM_FLOATS,
  bloomLevelChain,
  isBloomNeutral,
  packBloomUniforms,
  planBloom,
  type BloomLevelSize,
} from '../finishing/bloom';
import { spliceUniformStructs } from './uniformLayout';
import { BLOOM_UNIFORMS } from './uniformSpecs';

const BLOOM_SOURCE = spliceUniformStructs(bloomShaderSource, BLOOM_UNIFORMS);

/** `bloom.wgsl` as compiled: its uniform struct spliced in, scene-linear when asked. */
export function bloomShaderCode(sceneLinear = false): string {
  return shaderForSceneLinear(BLOOM_SOURCE, sceneLinear);
}

const LEVEL_FORMAT: GPUTextureFormat = 'rgba16float';

export class BloomGpuPass {
  private readonly prefilter: GPURenderPipeline;
  private readonly down: GPURenderPipeline;
  private readonly up: GPURenderPipeline;
  private readonly composite: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffers: GPUBuffer[] = [];
  private readonly uniformData = new Float32Array(BLOOM_UNIFORM_FLOATS);
  private levels: GPUTexture[] = [];
  private levelKey = '';

  private constructor(
    prefilter: GPURenderPipeline,
    down: GPURenderPipeline,
    up: GPURenderPipeline,
    composite: GPURenderPipeline,
    sampler: GPUSampler,
  ) {
    this.prefilter = prefilter;
    this.down = down;
    this.up = up;
    this.composite = composite;
    this.sampler = sampler;
  }

  static create(device: GPUDevice, format: GPUTextureFormat, sceneLinear = false): BloomGpuPass {
    const module = device.createShaderModule({
      code: bloomShaderCode(sceneLinear),
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const common: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ];
    const levelLayout = device.createPipelineLayout({
      bindGroupLayouts: [device.createBindGroupLayout({ entries: common })],
    });
    const compositeLayout = device.createPipelineLayout({
      bindGroupLayouts: [
        device.createBindGroupLayout({
          entries: [
            ...common,
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          ],
        }),
      ],
    });
    const pipeline = (
      entryPoint: string,
      layout: GPUPipelineLayout,
      target: GPUColorTargetState,
    ) =>
      device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint, targets: [target] },
        primitive: { topology: 'triangle-list' },
      });
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    return new BloomGpuPass(
      pipeline('fs_prefilter', levelLayout, { format: LEVEL_FORMAT }),
      pipeline('fs_down', levelLayout, { format: LEVEL_FORMAT }),
      pipeline('fs_up', levelLayout, { format: LEVEL_FORMAT, blend: additive }),
      pipeline('fs_composite', compositeLayout, { format }),
      sampler,
    );
  }

  /** Run bloom from `inputTexture` into `outputView` (both `width` × `height`). */
  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: BloomPass,
    commandEncoder?: GPUCommandEncoder,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (isBloomNeutral(settings)) return;

    const plan = planBloom(settings.radius, width, height);
    this.ensureLevels(device, width, height);
    const encoder = commandEncoder ?? device.createCommandEncoder();
    let draw = 0;
    const run = (
      pipelineToUse: GPURenderPipeline,
      src: GPUTexture,
      srcSize: BloomLevelSize,
      target: GPUTextureView,
      load: GPULoadOp,
      weight: number,
      base?: GPUTexture,
    ) => {
      const buffer = this.uniformBuffer(device, draw++);
      packBloomUniforms(settings, srcSize.width, srcSize.height, weight, plan.norm, this.uniformData);
      device.queue.writeBuffer(buffer, 0, this.uniformData);
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: src.createView() },
        { binding: 2, resource: { buffer } },
      ];
      if (base) entries.push({ binding: 3, resource: base.createView() });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: target, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      pass.setPipeline(pipelineToUse);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: pipelineToUse.getBindGroupLayout(0), entries }),
      );
      pass.draw(6);
      pass.end();
    };

    const level = (k: number): { texture: GPUTexture; size: BloomLevelSize } => {
      const texture = this.levels[k];
      const size = plan.sizes[k];
      if (!texture || !size) throw new Error(`bloom level ${k} is not allocated`);
      return { texture, size };
    };
    const last = plan.sizes.length - 1;
    const top = level(0);
    run(this.prefilter, inputTexture, { width, height }, top.texture.createView(), 'clear', 1);
    for (let k = 1; k <= last; k++) {
      const src = level(k - 1);
      run(this.down, src.texture, src.size, level(k).texture.createView(), 'clear', 1);
    }
    for (let k = last - 1; k >= 0; k--) {
      const weight = k === last - 1 ? plan.deepestWeight : 1;
      const src = level(k + 1);
      run(this.up, src.texture, src.size, level(k).texture.createView(), 'load', weight);
    }
    run(this.composite, top.texture, top.size, outputView, 'clear', 1, inputTexture);

    if (!commandEncoder) device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    for (const t of this.levels) t.destroy();
    for (const b of this.uniformBuffers) b.destroy();
    this.levels = [];
    this.levelKey = '';
    this.uniformBuffers.length = 0;
  }

  private uniformBuffer(device: GPUDevice, index: number): GPUBuffer {
    let buffer = this.uniformBuffers[index];
    while (!buffer) {
      this.uniformBuffers.push(
        device.createBuffer({
          size: BLOOM_UNIFORMS.byteSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      buffer = this.uniformBuffers[index];
    }
    return buffer;
  }

  /** The whole chain for this frame size; a plan draws into a prefix of it. */
  private ensureLevels(device: GPUDevice, width: number, height: number): void {
    const key = `${width}x${height}`;
    if (key === this.levelKey) return;
    for (const t of this.levels) t.destroy();
    this.levels = bloomLevelChain(width, height).map((s) =>
      device.createTexture({
        size: [s.width, s.height, 1],
        format: LEVEL_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.levelKey = key;
  }
}
