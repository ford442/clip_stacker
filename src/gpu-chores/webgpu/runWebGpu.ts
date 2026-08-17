import { levelsFromHistogram } from '../cpu/lumaHistogram';
import type { GpuChoreJob, GpuChoreResult } from '../types';
import { BLUR_H_WGSL, BLUR_V_WGSL, DOWNSAMPLE_WGSL, HISTOGRAM_WGSL } from './shaders';

function workgroups(size: number): number {
  return Math.max(1, Math.ceil(size / 8));
}

async function mapU32(device: GPUDevice, src: GPUBuffer, byteLength: number): Promise<Uint32Array> {
  const read = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(src, 0, read, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const copy = new Uint32Array(read.getMappedRange().slice(0));
  read.unmap();
  read.destroy();
  return copy;
}

function packedToRgba(packed: Uint32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(packed.length * 4);
  for (let i = 0; i < packed.length; i++) {
    const p = packed[i]!;
    const o = i * 4;
    out[o] = p & 255;
    out[o + 1] = (p >>> 8) & 255;
    out[o + 2] = (p >>> 16) & 255;
    out[o + 3] = (p >>> 24) & 255;
  }
  return out;
}

function createSrcTexture(
  device: GPUDevice,
  job: GpuChoreJob,
): GPUTexture {
  const texture = device.createTexture({
    size: { width: job.width, height: job.height },
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  if (job.source && device.queue.copyExternalImageToTexture) {
    try {
      device.queue.copyExternalImageToTexture(
        { source: job.source as GPUCopyExternalImageSource },
        { texture },
        { width: job.width, height: job.height },
      );
      return texture;
    } catch {
      /* fall through to CPU pixel upload */
    }
  }
  if (!job.pixels) {
    texture.destroy();
    throw new Error('gpu-chores WebGPU: pixels or source required');
  }
  device.queue.writeTexture(
    { texture },
    job.pixels,
    { bytesPerRow: job.width * 4 },
    { width: job.width, height: job.height },
  );
  return texture;
}

export async function runWebGpuJob(
  device: GPUDevice,
  job: GpuChoreJob,
  reason: string,
): Promise<GpuChoreResult> {
  const src = createSrcTexture(device, job);
  try {
    if (job.op === 'luma_histogram_bt709') {
      const bins = device.createBuffer({
        size: 256 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(bins, 0, new Uint32Array(256));
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: HISTOGRAM_WGSL }), entryPoint: 'main' },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: { buffer: bins } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(workgroups(job.width), workgroups(job.height));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const histogram = await mapU32(device, bins, 256 * 4);
      bins.destroy();
      return {
        backend: 'webgpu',
        reason,
        histogram,
        levels: levelsFromHistogram(histogram),
      };
    }

    if (job.op === 'downsample_2d') {
      const outW = job.outWidth ?? job.width;
      const outH = job.outHeight ?? job.height;
      const outBuf = device.createBuffer({
        size: outW * outH * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const uniform = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(uniform, 0, new Uint32Array([outW, outH, 0, 0]));
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: DOWNSAMPLE_WGSL }), entryPoint: 'main' },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: outBuf } },
          { binding: 3, resource: { buffer: uniform } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(workgroups(outW), workgroups(outH));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const packed = await mapU32(device, outBuf, outW * outH * 4);
      outBuf.destroy();
      uniform.destroy();
      return {
        backend: 'webgpu',
        reason,
        pixels: packedToRgba(packed),
        width: outW,
        height: outH,
      };
    }

    const radius = Math.max(1, job.radius ?? 1);
    const tmp = device.createBuffer({
      size: job.width * job.height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const outBuf = device.createBuffer({
      size: job.width * job.height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniform, 0, new Uint32Array([job.width, job.height, radius, 0]));
    const pipeH = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: BLUR_H_WGSL }), entryPoint: 'main' },
    });
    const pipeV = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: BLUR_V_WGSL }), entryPoint: 'main' },
    });
    const bindH = device.createBindGroup({
      layout: pipeH.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: { buffer: tmp } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
    const bindV = device.createBindGroup({
      layout: pipeV.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tmp } },
        { binding: 1, resource: { buffer: outBuf } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const passH = encoder.beginComputePass();
    passH.setPipeline(pipeH);
    passH.setBindGroup(0, bindH);
    passH.dispatchWorkgroups(workgroups(job.width), workgroups(job.height));
    passH.end();
    const passV = encoder.beginComputePass();
    passV.setPipeline(pipeV);
    passV.setBindGroup(0, bindV);
    passV.dispatchWorkgroups(workgroups(job.width), workgroups(job.height));
    passV.end();
    device.queue.submit([encoder.finish()]);
    const packed = await mapU32(device, outBuf, job.width * job.height * 4);
    tmp.destroy();
    outBuf.destroy();
    uniform.destroy();
    return {
      backend: 'webgpu',
      reason,
      pixels: packedToRgba(packed),
      width: job.width,
      height: job.height,
    };
  } finally {
    src.destroy();
  }
}
