/**
 * Bloom / glow / light wrap — finishing pass after chromatic aberration,
 * before grain. A prefilter → downsample pyramid → additive tent upsample →
 * composite chain over rgba16float levels (see `utils/bloom.ts` for the
 * model). Every draw shares one command encoder with the rest of the chain.
 */

import bloomShader from './shaders/bloom.wgsl?raw';
import { shaderForSceneLinear } from '../utils/colorManagement';
import type { BloomPass } from '../utils/finishing';
import {
  BLOOM_UNIFORM_FLOATS,
  bloomLevelChain,
  isBloomNeutral,
  packBloomUniforms,
  planBloom,
  type BloomLevelSize,
} from '../utils/bloom';

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
      code: shaderForSceneLinear(bloomShader, sceneLinear),
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

    const last = plan.sizes.length - 1;
    run(this.prefilter, inputTexture, { width, height }, this.levels[0].createView(), 'clear', 1);
    for (let k = 1; k <= last; k++) {
      run(this.down, this.levels[k - 1], plan.sizes[k - 1], this.levels[k].createView(), 'clear', 1);
    }
    for (let k = last - 1; k >= 0; k--) {
      const weight = k === last - 1 ? plan.deepestWeight : 1;
      run(this.up, this.levels[k + 1], plan.sizes[k + 1], this.levels[k].createView(), 'load', weight);
    }
    run(this.composite, this.levels[0], plan.sizes[0], outputView, 'clear', 1, inputTexture);

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
    while (this.uniformBuffers.length <= index) {
      this.uniformBuffers.push(
        device.createBuffer({
          size: BLOOM_UNIFORM_FLOATS * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    return this.uniformBuffers[index];
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
