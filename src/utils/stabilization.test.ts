import { describe, expect, it } from 'vitest';
import type { Clip, ClipStabilization } from '../types';
import {
  IDENTITY_STAB_MATRIX,
  buildVidstabTransformFilter,
  invertPixelAffine,
  isIdentityStabMatrix,
  isStabilizationActive,
  sampleStabMatrix,
  serializeTrf,
  stabMatrixForClip,
  stabMatrixToCanvasTransform,
  stabMatrixToPixelAffine,
  type StabMatrix,
} from './stabilization';

/** Two frames: identity, then a pure 10%-right shift. */
function twoFrameStab(fps = 10): ClipStabilization {
  return {
    fps,
    matrices: new Float32Array([1, 0, 0, 0, 1, 0, 1, 0, 0.1, 0, 1, 0.2]),
    frameCount: 2,
    zoom: 1.2,
    maxCorrection: 0.2,
    smoothRadius: 5,
  };
}

const videoClip = (over: Partial<Clip> = {}) =>
  ({ kind: 'video', ...over }) as Clip;

/** Matrices come back through a Float32Array, so compare at f32 precision. */
function expectMatrix(actual: StabMatrix, expected: number[]) {
  expect(Array.from(actual)).toHaveLength(6);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 6));
}

describe('isStabilizationActive', () => {
  it('requires a video clip, the toggle, and computed matrices', () => {
    const stabilization = twoFrameStab();
    expect(isStabilizationActive(videoClip({ stabilize: true, stabilization }))).toBe(true);
    expect(isStabilizationActive(videoClip({ stabilize: false, stabilization }))).toBe(false);
    expect(isStabilizationActive(videoClip({ stabilize: true }))).toBe(false);
    expect(
      isStabilizationActive({ kind: 'audio', stabilize: true, stabilization } as Clip),
    ).toBe(false);
    expect(isStabilizationActive(undefined)).toBe(false);
  });

  it('treats an empty analysis as inactive', () => {
    const empty: ClipStabilization = {
      fps: 24,
      matrices: new Float32Array(0),
      frameCount: 0,
      zoom: 1,
      maxCorrection: 0,
      smoothRadius: 24,
    };
    expect(isStabilizationActive(videoClip({ stabilize: true, stabilization: empty }))).toBe(
      false,
    );
  });
});

describe('sampleStabMatrix', () => {
  it('returns identity without analysis data', () => {
    expect(sampleStabMatrix(undefined, 1)).toEqual(IDENTITY_STAB_MATRIX);
    expect(isIdentityStabMatrix(IDENTITY_STAB_MATRIX)).toBe(true);
  });

  it('lands exactly on frame boundaries', () => {
    const stab = twoFrameStab(10);
    expectMatrix(sampleStabMatrix(stab, 0), [1, 0, 0, 0, 1, 0]);
    expectMatrix(sampleStabMatrix(stab, 0.1), [1, 0, 0.1, 0, 1, 0.2]);
  });

  it('interpolates between analysis frames', () => {
    // Half a frame in at 10 fps: half of each translation.
    const m = sampleStabMatrix(twoFrameStab(10), 0.05);
    expect(m[2]).toBeCloseTo(0.05, 6);
    expect(m[5]).toBeCloseTo(0.1, 6);
  });

  it('holds the last frame past the end and clamps negative time', () => {
    const stab = twoFrameStab(10);
    expectMatrix(sampleStabMatrix(stab, 99), [1, 0, 0.1, 0, 1, 0.2]);
    expectMatrix(sampleStabMatrix(stab, -5), [1, 0, 0, 0, 1, 0]);
    expect(sampleStabMatrix(stab, NaN)).toEqual(IDENTITY_STAB_MATRIX);
  });

  it('is identity for a clip whose toggle is off', () => {
    const stabilization = twoFrameStab();
    expect(stabMatrixForClip(videoClip({ stabilize: false, stabilization }), 0.1)).toEqual(
      IDENTITY_STAB_MATRIX,
    );
    expectMatrix(stabMatrixForClip(videoClip({ stabilize: true, stabilization }), 0.1), [
      1, 0, 0.1, 0, 1, 0.2,
    ]);
  });
});

describe('stabMatrixToPixelAffine', () => {
  it('maps a normalized translation into pixels', () => {
    const [a, b, tx, c, d, ty] = stabMatrixToPixelAffine([1, 0, 0.25, 0, 1, 0.5], 200, 100);
    expect([a, b, c, d]).toEqual([1, 0, 0, 1]);
    expect(tx).toBeCloseTo(50, 6);
    expect(ty).toBeCloseTo(50, 6);
  });

  it('folds frame aspect into the rotation terms', () => {
    // A rotation authored in UV has aspect-scaled off-diagonals; converting
    // back to pixels must undo exactly that scaling.
    const angle = 0.1;
    const w = 320;
    const h = 180;
    const aspect = w / h;
    const uv: StabMatrix = [
      Math.cos(angle),
      -Math.sin(angle) / aspect,
      0,
      Math.sin(angle) * aspect,
      Math.cos(angle),
      0,
    ];
    const [a, b, , c, d] = stabMatrixToPixelAffine(uv, w, h);
    expect(a).toBeCloseTo(Math.cos(angle), 6);
    expect(b).toBeCloseTo(-Math.sin(angle), 6);
    expect(c).toBeCloseTo(Math.sin(angle), 6);
    expect(d).toBeCloseTo(Math.cos(angle), 6);
  });

  it('keeps the frame centre fixed under a pure rotation', () => {
    const angle = 0.2;
    const w = 200;
    const h = 100;
    const aspect = w / h;
    const uv: StabMatrix = [
      Math.cos(angle),
      -Math.sin(angle) / aspect,
      0,
      Math.sin(angle) * aspect,
      Math.cos(angle),
      0,
    ];
    const [a, b, tx, c, d, ty] = stabMatrixToPixelAffine(uv, w, h);
    expect(a * (w / 2) + b * (h / 2) + tx).toBeCloseTo(w / 2, 4);
    expect(c * (w / 2) + d * (h / 2) + ty).toBeCloseTo(h / 2, 4);
  });
});

describe('invertPixelAffine', () => {
  it('round-trips a rotation plus translation', () => {
    const m: [number, number, number, number, number, number] = [
      Math.cos(0.3), -Math.sin(0.3), 12, Math.sin(0.3), Math.cos(0.3), -7,
    ];
    const inv = invertPixelAffine(m);
    // Composing the two must return the identity affine.
    const a = m[0] * inv[0] + m[1] * inv[3];
    const b = m[0] * inv[1] + m[1] * inv[4];
    const tx = m[0] * inv[2] + m[1] * inv[5] + m[2];
    expect(a).toBeCloseTo(1, 6);
    expect(b).toBeCloseTo(0, 6);
    expect(tx).toBeCloseTo(0, 6);
  });

  it('falls back to identity for a singular matrix', () => {
    expect(invertPixelAffine([0, 0, 5, 0, 0, 5])).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('gives Canvas2D the forward transform of the stored inverse warp', () => {
    // The stored matrix samples 10% to the right, so the drawn image must be
    // pushed 10% to the LEFT to put that content under the same output pixel.
    const t = stabMatrixToCanvasTransform([1, 0, 0.1, 0, 1, 0], 200, 100);
    expect(t[2]).toBeCloseTo(-20, 6);
  });
});

describe('vidstab export helpers', () => {
  it('writes one TRANSFORMS row per analysed frame', () => {
    const trf = serializeTrf(twoFrameStab(), 200, 100);
    const lines = trf.trim().split('\n');
    expect(lines[0]).toBe('TRANSFORMS');
    expect(lines).toHaveLength(4); // header + comment + 2 frames
    expect(lines[2]!.startsWith('1 ')).toBe(true);
    expect(lines[3]!.startsWith('2 ')).toBe(true);
    // Frame 2's 10% x shift on a 200 px frame is 20 px.
    expect(Number(lines[3]!.split(' ')[1])).toBeCloseTo(20, 3);
  });

  it('expresses the auto-crop as a vidstabtransform zoom percentage', () => {
    expect(buildVidstabTransformFilter('/tmp/a.trf', 1.05)).toBe(
      'vidstabtransform=input=/tmp/a.trf:zoom=5.00:smoothing=0:interpol=bilinear',
    );
    expect(buildVidstabTransformFilter('/tmp/a.trf', 1)).toContain('zoom=0.00');
  });
});
