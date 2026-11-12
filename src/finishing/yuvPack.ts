/**
 * Planar YUV 4:2:0 packing of an encoded RGB frame (CPU reference + layout).
 *
 * `shaders/yuvPack.wgsl` mirrors {@link packYuvReference} on the GPU: it
 * reads the HDR10 PQ texture (R'G'B' codes, Rec.2020 primaries) and writes
 * `I420P10` — BT.2020 non-constant-luminance Y'CbCr, limited range — into a
 * storage buffer the export reads back as a `VideoFrame`. That replaces the
 * RGBA8 readback the encoder used to convert itself (8 bits: a ramp banded).
 *
 * The 8-bit `i420-bt709` mode is the same pass for Rec.709 SDR.
 *
 * Chroma is sited like MPEG-2 / H.264 / HEVC's default (chroma_loc 0):
 * horizontally co-sited with the even luma column, vertically between the
 * two rows. The filter is [1 2 1] / 4 horizontally and a 2-tap average
 * vertically, edges clamped — instead of whatever the encoder's own RGB → YUV
 * step does.
 */

export type YuvPackMode = 'i420p10-bt2020' | 'i420-bt709';

export interface YuvMatrix {
  kr: number;
  kb: number;
}

export const BT2020_NCL: YuvMatrix = { kr: 0.2627, kb: 0.0593 };
export const BT709: YuvMatrix = { kr: 0.2126, kb: 0.0722 };

export function matrixForPackMode(mode: YuvPackMode): YuvMatrix {
  return mode === 'i420p10-bt2020' ? BT2020_NCL : BT709;
}

export function bitDepthForPackMode(mode: YuvPackMode): 8 | 10 {
  return mode === 'i420p10-bt2020' ? 10 : 8;
}

/** WGSL `PackUniforms.mode`. Keep in sync with yuvPack.wgsl. */
export const YUV_PACK_MODE_ID: Record<YuvPackMode, number> = {
  'i420p10-bt2020': 0,
  'i420-bt709': 1,
};

export interface I420Layout {
  width: number;
  height: number;
  chromaWidth: number;
  chromaHeight: number;
  bytesPerSample: 1 | 2;
  /** Samples in Y + U + V. */
  totalSamples: number;
  /** Byte offsets / strides of the three planes (tightly packed, Y U V). */
  planes: [PlaneLayout, PlaneLayout, PlaneLayout];
  /** Bytes the planes occupy. */
  dataBytes: number;
  /** `dataBytes` rounded up to whole u32 words (the storage / staging size). */
  bufferBytes: number;
}

export interface PlaneLayout {
  offset: number;
  stride: number;
}

export function i420Layout(width: number, height: number, mode: YuvPackMode): I420Layout {
  if (!(width > 0 && height > 0)) throw new Error(`Invalid frame size ${width}x${height}`);
  const bytesPerSample = bitDepthForPackMode(mode) === 10 ? 2 : 1;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const ySamples = width * height;
  const cSamples = chromaWidth * chromaHeight;
  const totalSamples = ySamples + 2 * cSamples;
  const dataBytes = totalSamples * bytesPerSample;
  return {
    width,
    height,
    chromaWidth,
    chromaHeight,
    bytesPerSample,
    totalSamples,
    planes: [
      { offset: 0, stride: width * bytesPerSample },
      { offset: ySamples * bytesPerSample, stride: chromaWidth * bytesPerSample },
      { offset: (ySamples + cSamples) * bytesPerSample, stride: chromaWidth * bytesPerSample },
    ],
    dataBytes,
    bufferBytes: Math.ceil(dataBytes / 4) * 4,
  };
}

/** Limited-range code of a luma value (0–1) at `bits`. */
export function limitedLuma(y: number, bits: 8 | 10): number {
  const scale = bits === 10 ? 4 : 1;
  return clampCode(Math.round((219 * clamp01(y) + 16) * scale), bits);
}

/** Limited-range code of a chroma difference (−0.5…0.5) at `bits`. */
export function limitedChroma(c: number, bits: 8 | 10): number {
  const scale = bits === 10 ? 4 : 1;
  return clampCode(Math.round((224 * Math.max(-0.5, Math.min(0.5, c)) + 128) * scale), bits);
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function clampCode(v: number, bits: 8 | 10): number {
  const max = bits === 10 ? 1023 : 255;
  return v < 0 ? 0 : v > max ? max : v;
}

export function lumaOf(r: number, g: number, b: number, m: YuvMatrix): number {
  return m.kr * r + (1 - m.kr - m.kb) * g + m.kb * b;
}

export function chromaOf(
  r: number,
  g: number,
  b: number,
  m: YuvMatrix,
): [cb: number, cr: number] {
  const y = lumaOf(r, g, b, m);
  return [(b - y) / (2 * (1 - m.kb)), (r - y) / (2 * (1 - m.kr))];
}

/**
 * CPU reference: pack `rgba` (row-major float RGBA, encoded R'G'B' 0–1) into
 * the {@link i420Layout} planes. Returns `Uint16Array` samples for 10-bit
 * modes and `Uint8Array` for 8-bit ones.
 */
export function packYuvReference(
  rgba: Float32Array,
  width: number,
  height: number,
  mode: YuvPackMode,
): Uint16Array | Uint8Array {
  const layout = i420Layout(width, height, mode);
  const bits = bitDepthForPackMode(mode);
  const m = matrixForPackMode(mode);
  const out = bits === 10 ? new Uint16Array(layout.totalSamples) : new Uint8Array(layout.totalSamples);
  const px = (x: number, y: number): [number, number, number] => {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    const i = (cy * width + cx) * 4;
    return [clamp01(rgba[i]!), clamp01(rgba[i + 1]!), clamp01(rgba[i + 2]!)];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      out[y * width + x] = limitedLuma(lumaOf(r, g, b, m), bits);
    }
  }
  const uBase = width * height;
  const vBase = uBase + layout.chromaWidth * layout.chromaHeight;
  for (let cy = 0; cy < layout.chromaHeight; cy++) {
    for (let cx = 0; cx < layout.chromaWidth; cx++) {
      const [r, g, b] = chromaSiteRgb(px, cx, cy);
      const [cb, cr] = chromaOf(r, g, b, m);
      out[uBase + cy * layout.chromaWidth + cx] = limitedChroma(cb, bits);
      out[vBase + cy * layout.chromaWidth + cx] = limitedChroma(cr, bits);
    }
  }
  return out;
}

/** Filtered R'G'B' at one chroma site ([1 2 1] / 4 horizontally, 2-row mean). */
export function chromaSiteRgb(
  px: (x: number, y: number) => readonly [number, number, number],
  cx: number,
  cy: number,
): [number, number, number] {
  const x = cx * 2;
  const sum: [number, number, number] = [0, 0, 0];
  for (const dy of [0, 1]) {
    for (const [dx, w] of [[-1, 0.25], [0, 0.5], [1, 0.25]] as const) {
      const c = px(x + dx, cy * 2 + dy);
      sum[0] += c[0] * w * 0.5;
      sum[1] += c[1] * w * 0.5;
      sum[2] += c[2] * w * 0.5;
    }
  }
  return sum;
}
