/**
 * Pure helpers around `ClipStabilization` — sampling a correction for a given
 * source time, and converting the normalized matrices into the pixel-space
 * forms the FFmpeg and Canvas2D export paths want.
 *
 * The WASM module owns the analysis (`src/wasm/videoStabilize.ts`); everything
 * here is arithmetic on its output, so it stays testable without a GPU, a
 * decoder, or the module itself.
 */

import type { Clip, ClipStabilization } from '../types';
import { STAB_MATRIX_FLOATS, IDENTITY_STAB_MATRIX, type StabMatrix } from '../wasm/videoStabilize';

export { STAB_MATRIX_FLOATS, IDENTITY_STAB_MATRIX };
export type { StabMatrix };

/** Default moving-average half-width, in analysis frames (~1 s at 24 fps). */
export const DEFAULT_STABILIZE_SMOOTH_RADIUS = 24;

/** Analysis sampling rate. Shake is high-frequency, so this stays near source fps. */
export const DEFAULT_STABILIZE_ANALYSIS_FPS = 24;

/** Long edge the source is downscaled to before analysis. */
export const DEFAULT_STABILIZE_ANALYSIS_EDGE = 480;

/** Bound on analysis work per clip — at 24 fps this is 60 s of footage. */
export const MAX_STABILIZE_FRAMES = 1440;

export function isIdentityStabMatrix(m: StabMatrix): boolean {
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0
  );
}

/** True when this clip should be rendered through its stabilization matrices. */
export function isStabilizationActive(
  clip: Pick<Clip, 'kind' | 'stabilize' | 'stabilization'> | undefined,
): boolean {
  return Boolean(
    clip &&
      clip.kind === 'video' &&
      clip.stabilize &&
      clip.stabilization &&
      clip.stabilization.frameCount > 0,
  );
}

function matrixAt(stab: ClipStabilization, index: number): StabMatrix {
  const base = index * STAB_MATRIX_FLOATS;
  const m = stab.matrices;
  return [m[base]!, m[base + 1]!, m[base + 2]!, m[base + 3]!, m[base + 4]!, m[base + 5]!];
}

/**
 * Correction for a source-media time, linearly interpolated between analysis
 * frames.
 *
 * Interpolation rather than nearest-neighbour because analysis usually samples
 * below the source frame rate: snapping would make the correction jump on
 * analysis-frame boundaries, which reads as a new, slower shake. The matrices
 * are near-identity similarities, so blending their six entries is
 * indistinguishable from blending the underlying angle and offset.
 */
export function sampleStabMatrix(
  stab: ClipStabilization | undefined,
  sourceTimeSec: number,
): StabMatrix {
  if (!stab || stab.frameCount <= 0 || !Number.isFinite(sourceTimeSec)) {
    return IDENTITY_STAB_MATRIX;
  }
  const fps = stab.fps > 0 ? stab.fps : DEFAULT_STABILIZE_ANALYSIS_FPS;
  const exact = Math.max(0, sourceTimeSec) * fps;
  const last = stab.frameCount - 1;
  if (exact >= last) return matrixAt(stab, last);

  const i0 = Math.floor(exact);
  const i1 = Math.min(i0 + 1, last);
  const t = exact - i0;
  if (t <= 0) return matrixAt(stab, i0);

  const a = matrixAt(stab, i0);
  const b = matrixAt(stab, i1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
    a[4] + (b[4] - a[4]) * t,
    a[5] + (b[5] - a[5]) * t,
  ];
}

/** Correction for a clip at a source time, or identity when it is not active. */
export function stabMatrixForClip(
  clip: Pick<Clip, 'kind' | 'stabilize' | 'stabilization'> | undefined,
  sourceTimeSec: number,
): StabMatrix {
  if (!isStabilizationActive(clip)) return IDENTITY_STAB_MATRIX;
  return sampleStabMatrix(clip!.stabilization, sourceTimeSec);
}

/**
 * Map a normalized UV correction into a destination-pixel -> source-pixel
 * affine, the form Canvas2D (`setTransform`) and FFmpeg both speak.
 *
 * Returns `[a, b, tx, c, d, ty]` with `srcX = a*x + b*y + tx` for pixel
 * coordinates measured from the top-left corner.
 */
export function stabMatrixToPixelAffine(
  m: StabMatrix,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  const cx = width / 2;
  const cy = height / 2;
  // uvSrc = M*(uvDst - 0.5) + 0.5 + t, with uv = pixel / size.
  const a = m[0];
  const b = (m[1] * width) / height;
  const c = (m[3] * height) / width;
  const d = m[4];
  const tx = cx - (a * cx + b * cy) + m[2] * width;
  const ty = cy - (c * cx + d * cy) + m[5] * height;
  return [a, b, tx, c, d, ty];
}

/** Invert a `[a, b, tx, c, d, ty]` pixel affine. Returns identity if singular. */
export function invertPixelAffine(
  m: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0];
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/**
 * Forward (source -> destination) pixel affine for a Canvas2D `transform()`
 * call. The stored matrix is an inverse warp built for a shader UV lookup, so
 * the CPU path — which pushes pixels the other way — needs it inverted.
 */
export function stabMatrixToCanvasTransform(
  m: StabMatrix,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  return invertPixelAffine(stabMatrixToPixelAffine(m, width, height));
}

/**
 * Serialize corrections as an FFmpeg `vidstabtransform` input file.
 *
 * NOTE: `@ffmpeg/core` is not built with libvidstab, so this is only usable
 * against a custom core. The shipped export paths warp on the GPU (preview /
 * WebGPU export) or via the Canvas2D transform instead — see AGENTS.md.
 */
export function serializeTrf(stab: ClipStabilization, width: number, height: number): string {
  const lines: string[] = ['TRANSFORMS', `# frames: ${stab.frameCount}`];
  for (let i = 0; i < stab.frameCount; i++) {
    const [, , tx, c, d, ty] = stabMatrixToPixelAffine(matrixAt(stab, i), width, height);
    // vidstab stores per-frame x/y shift and rotation (radians).
    const alpha = Math.atan2(c, d);
    lines.push(`${i + 1} ${tx.toFixed(5)} ${ty.toFixed(5)} ${alpha.toFixed(6)} ${stab.zoom.toFixed(5)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `vidstabtransform` filter segment for a written `.trf` file. */
export function buildVidstabTransformFilter(trfPath: string, zoom: number): string {
  const zoomPercent = Math.max(0, (zoom - 1) * 100);
  return `vidstabtransform=input=${trfPath}:zoom=${zoomPercent.toFixed(2)}:smoothing=0:interpol=bilinear`;
}
