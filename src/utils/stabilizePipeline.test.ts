import { describe, expect, it, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Clip } from '../types';
import {
  analyzeGrayFrames,
  computeAnalysisPlan,
  rgbaToGray,
  stabilizeClip,
  DEFAULT_STABILIZE_SMOOTH_SECONDS,
} from './stabilizePipeline';
import { MAX_STABILIZE_FRAMES } from './stabilization';
import { _resetVideoStabilizeLoadStateForTests } from '../wasm/videoStabilize';
import {
  handheldCameraPath,
  jitterEnergy,
  renderHandheldClip,
  residualTrack,
} from './stabilize.test.helpers';

const WASM_BASE = pathToFileURL(
  path.resolve(process.cwd(), 'public/wasm') + path.sep,
).href;

async function* asAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

beforeEach(() => {
  _resetVideoStabilizeLoadStateForTests();
});

describe('computeAnalysisPlan', () => {
  it('downscales to the analysis edge while keeping aspect', () => {
    const plan = computeAnalysisPlan(1920, 1080, 10);
    expect(Math.max(plan.width, plan.height)).toBe(480);
    expect(plan.width / plan.height).toBeCloseTo(1920 / 1080, 2);
  });

  it('leaves already-small sources alone', () => {
    const plan = computeAnalysisPlan(320, 240, 5);
    expect(plan.width).toBe(320);
    expect(plan.height).toBe(240);
  });

  it('derives the smoothing radius from the final fps, not the requested one', () => {
    const plan = computeAnalysisPlan(640, 360, 4, { analysisFps: 30, smoothSeconds: 2 });
    expect(plan.fps).toBe(30);
    expect(plan.smoothRadius).toBe(60);
  });

  it('lowers the sampling rate rather than truncating a long clip', () => {
    // 10 minutes at 24 fps would be 14400 frames — well over the budget.
    const plan = computeAnalysisPlan(1920, 1080, 600);
    expect(plan.fps).toBeLessThan(24);
    expect(plan.estimatedFrames).toBeLessThanOrEqual(MAX_STABILIZE_FRAMES);
    // The smoothing window still spans roughly the same number of seconds.
    // Exactness is impossible here: the radius is a whole number of frames and
    // a 10-minute clip only gets a couple of frames per second to round to.
    const windowSeconds = plan.smoothRadius / plan.fps;
    expect(windowSeconds).toBeGreaterThan(DEFAULT_STABILIZE_SMOOTH_SECONDS * 0.5);
    expect(windowSeconds).toBeLessThan(DEFAULT_STABILIZE_SMOOTH_SECONDS * 1.5);
  });

  it('survives a source with no known dimensions or duration', () => {
    const plan = computeAnalysisPlan(0, 0, NaN);
    expect(plan.width).toBeGreaterThan(0);
    expect(plan.height).toBeGreaterThan(0);
    expect(plan.fps).toBeGreaterThan(0);
    expect(plan.estimatedFrames).toBe(0);
  });
});

describe('rgbaToGray', () => {
  it('applies Rec.709 weights', () => {
    const out = rgbaToGray(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]), new Uint8Array(2));
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(0);
  });

  it('weights green the heaviest', () => {
    const out = rgbaToGray(
      new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
      new Uint8Array(3),
    );
    expect(out[1]).toBeGreaterThan(out[0]!);
    expect(out[0]).toBeGreaterThan(out[2]!);
  });
});

describe('analyzeGrayFrames', () => {
  const W = 200;
  const H = 120;

  it('turns synthetic handheld footage into corrections that steady it', async () => {
    const cameraPath = handheldCameraPath(60);
    const frames = renderHandheldClip(W, H, cameraPath);
    const plan = { width: W, height: H, fps: 24, smoothRadius: 10, estimatedFrames: 60 };

    const result = await analyzeGrayFrames(asAsync(frames), plan, { baseUrl: WASM_BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { stabilization } = result;
    expect(stabilization.frameCount).toBe(60);
    expect(stabilization.fps).toBe(24);
    expect(stabilization.smoothRadius).toBe(10);
    expect(stabilization.zoom).toBeGreaterThanOrEqual(1);

    const after = residualTrack(stabilization.matrices, cameraPath, W, H);
    const before = cameraPath.x.map((cx) => W / 2 - (cx - cameraPath.x[0]!));
    expect(jitterEnergy(after.x) / jitterEnergy(before)).toBeLessThan(0.25);
  });

  it('reports progress per frame', async () => {
    const frames = renderHandheldClip(W, H, handheldCameraPath(6));
    const plan = { width: W, height: H, fps: 24, smoothRadius: 3, estimatedFrames: 6 };
    const seen: number[] = [];
    await analyzeGrayFrames(asAsync(frames), plan, {
      baseUrl: WASM_BASE,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses a clip too short to show any motion', async () => {
    const frames = renderHandheldClip(W, H, handheldCameraPath(1));
    const plan = { width: W, height: H, fps: 24, smoothRadius: 3, estimatedFrames: 1 };
    const result = await analyzeGrayFrames(asAsync(frames), plan, { baseUrl: WASM_BASE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not enough frames/);
  });

  it('stops on cancellation without throwing', async () => {
    const frames = renderHandheldClip(W, H, handheldCameraPath(20));
    const plan = { width: W, height: H, fps: 24, smoothRadius: 3, estimatedFrames: 20 };
    let seen = 0;
    const result = await analyzeGrayFrames(asAsync(frames), plan, {
      baseUrl: WASM_BASE,
      isCancelled: () => seen++ > 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('cancelled');
  });

  it('disables cleanly when the WASM module cannot load', async () => {
    const frames = renderHandheldClip(W, H, handheldCameraPath(5));
    const plan = { width: W, height: H, fps: 24, smoothRadius: 3, estimatedFrames: 5 };
    const result = await analyzeGrayFrames(asAsync(frames), plan, {
      baseUrl: 'file:///nonexistent-wasm-dir/',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('stabilizeClip', () => {
  const clip = (over: Partial<Clip> = {}) =>
    ({
      id: 'a',
      kind: 'video',
      duration: 4,
      videoWidth: 640,
      videoHeight: 360,
      file: new File([], 'a.mp4'),
      ...over,
    }) as Clip;

  it('skips audio clips and stills', async () => {
    await expect(stabilizeClip(clip({ kind: 'audio' }))).resolves.toEqual({
      ok: false,
      reason: 'not a video clip',
    });
    await expect(stabilizeClip(clip({ stillImage: true }))).resolves.toEqual({
      ok: false,
      reason: 'still images have no camera shake',
    });
  });

  it('reports a reason instead of throwing when decoding is unavailable', async () => {
    // happy-dom has neither VideoDecoder nor a 2D canvas.
    const result = await stabilizeClip(clip());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
