/**
 * WebGPU-based clip preview engine.
 *
 * Renders video frames to a canvas with real-time fade-in/out effects applied
 * via WGSL shaders. VideoFrame → GPUExternalTexture is zero-copy in Chromium.
 *
 * Usage:
 *   const engine = await PreviewEngine.create(canvas);
 *   // In rAF / requestVideoFrameCallback:
 *   await engine.renderFrame(videoFrame, elapsed, duration, fadeIn, fadeOut, opacity);
 *   videoFrame.close(); // always close after use
 *   // Cleanup:
 *   engine.destroy();
 */

const UNIFORM_FLOATS = 8; // must match WGSL struct (padded to 32 bytes)

export class PreviewEngine {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private uniformData = new Float32Array(UNIFORM_FLOATS);
  private destroyed = false;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
  ) {
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
  }

  static async create(canvas: HTMLCanvasElement): Promise<PreviewEngine> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter available');
    const device = await adapter.requestDevice();

    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('Could not get WebGPU context from canvas');

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });

    const shaderCode = await PreviewEngine.loadShader();
    const shaderModule = device.createShaderModule({ code: shaderCode });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    return new PreviewEngine(device, context, pipeline, sampler, uniformBuffer);
  }

  private static shaderText: string | null = null;

  private static async loadShader(): Promise<string> {
    if (PreviewEngine.shaderText) return PreviewEngine.shaderText;
    try {
      const res = await fetch(new URL('./shaders/preview.wgsl', import.meta.url).href);
      if (!res.ok) throw new Error(`Shader fetch failed: ${res.status}`);
      PreviewEngine.shaderText = await res.text();
      return PreviewEngine.shaderText;
    } catch (e) {
      // Inline fallback — minimal pass-through with fade support
      PreviewEngine.shaderText = INLINE_SHADER;
      return PreviewEngine.shaderText;
    }
  }

  /**
   * Render one video frame with fade applied.
   * @param videoFrame  - Current VideoFrame (caller must close() it after this call)
   * @param elapsed     - Playback position within the clip (seconds)
   * @param duration    - Total clip duration (seconds)
   * @param fadeIn      - Fade-in duration (seconds)
   * @param fadeOut     - Fade-out duration (seconds)
   * @param opacity     - Overall clip opacity (0–1)
   */
  renderFrame(
    videoFrame: VideoFrame,
    elapsed: number,
    duration: number,
    fadeIn: number,
    fadeOut: number,
    opacity = 1,
  ): void {
    if (this.destroyed) return;

    this.uniformData[0] = fadeIn;
    this.uniformData[1] = fadeOut;
    this.uniformData[2] = duration;
    this.uniformData[3] = elapsed;
    this.uniformData[4] = opacity;
    // [5..7] padding — zero by default
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const externalTexture = this.device.importExternalTexture({ source: videoFrame });

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
    this.device.destroy();
  }
}

// Minimal inline shader used when the .wgsl file fetch fails
const INLINE_SHADER = /* wgsl */ `
@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct Uniforms {
  fadeIn: f32, fadeOut: f32, duration: f32, elapsed: f32,
  opacity: f32, _p0: f32, _p1: f32, _p2: f32,
};

struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2<f32>,6>(
    vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.),
    vec2(-1.,1.),  vec2(1.,-1.), vec2(1.,1.));
  var t = array<vec2<f32>,6>(
    vec2(0.,1.), vec2(1.,1.), vec2(0.,0.),
    vec2(0.,0.), vec2(1.,1.), vec2(1.,0.));
  return VO(vec4(p[i],0.,1.), t[i]);
}

@fragment fn fs_main(v: VO) -> @location(0) vec4<f32> {
  var c = textureSampleBaseClampToEdge(videoTexture, videoSampler, v.uv);
  c.a *= u.opacity;
  var fa = 1.0;
  if (u.fadeIn > 0.0 && u.elapsed < u.fadeIn) { fa = u.elapsed / u.fadeIn; }
  if (u.fadeOut > 0.0 && u.duration > 0.0 && u.elapsed > (u.duration - u.fadeOut)) {
    fa = min(fa, (u.duration - u.elapsed) / u.fadeOut);
  }
  return vec4(c.rgb * clamp(fa, 0.0, 1.0), c.a);
}
`;
