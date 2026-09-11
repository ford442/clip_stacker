import { describe, expect, it, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  IDENTITY_STAB_MATRIX,
  STAB_MATRIX_FLOATS,
  _resetVideoStabilizeLoadStateForTests,
  createStabilizer,
  getVideoStabilizeLoadFailure,
} from './videoStabilize';
import {
  handheldCameraPath,
  jitterEnergy,
  renderGrayFrame,
  renderHandheldClip,
  residualTrack,
} from '../utils/stabilize.test.helpers';

const WASM_BASE = pathToFileURL(
  path.resolve(process.cwd(), 'public/wasm') + path.sep,
).href;

const W = 240;
const H = 160;

describe('videoStabilize WASM', () => {
  beforeEach(() => {
    _resetVideoStabilizeLoadStateForTests();
  });

  it('loads and reports its analysis geometry', async () => {
    const stab = await createStabilizer(W, H, 12, { baseUrl: WASM_BASE });
    expect(stab.available).toBe(true);
    if (!stab.available) return;
    expect(stab.width).toBe(W);
    expect(stab.height).toBe(H);
    expect(stab.frameCount).toBe(0);
    stab.destroy();
  });

  it('removes most of the shake from handheld footage', async () => {
    const path80 = handheldCameraPath(80);
    const frames = renderHandheldClip(W, H, path80);

    const stab = await createStabilizer(W, H, 12, { baseUrl: WASM_BASE });
    expect(stab.available).toBe(true);
    if (!stab.available) return;

    for (const frame of frames) stab.pushFrame(frame);
    expect(stab.frameCount).toBe(80);
    stab.finalize();

    const matrices = stab.getAllMatrices();
    expect(matrices).toHaveLength(80 * STAB_MATRIX_FLOATS);

    const after = residualTrack(matrices, path80, W, H);
    // Uncorrected, the point tracks the camera exactly.
    const beforeX = path80.x.map((cx) => W / 2 - (cx - path80.x[0]!));
    const beforeY = path80.y.map((cy) => H / 2 - (cy - path80.y[0]!));

    const ratioX = jitterEnergy(after.x) / jitterEnergy(beforeX);
    const ratioY = jitterEnergy(after.y) / jitterEnergy(beforeY);
    expect(ratioX).toBeLessThan(0.25);
    expect(ratioY).toBeLessThan(0.25);

    stab.destroy();
  });

  it('keeps the deliberate pan while removing the shake', async () => {
    const shaky = handheldCameraPath(80);
    const frames = renderHandheldClip(W, H, shaky);

    const stab = await createStabilizer(W, H, 12, { baseUrl: WASM_BASE });
    if (!stab.available) throw new Error(stab.reason);
    for (const frame of frames) stab.pushFrame(frame);
    stab.finalize();
    const after = residualTrack(stab.getAllMatrices(), shaky, W, H);

    // A pure crop-and-hold would pin the point in place; the smoothed pan must
    // still travel most of the way across, or the smoother is eating real motion.
    const travelled = Math.abs(after.x[after.x.length - 1]! - after.x[0]!);
    const panDistance = Math.abs(0.35 * 79);
    expect(travelled).toBeGreaterThan(panDistance * 0.7);
    stab.destroy();
  });

  it('auto-crops only as much as the corrections need', async () => {
    const still = { x: new Array(40).fill(0), y: new Array(40).fill(0) };
    const stillFrames = renderHandheldClip(W, H, still);
    const a = await createStabilizer(W, H, 12, { baseUrl: WASM_BASE });
    if (!a.available) throw new Error(a.reason);
    for (const f of stillFrames) a.pushFrame(f);
    a.finalize();
    // A locked-off tripod shot needs no crop at all.
    expect(a.zoom).toBeCloseTo(1, 2);
    expect(a.maxCorrection).toBeLessThan(0.01);
    a.destroy();

    const b = await createStabilizer(W, H, 12, { baseUrl: WASM_BASE });
    if (!b.available) throw new Error(b.reason);
    for (const f of renderHandheldClip(W, H, handheldCameraPath(80))) b.pushFrame(f);
    b.finalize();
    expect(b.zoom).toBeGreaterThan(1);
    expect(b.zoom).toBeLessThanOrEqual(1.25);
    b.destroy();
  });

  it('returns identity before finalize and outside the frame range', async () => {
    const stab = await createStabilizer(W, H, 8, { baseUrl: WASM_BASE });
    if (!stab.available) throw new Error(stab.reason);
    const frames = renderHandheldClip(W, H, handheldCameraPath(10));
    for (const f of frames) stab.pushFrame(f);

    expect(stab.getMatrix(0)).toEqual(IDENTITY_STAB_MATRIX);
    stab.finalize();
    expect(stab.getMatrix(-1)).toEqual(IDENTITY_STAB_MATRIX);
    expect(stab.getMatrix(999)).toEqual(IDENTITY_STAB_MATRIX);
    stab.destroy();
  });

  it('rejects a frame buffer smaller than the analysis size', async () => {
    const stab = await createStabilizer(W, H, 8, { baseUrl: WASM_BASE });
    if (!stab.available) throw new Error(stab.reason);
    expect(() => stab.pushFrame(new Uint8Array(10))).toThrow(/expects \d+ gray bytes/);
    stab.destroy();
  });

  it('warps an RGBA frame with the correction it computed', async () => {
    const w = 64;
    const h = 48;
    const stab = await createStabilizer(w, h, 6, { baseUrl: WASM_BASE });
    if (!stab.available) throw new Error(stab.reason);
    const path12 = handheldCameraPath(12);
    for (let i = 0; i < 12; i++) {
      stab.pushFrame(renderGrayFrame(w, h, path12.x[i]!, path12.y[i]!));
    }
    stab.finalize();

    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = i % 256;
      rgba[i * 4 + 1] = 128;
      rgba[i * 4 + 2] = 64;
      rgba[i * 4 + 3] = 255;
    }
    const warped = stab.applyWarp(rgba, 5);
    expect(warped).toHaveLength(rgba.length);
    // Alpha survives the resample, and a non-identity matrix moved something.
    expect(warped[3]).toBe(255);
    expect(Array.from(warped)).not.toEqual(Array.from(rgba));
    stab.destroy();
  });

  it('returns unavailable when baseUrl is bogus (no crash)', async () => {
    _resetVideoStabilizeLoadStateForTests();
    const stab = await createStabilizer(W, H, 12, {
      baseUrl: 'file:///nonexistent-wasm-dir/',
    });
    expect(stab.available).toBe(false);
    if (stab.available) return;
    expect(stab.reason.length).toBeGreaterThan(0);
    expect(getVideoStabilizeLoadFailure()).not.toBeNull();
  });

  it('rejects a zero-sized analysis frame', async () => {
    _resetVideoStabilizeLoadStateForTests();
    const stab = await createStabilizer(0, 0, 12, { baseUrl: WASM_BASE });
    expect(stab.available).toBe(false);
    if (stab.available) return;
    expect(stab.reason).toMatch(/invalid analysis size/);
  });
});
