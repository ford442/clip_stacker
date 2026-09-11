import {
  buildTransitionShader,
  FROM_STAB_UNIFORM_OFFSET,
  TO_STAB_UNIFORM_OFFSET,
  TRANSITION_UNIFORM_FLOATS,
} from './shaderTemplate';
import { IDENTITY_STAB_MATRIX } from '../../wasm/videoStabilize';
import {
  getTransitionDef,
  resolveCustomUniforms,
} from './registry';
import type { TransitionRenderParams } from './types';

export interface TransitionPipelineCache {
  getOrCreatePipeline(transitionId: string): GPURenderPipeline;
  /** View bound at @group(0) @binding(4) — the luma-wipe mask. */
  getMaskView(): GPUTextureView;
  /**
   * Upload the luma-wipe mask (once per project load). Replaces the built-in
   * diagonal ramp. Pass `null` to go back to the built-in mask.
   */
  setMaskImage(source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null): void;
  destroy(): void;
}

/** Cap on live transition pipelines — custom shaders would otherwise grow this without bound. */
const MAX_CACHED_PIPELINES = 64;

/** Edge length of the built-in mask ramp. Small: it is only a boundary source. */
const DEFAULT_MASK_SIZE = 64;

/**
 * Diagonal luminance ramp used when a project ships no mask of its own, so
 * `lumaWipe` renders as a soft diagonal wipe out of the box.
 */
function createDefaultMaskTexture(device: GPUDevice): GPUTexture {
  const size = DEFAULT_MASK_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ramp = Math.round(((x + y) / (2 * (size - 1))) * 255);
      const i = (y * size + x) * 4;
      pixels[i] = ramp;
      pixels[i + 1] = ramp;
      pixels[i + 2] = ramp;
      pixels[i + 3] = 255;
    }
  }
  const texture = device.createTexture({
    size: [size, size, 1],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: size * 4, rowsPerImage: size },
    { width: size, height: size },
  );
  return texture;
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
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const defaultMask = createDefaultMaskTexture(device);
  let maskTexture: GPUTexture = defaultMask;

  return {
    getMaskView(): GPUTextureView {
      return maskTexture.createView();
    },

    setMaskImage(
      source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null,
    ): void {
      if (maskTexture !== defaultMask) maskTexture.destroy();
      if (!source) {
        maskTexture = defaultMask;
        return;
      }
      const width = Math.max(1, source.width);
      const height = Math.max(1, source.height);
      maskTexture = device.createTexture({
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source },
        { texture: maskTexture },
        { width, height },
      );
    },

    destroy(): void {
      if (maskTexture !== defaultMask) maskTexture.destroy();
      defaultMask.destroy();
      pipelines.clear();
    },

    getOrCreatePipeline(transitionId: string): GPURenderPipeline {
      const cached = pipelines.get(transitionId);
      if (cached) {
        // Refresh recency so the eviction below drops cold entries first.
        pipelines.delete(transitionId);
        pipelines.set(transitionId, cached);
        return cached;
      }

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
      while (pipelines.size > MAX_CACHED_PIPELINES) {
        const oldest = pipelines.keys().next().value;
        if (oldest === undefined) break;
        pipelines.delete(oldest);
      }
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

  const fromStab = params.fromStabMatrix ?? IDENTITY_STAB_MATRIX;
  const toStab = params.toStabMatrix ?? IDENTITY_STAB_MATRIX;
  for (let i = 0; i < 6; i++) {
    buffer[FROM_STAB_UNIFORM_OFFSET + i] = fromStab[i]!;
    buffer[TO_STAB_UNIFORM_OFFSET + i] = toStab[i]!;
  }
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
  device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);

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
      { binding: 4, resource: pipelineCache.getMaskView() },
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
