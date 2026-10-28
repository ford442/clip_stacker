import { describe, expect, it } from 'vitest';
import { VECTORSCOPE_SIZE, vectorscopePeak, vectorscopeUv } from './cpu/vectorscope';
import { BT709_B, BT709_G, BT709_R } from './cpu/lumaHistogram';
import { runCpuJob } from './cpu/runCpuJob';
import { selectBackend, GPU_MIN_PIXELS } from './breakEven';
import { VECTORSCOPE_WGSL } from './webgpu/shaders';

function solid(r: number, g: number, b: number, width = 8, height = 8): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
}

/** The bin a colour must land in, derived straight from the Rec.709 definition. */
function expectedBin(r8: number, g8: number, b8: number, size = VECTORSCOPE_SIZE) {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const y = r * BT709_R + g * BT709_G + b * BT709_B;
  const cb = (b - y) / (2 * (1 - BT709_B)) + 0.5;
  const cr = (r - y) / (2 * (1 - BT709_R)) + 0.5;
  return {
    u: Math.min(size - 1, Math.max(0, Math.floor(cb * size))),
    v: Math.min(size - 1, Math.max(0, Math.floor(cr * size))),
  };
}

describe('vectorscopeUv (CPU golden)', () => {
  it('puts every neutral shade in the centre cell', () => {
    for (const level of [0, 64, 128, 200, 255]) {
      const bins = vectorscopeUv(solid(level, level, level), 8, 8);
      const peak = vectorscopePeak(bins);
      expect(peak.count).toBe(64);
      expect(peak.u).toBe(VECTORSCOPE_SIZE / 2);
      expect(peak.v).toBe(VECTORSCOPE_SIZE / 2);
    }
  });

  it('places primaries where Rec.709 says they belong', () => {
    const cases: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [0, 255, 255],
      [255, 0, 255],
    ];
    for (const [r, g, b] of cases) {
      const peak = vectorscopePeak(vectorscopeUv(solid(r, g, b), 8, 8));
      expect({ u: peak.u, v: peak.v }).toEqual(expectedBin(r, g, b));
    }
  });

  it('keeps red above and blue below the neutral row (Cr on rows)', () => {
    const red = vectorscopePeak(vectorscopeUv(solid(255, 0, 0), 8, 8));
    const blue = vectorscopePeak(vectorscopeUv(solid(0, 0, 255), 8, 8));
    expect(red.v).toBeGreaterThan(VECTORSCOPE_SIZE / 2);
    expect(blue.v).toBeLessThan(VECTORSCOPE_SIZE / 2);
    expect(blue.u).toBeGreaterThan(VECTORSCOPE_SIZE / 2);
  });

  it('counts every pixel exactly once', () => {
    const bins = vectorscopeUv(solid(10, 200, 90, 16, 9), 16, 9);
    let total = 0;
    for (const n of bins) total += n;
    expect(total).toBe(16 * 9);
  });

  it('honours a custom bin size', () => {
    const bins = vectorscopeUv(solid(128, 128, 128), 8, 8, 16);
    expect(bins.length).toBe(16 * 16);
    expect(vectorscopePeak(bins, 16)).toMatchObject({ u: 8, v: 8, count: 64 });
  });
});

describe('vectorscope_uv job wiring', () => {
  it('runs on the CPU backend and reports its bin size', () => {
    const result = runCpuJob(
      { op: 'vectorscope_uv', width: 8, height: 8, pixels: solid(128, 128, 128) },
      'test',
    );
    expect(result.backend).toBe('cpu');
    expect(result.binSize).toBe(VECTORSCOPE_SIZE);
    expect(result.vectorscope).toHaveLength(VECTORSCOPE_SIZE * VECTORSCOPE_SIZE);
  });

  it('shares the histogram GPU break-even', () => {
    const big = Math.ceil(Math.sqrt(GPU_MIN_PIXELS)) + 1;
    expect(
      selectBackend({
        op: 'vectorscope_uv',
        prefer: 'auto',
        width: big,
        height: big,
        gpuAvailable: true,
        workerAvailable: false,
      }).backend,
    ).toBe('webgpu');
    expect(
      selectBackend({
        op: 'vectorscope_uv',
        prefer: 'auto',
        width: 64,
        height: 64,
        gpuAvailable: true,
        workerAvailable: false,
      }).backend,
    ).toBe('cpu');
  });

  it('WGSL uses the same Rec.709 constants as the CPU golden', () => {
    expect(VECTORSCOPE_WGSL).toContain(
      `const CB_SCALE = ${(2 * (1 - BT709_B)).toFixed(4)};`,
    );
    expect(VECTORSCOPE_WGSL).toContain(
      `const CR_SCALE = ${(2 * (1 - BT709_R)).toFixed(4)};`,
    );
    expect(VECTORSCOPE_WGSL).toContain(
      `const LUMA = vec3f(${BT709_R}, ${BT709_G}, ${BT709_B});`,
    );
    // Same row-major layout as the CPU golden: Cr selects the row.
    expect(VECTORSCOPE_WGSL).toContain('bins[v * size + u]');
  });
});
