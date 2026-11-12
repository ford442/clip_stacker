/**
 * HDR10 export frames: the PQ texture → I420P10 (BT.2020 NCL, limited range)
 * on the GPU (`YuvPackPass`) → a three-slot readback ring → `VideoFrame`.
 * Replaces the per-frame `MAP_READ` buffer + RGBA8 `slice()` / unpad path:
 * nothing is allocated per frame, and the encoder gets 10-bit samples.
 */

import { HDR10_COLOR_SPACE } from '../finishing/colorManagement';
import { i420Layout, type I420Layout } from '../finishing/yuvPack';
import type { GpuProfiler } from './gpuProfiler';
import { ReadbackRing } from './readbackRing';
import { YuvPackPass } from './yuvPackPass';

export interface PackedFrameInit {
  timestamp: number;
  duration?: number;
}

/** The pixel format the HDR10 readback hands the encoder. */
export const HDR10_FRAME_FORMAT = 'I420P10';

/** `VideoFrameBufferInit` for one packed frame of `layout`. */
export function packedFrameInit(
  layout: I420Layout,
  init: PackedFrameInit,
  colorSpace: VideoColorSpaceInit,
  format: string,
): VideoFrameBufferInit {
  return {
    format: format as VideoPixelFormat,
    codedWidth: layout.width,
    codedHeight: layout.height,
    timestamp: init.timestamp,
    ...(init.duration !== undefined ? { duration: init.duration } : {}),
    layout: layout.planes.map((plane) => ({ offset: plane.offset, stride: plane.stride })),
    colorSpace,
  };
}

export class Hdr10FrameReader {
  private readonly pack: YuvPackPass;
  private readonly ring: ReadbackRing;

  constructor(private readonly device: GPUDevice) {
    this.pack = YuvPackPass.create(device, 'i420p10-bt2020');
    this.ring = new ReadbackRing(device);
  }

  get depth(): number {
    return this.ring.depth;
  }

  get hasFreeSlot(): boolean {
    return this.ring.hasFreeSlot;
  }

  waitForSlot(): Promise<void> {
    return this.ring.waitForSlot();
  }

  /**
   * Pack `pqTexture` and read it back as an `I420P10` frame tagged HDR10.
   * The GPU work is recorded now (the texture may be redrawn as soon as this
   * returns); the frame resolves when its slot has mapped.
   */
  capture(
    pqTexture: GPUTexture,
    init: PackedFrameInit,
    profiler?: GpuProfiler | null,
  ): Promise<VideoFrame> {
    let layout: I420Layout | null = null;
    return this.ring.readback(
      (encoder) => {
        const span = profiler?.begin(encoder, 'HDR10 pack') ?? null;
        const packed = this.pack.encode(this.device, encoder, pqTexture);
        profiler?.end(encoder, span);
        layout = packed.layout;
        return packed.buffer;
      },
      // Sized before recording so the staging slot matches the pack output.
      i420Layout(pqTexture.width, pqTexture.height, this.pack.mode).bufferBytes,
      (bytes) =>
        new VideoFrame(
          new Uint8Array(bytes, 0, layout!.dataBytes),
          packedFrameInit(
            layout!,
            init,
            HDR10_COLOR_SPACE as VideoColorSpaceInit,
            HDR10_FRAME_FORMAT,
          ),
        ),
    );
  }

  destroy(): void {
    this.ring.destroy();
    this.pack.destroy();
  }
}
