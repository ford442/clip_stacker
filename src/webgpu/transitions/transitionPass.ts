import {
  buildTransitionShader,
  TRANSITION_UNIFORM_FLOATS,
} from './shaderTemplate';
import {
  getTransitionDef,
  resolveCustomUniforms,
} from './registry';
import type { TransitionRenderParams } from './types';

export interface TransitionPipelineCache {
  getOrCreatePipeline(transitionId: string): GPURenderPipeline;
}

export function createTransitionPipelineCache(
  device: GPUDevice,
  format: GPUTextureFormat,
): TransitionPipelineCache {
  const pipelines = new Map<string, GPURenderPipeline>();

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      {
        binding: 3,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  return {
    getOrCreatePipeline(transitionId: string): GPURenderPipeline {
      const cached = pipelines.get(transitionId);
      if (cached) return cached;

      const def = getTransitionDef(transitionId);
      if (!def) {
        throw new Error(`Unknown transition shader: ${transitionId}`);
      }

      const shaderModule = device.createShaderModule({
        code: buildTransitionShader(def),
      });

      const pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main' },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format }],
        },
        primitive: { topology: 'triangle-list' },
      });

      pipelines.set(transitionId, pipeline);
      return pipeline;
    },
  };
}

export function writeTransitionUniforms(
  buffer: Float32Array,
  canvasWidth: number,
  canvasHeight: number,
  params: TransitionRenderParams,
  transitionId: string,
): void {
  const dest = params.destRect ?? { x: 0, y: 0, w: 1, h: 1 };
  const def = getTransitionDef(transitionId);
  const [c0, c1, c2, c3] = resolveCustomUniforms(def, params.custom);

  buffer[0] = params.progress;
  buffer[1] = canvasWidth;
  buffer[2] = canvasHeight;
  buffer[3] = params.fromUvScale[0];
  buffer[4] = params.fromUvScale[1];
  buffer[5] = params.fromUvOffset[0];
  buffer[6] = params.fromUvOffset[1];
  buffer[7] = params.toUvScale[0];
  buffer[8] = params.toUvScale[1];
  buffer[9] = params.toUvOffset[0];
  buffer[10] = params.toUvOffset[1];
  buffer[11] = dest.x;
  buffer[12] = dest.y;
  buffer[13] = dest.w;
  buffer[14] = dest.h;
  buffer[15] = c0;
  buffer[16] = c1;
  buffer[17] = c2;
  buffer[18] = c3;
  buffer[19] = 0;
}

export function renderTransitionPass(
  device: GPUDevice,
  context: GPUCanvasContext,
  pipelineCache: TransitionPipelineCache,
  sampler: GPUSampler,
  uniformBuffer: GPUBuffer,
  uniformData: Float32Array,
  fromFrame: VideoFrame,
  toFrame: VideoFrame,
  transitionId: string,
  params: TransitionRenderParams,
  canvasWidth: number,
  canvasHeight: number,
): void {
  writeTransitionUniforms(
    uniformData,
    canvasWidth,
    canvasHeight,
    params,
    transitionId,
  );
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  const fromTexture = device.importExternalTexture({ source: fromFrame });
  const toTexture = device.importExternalTexture({ source: toFrame });
  const pipeline = pipelineCache.getOrCreatePipeline(transitionId);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: fromTexture },
      { binding: 2, resource: toTexture },
      { binding: 3, resource: { buffer: uniformBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        loadOp: params.clear ? 'clear' : 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

export { TRANSITION_UNIFORM_FLOATS };
