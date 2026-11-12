/**
 * Read the half-float HDR10 PQ texture back as tightly packed RGBA8 (each
 * code rounded to 8 bits). For the regression harness and debugging only —
 * it allocates a staging buffer per call; the export reads 10-bit YUV
 * through `Hdr10FrameReader` instead.
 */

/** IEEE 754 binary16 → number. */
export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** RGBA16F rows (padded to `bytesPerRow`) → tight RGBA8, clamped and rounded. */
export function rgba16fRowsToRgba8(
  halves: Uint16Array,
  width: number,
  height: number,
  bytesPerRow: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const halvesPerRow = bytesPerRow / 2;
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < width * 4; i++) {
      const v = halfToFloat(halves[y * halvesPerRow + i]!);
      out[y * width * 4 + i] = Math.round(Math.min(1, Math.max(0, Number.isNaN(v) ? 0 : v)) * 255);
    }
  }
  return out;
}

export async function readPqTextureAsRgba8(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array | null> {
  const { width, height } = texture;
  if (width <= 0 || height <= 0) return null;
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const halves = new Uint16Array(buffer.getMappedRange());
    const rgba = rgba16fRowsToRgba8(halves, width, height, bytesPerRow);
    buffer.unmap();
    return rgba;
  } finally {
    buffer.destroy();
  }
}
