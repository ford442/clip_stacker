import { beforeEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { analyzeGrayFrames, computeAnalysisPlan } from './stabilizePipeline';
import { _resetVideoStabilizeLoadStateForTests } from '../wasm/videoStabilize';
import {
  handheldCameraPath,
  jitterEnergy,
  residualTrack,
  worldPixel,
  type CameraPath,
} from './stabilize.test.helpers';
import { proxyDimensions } from './proxyMedia';

/**
 * Stabilization solved on a preview proxy must correct the full-res export.
 *
 * Analysis is planned from the ORIGINAL dimensions, whichever bytes are
 * decoded, and the matrices are normalized UV — so the proxy path only changes
 * how the analysis frame was downscaled. These tests run both inputs through
 * the real WASM and compare.
 */

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;

// Original "camera" frame, and the proxy profile shrunk to fit a unit test:
// short side 240 stands in for 960 against a 480-line source.
const FULL_W = 800;
const FULL_H = 480;
const PROXY_SHORT_SIDE = 240;
const ANALYSIS_EDGE = 200;
const FRAMES = 60;
const MAG = FULL_W / ANALYSIS_EDGE;

async function* asAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/**
 * A full-res frame of the synthetic world magnified `MAG`×, so its texture is
 * sized for the analysis frame after the downscale (the helpers' world is
 * tuned for ~200 px frames and aliases to mush through a 4× box filter).
 * `camX` / `camY` are in full-res pixels.
 */
function renderFullFrame(camX: number, camY: number): Uint8Array {
  const out = new Uint8Array(FULL_W * FULL_H);
  for (let y = 0; y < FULL_H; y++) {
    for (let x = 0; x < FULL_W; x++) {
      const v = worldPixel((x + camX) / MAG, (y + camY) / MAG);
      out[y * FULL_W + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

/** Area-average downscale by an integer factor. */
function boxDown(src: Uint8Array, w: number, h: number, factor: number): Uint8Array {
  const dw = Math.floor(w / factor);
  const dh = Math.floor(h / factor);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) acc += src[(y * factor + j) * w + x * factor + i]!;
      }
      out[y * dw + x] = Math.round(acc / (factor * factor));
    }
  }
  return out;
}

/** Deterministic ±2 level noise standing in for H.264 quantization loss. */
function codecNoise(frame: Uint8Array, seed: number): Uint8Array {
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const n = ((Math.imul(i + 1, 2654435761) ^ seed) >>> 0) % 5;
    out[i] = Math.min(255, Math.max(0, frame[i]! + n - 2));
  }
  return out;
}

function scalePath(p: CameraPath, k: number): CameraPath {
  return { x: p.x.map((v) => v * k), y: p.y.map((v) => v * k) };
}

async function solve(cameraPath: CameraPath) {
  const plan = computeAnalysisPlan(FULL_W, FULL_H, FRAMES / 24, {
    analysisEdge: ANALYSIS_EDGE,
    analysisFps: 24,
    // Same window as stabilizePipeline.test.ts (10 frames at 24 fps).
    smoothSeconds: 10 / 24,
  });
  const proxy = proxyDimensions(FULL_W, FULL_H, PROXY_SHORT_SIDE);
  const proxyFactor = FULL_W / proxy.width;
  const originalToPlan = FULL_W / plan.width;
  const proxyToPlan = proxy.width / plan.width;

  const fromOriginal: Uint8Array[] = [];
  const fromProxy: Uint8Array[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const full = renderFullFrame(cameraPath.x[i]!, cameraPath.y[i]!);
    fromOriginal.push(boxDown(full, FULL_W, FULL_H, originalToPlan));
    const proxyFrame = codecNoise(boxDown(full, FULL_W, FULL_H, proxyFactor), i);
    fromProxy.push(boxDown(proxyFrame, proxy.width, proxy.height, proxyToPlan));
  }

  const original = await analyzeGrayFrames(asAsync(fromOriginal), plan, { baseUrl: WASM_BASE });
  _resetVideoStabilizeLoadStateForTests();
  const proxied = await analyzeGrayFrames(asAsync(fromProxy), plan, { baseUrl: WASM_BASE });
  if (!original.ok || !proxied.ok) throw new Error('analysis failed');
  return { original: original.stabilization, proxied: proxied.stabilization };
}

beforeEach(() => {
  _resetVideoStabilizeLoadStateForTests();
});

// Real WASM over synthetic footage / long mixes: seconds of CPU, far past
// the 5 s default when the suite runs in parallel on a loaded machine.
describe('stabilization solved on a proxy', { timeout: 30_000 }, () => {
  it('plans the same analysis frame for the proxy and the original', () => {
    const fromOriginal = computeAnalysisPlan(3840, 2160, 10);
    const proxy = proxyDimensions(3840, 2160);
    // useClipStabilization always plans from clip.videoWidth/Height (the
    // original), but even planning from the proxy lands on the same frame.
    expect(computeAnalysisPlan(proxy.width, proxy.height, 10)).toMatchObject({
      width: fromOriginal.width,
      height: fromOriginal.height,
    });
  });

  it('is identity on a static shot', async () => {
    const still: CameraPath = { x: new Array(FRAMES).fill(0), y: new Array(FRAMES).fill(0) };
    const { proxied } = await solve(still);
    for (let i = 0; i < proxied.frameCount; i++) {
      const m = proxied.matrices.subarray(i * 6, i * 6 + 6);
      expect(m[2]!).toBeCloseTo(0, 3);
      expect(m[5]!).toBeCloseTo(0, 3);
      expect(m[1]!).toBeCloseTo(0, 3);
      expect(m[3]!).toBeCloseTo(0, 3);
    }
  });

  it('steadies the full-res picture on a shaky shot as well as the full-res solve does', async () => {
    const shake = scalePath(handheldCameraPath(FRAMES), MAG);
    const { original, proxied } = await solve(shake);
    expect(proxied.frameCount).toBe(original.frameCount);

    // Residual motion measured on the FULL-RES frame, with each solve's matrices.
    const before = jitterEnergy(shake.x.map((cx) => FULL_W / 2 - (cx - shake.x[0]!)));
    const afterProxy = jitterEnergy(residualTrack(proxied.matrices, shake, FULL_W, FULL_H).x);
    const afterOriginal = jitterEnergy(residualTrack(original.matrices, shake, FULL_W, FULL_H).x);
    expect(afterProxy / before).toBeLessThan(0.25);
    expect(afterProxy).toBeLessThan(afterOriginal * 1.25 + 0.05);
  });

  it('keeps the tx / ty sign of a translated shot', async () => {
    // The camera jolts right and down mid-shot and stays there.
    const jolt: CameraPath = { x: [], y: [] };
    for (let i = 0; i < FRAMES; i++) {
      jolt.x.push(i < FRAMES / 2 ? 0 : 24);
      jolt.y.push(i < FRAMES / 2 ? 0 : 16);
    }
    const { original, proxied } = await solve(jolt);

    let compared = 0;
    for (let i = 0; i < original.frameCount; i++) {
      for (const slot of [2, 5]) {
        const o = original.matrices[i * 6 + slot]!;
        const p = proxied.matrices[i * 6 + slot]!;
        if (Math.abs(o) < 1 / ANALYSIS_EDGE) continue;
        expect(Math.sign(p)).toBe(Math.sign(o));
        compared += 1;
      }
    }
    // The shot actually moved — the sign check was not vacuous.
    expect(compared).toBeGreaterThan(4);
  });
});
