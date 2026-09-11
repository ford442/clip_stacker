/**
 * Minimal GPUDevice stand-in for transition tests (not shipped — only test
 * modules import it). It records the WGSL that was compiled plus the
 * bind/draw calls issued, so a "smoke render" can assert a transition really
 * reaches `draw()` with the right shader and uniforms, without an adapter.
 */

export interface FakeGpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  sampler: GPUSampler;
  uniformBuffer: GPUBuffer;
  shaderCodes: string[];
  drawCalls: number[];
  bindGroups: GPUBindGroupEntry[][];
  writtenUniforms: Float32Array[];
  textureDescriptors: GPUTextureDescriptor[];
  pipelineCount: number;
  externalImageCopies: number;
  /** Compilation errors the next createShaderModule should report. */
  compilationErrors: string[];
}

/** WebGPU enum globals happy-dom does not provide. */
export function stubGpuGlobals(stub: (name: string, value: unknown) => void): void {
  if (typeof GPUShaderStage === 'undefined') {
    stub('GPUShaderStage', { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 });
  }
  if (typeof GPUTextureUsage === 'undefined') {
    stub('GPUTextureUsage', {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      STORAGE_BINDING: 0x08,
      RENDER_ATTACHMENT: 0x10,
    });
  }
  if (typeof GPUBufferUsage === 'undefined') {
    stub('GPUBufferUsage', { UNIFORM: 0x40, COPY_DST: 0x08 });
  }
}

export function createFakeGpu(): FakeGpu {
  const gpu: FakeGpu = {
    device: null as unknown as GPUDevice,
    context: null as unknown as GPUCanvasContext,
    sampler: {} as GPUSampler,
    uniformBuffer: {} as GPUBuffer,
    shaderCodes: [],
    drawCalls: [],
    bindGroups: [],
    writtenUniforms: [],
    textureDescriptors: [],
    pipelineCount: 0,
    externalImageCopies: 0,
    compilationErrors: [],
  };

  const makeTexture = (desc: GPUTextureDescriptor): GPUTexture => {
    gpu.textureDescriptors.push(desc);
    return {
      createView: () => ({}) as GPUTextureView,
      destroy: () => {},
    } as unknown as GPUTexture;
  };

  gpu.device = {
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) =>
      d as unknown as GPUBindGroupLayout,
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) =>
      d as unknown as GPUPipelineLayout,
    createShaderModule: ({ code }: GPUShaderModuleDescriptor) => {
      gpu.shaderCodes.push(code);
      const messages = gpu.compilationErrors.map((message) => ({
        type: 'error',
        message,
        lineNum: 0,
        linePos: 0,
        offset: 0,
        length: 0,
      }));
      return {
        getCompilationInfo: async () => ({ messages }),
      } as unknown as GPUShaderModule;
    },
    createRenderPipeline: () => {
      gpu.pipelineCount += 1;
      return {
        getBindGroupLayout: () => ({}) as GPUBindGroupLayout,
      } as unknown as GPURenderPipeline;
    },
    createBindGroup: ({ entries }: GPUBindGroupDescriptor) => {
      gpu.bindGroups.push([...(entries as Iterable<GPUBindGroupEntry>)]);
      return {} as GPUBindGroup;
    },
    createTexture: makeTexture,
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        draw: (count: number) => {
          gpu.drawCalls.push(count);
        },
        end: () => {},
      }),
      finish: () => ({}) as GPUCommandBuffer,
    }),
    importExternalTexture: () => ({}) as GPUExternalTexture,
    pushErrorScope: () => {},
    popErrorScope: async () => null,
    queue: {
      writeBuffer: (_buffer: GPUBuffer, _offset: number, data: BufferSource) => {
        gpu.writtenUniforms.push(Float32Array.from(data as Float32Array));
      },
      writeTexture: () => {},
      copyExternalImageToTexture: () => {
        gpu.externalImageCopies += 1;
      },
      submit: () => {},
    },
  } as unknown as GPUDevice;

  gpu.context = {
    getCurrentTexture: () =>
      makeTexture({ size: [1, 1, 1], format: 'bgra8unorm', usage: 0 }),
  } as unknown as GPUCanvasContext;

  return gpu;
}

/** Params good enough to render any transition at a given progress. */
export function fakeRenderParams(progress: number, custom?: Record<string, number>) {
  return {
    progress,
    fromUvScale: [1, 1] as [number, number],
    fromUvOffset: [0, 0] as [number, number],
    toUvScale: [1, 1] as [number, number],
    toUvOffset: [0, 0] as [number, number],
    destRect: { x: 0, y: 0, w: 1, h: 1 },
    ...(custom ? { custom } : {}),
    clear: true,
  };
}
