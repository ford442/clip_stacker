/**
 * Colour probes for the render harness: 10-bit luma statistics of a packed
 * HDR10 frame (the bytes the encoder gets), and a Display P3 test chart fed
 * into the compositor as a decoded frame, read back in P3.
 */

/** What a 4:2:0 frame's luma plane holds. */
export interface LumaStats {
  format: string | null;
  width: number;
  height: number;
  bitDepth: 8 | 10;
  distinctLuma: number;
  minLuma: number;
  maxLuma: number;
  colorSpace: VideoColorSpaceInit;
}

/** Distinct / min / max luma codes of a planar YUV frame (I420, I420P10, NV12…). */
export async function lumaStats(frame: VideoFrame): Promise<LumaStats> {
  const format = frame.format;
  if (!format) throw new Error('frame has no CPU-readable format (GPU-backed decode?)');
  const tenBit = /P1[02]/.test(format);
  const bytes = new ArrayBuffer(frame.allocationSize());
  const layout = await frame.copyTo(bytes);
  const luma = layout[0];
  if (!luma) throw new Error(`no luma plane in ${format}`);
  const view = new DataView(bytes);
  const codes = new Set<number>();
  let minLuma = Infinity;
  let maxLuma = -Infinity;
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  for (let y = 0; y < height; y++) {
    const row = luma.offset + y * luma.stride;
    for (let x = 0; x < width; x++) {
      const code = tenBit ? view.getUint16(row + x * 2, true) : view.getUint8(row + x);
      codes.add(code);
      if (code < minLuma) minLuma = code;
      if (code > maxLuma) maxLuma = code;
    }
  }
  return {
    format,
    width,
    height,
    bitDepth: tenBit ? 10 : 8,
    distinctLuma: codes.size,
    minLuma,
    maxLuma,
    colorSpace: frame.colorSpace.toJSON(),
  };
}

/**
 * The chart's patches, left to right, as Display P3 code values: the P3
 * primaries (outside sRGB, so an sRGB path clips them), white and mid grey.
 */
export const P3_CHART_PATCHES: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
  [128, 128, 128],
];

/** An RGBA `VideoFrame` of {@link P3_CHART_PATCHES} as vertical bars, tagged Display P3. */
export function buildP3ChartFrame(width: number, height: number): VideoFrame {
  const data = new Uint8Array(width * height * 4);
  const bar = width / P3_CHART_PATCHES.length;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const patch = P3_CHART_PATCHES[Math.min(P3_CHART_PATCHES.length - 1, Math.floor(x / bar))]!;
      data.set([patch[0], patch[1], patch[2], 255], (y * width + x) * 4);
    }
  }
  return new VideoFrame(data, {
    format: 'RGBA',
    codedWidth: width,
    codedHeight: height,
    timestamp: 0,
    colorSpace: {
      primaries: 'smpte432' as VideoColorPrimaries,
      transfer: 'iec61966-2-1' as VideoTransferCharacteristics,
      matrix: 'rgb',
      fullRange: true,
    },
  });
}

/** Read a canvas back through a `VideoFrame` (as the encoder does) into `colorSpace` pixels. */
export function readCanvasIn(
  canvas: HTMLCanvasElement,
  colorSpace: PredefinedColorSpace,
): ImageData {
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  try {
    const scratch = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = scratch.getContext('2d', { willReadFrequently: true, colorSpace });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace });
  } finally {
    frame.close();
  }
}

/** Mean RGB of the middle half of each of `count` vertical bars. */
export function barMeans(image: ImageData, count: number): number[][] {
  const out: number[][] = [];
  const bar = image.width / count;
  const y0 = Math.floor(image.height / 4);
  const y1 = Math.ceil((image.height * 3) / 4);
  for (let i = 0; i < count; i++) {
    const x0 = Math.floor(i * bar + bar / 4);
    const x1 = Math.ceil(i * bar + (bar * 3) / 4);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * image.width + x) * 4;
        sum[0]! += image.data[p]!;
        sum[1]! += image.data[p + 1]!;
        sum[2]! += image.data[p + 2]!;
        n++;
      }
    }
    out.push(sum.map((v) => Math.round(v / Math.max(1, n))));
  }
  return out;
}
