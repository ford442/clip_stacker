/**
 * Synthetic handheld footage for stabilization tests.
 *
 * Renders a fixed, richly textured "world" through a moving virtual camera, so
 * a test knows the exact camera path and can measure how much of the shake
 * survived the correction. Deterministic — no RNG, no fixtures on disk.
 */

export interface CameraPath {
  x: number[];
  y: number[];
}

/** Textured plane: smooth gradients plus sparse hard blobs for corners to lock onto. */
export function worldPixel(wx: number, wy: number): number {
  let v =
    60 * Math.sin(wx * 0.21) * Math.cos(wy * 0.17) +
    40 * Math.sin((wx + wy) * 0.09) +
    30 * Math.cos(wx * 0.53 + wy * 0.31);
  const gx = Math.floor(wx / 19);
  const gy = Math.floor(wy / 19);
  const h = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) >>> 0;
  if (h % 7 === 0) {
    const dx = wx - (gx * 19 + 9);
    const dy = wy - (gy * 19 + 9);
    if (dx * dx + dy * dy < 16) v += 90;
  }
  return v + 128;
}

/** A slow pan with high-frequency handheld shake layered on top. */
export function handheldCameraPath(frames: number): CameraPath {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < frames; i++) {
    x.push(0.35 * i + 3.2 * Math.sin(i * 1.9) + 1.4 * Math.sin(i * 3.7));
    y.push(0.1 * i + 2.6 * Math.cos(i * 2.3));
  }
  return { x, y };
}

/** Render one grayscale frame of the world as seen from (camX, camY). */
export function renderGrayFrame(
  width: number,
  height: number,
  camX: number,
  camY: number,
  out = new Uint8Array(width * height),
): Uint8Array {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = worldPixel(x + camX, y + camY);
      out[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

/** Every frame of a camera path, as its own buffer. */
export function renderHandheldClip(
  width: number,
  height: number,
  path: CameraPath,
): Uint8Array[] {
  return path.x.map((cx, i) =>
    renderGrayFrame(width, height, cx, path.y[i]!, new Uint8Array(width * height)),
  );
}

/**
 * High-frequency energy of a series: mean |second difference|.
 * Shake shows up here; a smooth pan does not, which is exactly the split
 * stabilization is supposed to make.
 */
export function jitterEnergy(series: number[]): number {
  let acc = 0;
  let n = 0;
  for (let i = 1; i + 1 < series.length; i++) {
    acc += Math.abs(series[i + 1]! - 2 * series[i]! + series[i - 1]!);
    n++;
  }
  return n > 0 ? acc / n : 0;
}

/**
 * Where a world point pinned to frame `0`'s centre lands in the OUTPUT frame,
 * per frame — i.e. what the viewer actually sees move.
 */
export function residualTrack(
  matrices: Float32Array,
  path: CameraPath,
  width: number,
  height: number,
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < path.x.length; i++) {
    const m = matrices.subarray(i * 6, i * 6 + 6);
    // Source pixel the point occupies in frame i.
    const srcU = (width / 2 - (path.x[i]! - path.x[0]!)) / width - 0.5;
    const srcV = (height / 2 - (path.y[i]! - path.y[0]!)) / height - 0.5;
    // Invert the correction to find the output pixel showing it.
    const det = m[0]! * m[4]! - m[1]! * m[3]!;
    const du = srcU - m[2]!;
    const dv = srcV - m[5]!;
    x.push(((m[4]! * du - m[1]! * dv) / det + 0.5) * width);
    y.push(((-m[3]! * du + m[0]! * dv) / det + 0.5) * height);
  }
  return { x, y };
}
