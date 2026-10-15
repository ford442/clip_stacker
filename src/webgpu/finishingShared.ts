/** Options and texture helpers shared by `FinishingPassChain` and its managed path. */

import type { CanvasPresentation, ColorManagementSettings } from '../utils/colorManagement';

export interface FinishingApplyOptions {
  /** Integer frame index for temporal grain seed (export / quantized preview). */
  frameIndex?: number;
  /** When active, finishing runs in scene-linear Rec.2020 instead of 8-bit Rec.709. */
  colorManagement?: ColorManagementSettings;
  /** How the managed path should write the swapchain. Ignored on the default path. */
  presentation?: CanvasPresentation;
}

export function finishingIntermediateTextureDescriptor(
  width: number,
  height: number,
  format: GPUTextureFormat,
): GPUTextureDescriptor {
  return {
    size: [width, height, 1],
    format,
    // Spec GPUTextureUsage flags (numeric so tests can load without WebGPU).
    usage: 0x01 | 0x02 | 0x04 | 0x10, // COPY_SRC | COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT
  };
}
