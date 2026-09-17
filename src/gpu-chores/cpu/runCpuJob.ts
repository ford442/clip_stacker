import { downsample2d } from './downsample';
import { lumaHistogramBt709, levelsFromHistogram } from './lumaHistogram';
import { separableBlur } from './separableBlur';
import { VECTORSCOPE_SIZE, vectorscopeUv } from './vectorscope';
import type { GpuChoreJob, GpuChoreResult } from '../types';

export function runCpuJob(job: GpuChoreJob, reason: string): GpuChoreResult {
  const pixels = requirePixels(job);
  if (job.op === 'luma_histogram_bt709') {
    const histogram = lumaHistogramBt709(pixels, job.width, job.height);
    return {
      backend: 'cpu',
      reason,
      histogram,
      levels: levelsFromHistogram(histogram),
    };
  }
  if (job.op === 'vectorscope_uv') {
    const binSize = job.binSize ?? VECTORSCOPE_SIZE;
    return {
      backend: 'cpu',
      reason,
      vectorscope: vectorscopeUv(pixels, job.width, job.height, binSize),
      binSize,
    };
  }
  if (job.op === 'downsample_2d') {
    const outWidth = job.outWidth ?? job.width;
    const outHeight = job.outHeight ?? job.height;
    const out = downsample2d(pixels, job.width, job.height, outWidth, outHeight);
    return {
      backend: 'cpu',
      reason,
      pixels: out,
      width: outWidth,
      height: outHeight,
    };
  }
  const radius = job.radius ?? 1;
  const out = separableBlur(pixels, job.width, job.height, radius);
  return {
    backend: 'cpu',
    reason,
    pixels: out,
    width: job.width,
    height: job.height,
  };
}

export function requirePixels(job: GpuChoreJob): Uint8Array | Uint8ClampedArray {
  if (job.pixels && job.pixels.length >= job.width * job.height * 4) {
    return job.pixels;
  }
  throw new Error(`gpu-chores ${job.op}: RGBA pixels required for CPU/worker path`);
}
