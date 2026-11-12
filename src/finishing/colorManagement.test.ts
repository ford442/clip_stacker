import { describe, expect, it } from 'vitest';
import {
  COLOR_MANAGED_PASS_ORDER,
  ColorXformMode,
  DEFAULT_COLOR_MANAGEMENT,
  DISPLAY_P3_COLOR_SPACE,
  HDR10_COLOR_SPACE,
  REC709_TO_REC2020,
  REC2020_TO_REC709,
  colorSpaceForOutput,
  isColorManagementActive,
  linearToPq,
  matrixForXform,
  mulMat3Vec,
  nitsToPq,
  normalizeColorManagement,
  packColorXformUniforms,
  pqToNits,
  planCanvasSurface,
  importColorSpaceFor,
  inputModeFor,
  presentModeToXform,
  resolveGraphicsWhiteNits,
  graphicsWhiteSceneGain,
  DISPLAY_P3_TO_REC2020,
  REC2020_TO_DISPLAY_P3,
  resolveCanvasPresentation,
  rgbaRowStride,
  shaderForSceneLinear,
  stampWideColor,
  unpadRgbaRows,
  SCENE_LINEAR_MARKER,
} from './colorManagement';
import { createProjectSnapshot, serializeProject, applyProjectData } from '../project';
import type { Clip } from '../types';

function clip(): Clip {
  return {
    id: 'c',
    file: new File([], 'a.mp4'),
    objectUrl: 'blob:a',
    title: 'A',
    kind: 'video',
    duration: 1,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('color management defaults', () => {
  it('treats the Rec.709 SDR default as inactive', () => {
    expect(isColorManagementActive(undefined)).toBe(false);
    expect(isColorManagementActive(DEFAULT_COLOR_MANAGEMENT)).toBe(false);
    expect(isColorManagementActive(normalizeColorManagement({}))).toBe(false);
    expect(isColorManagementActive(normalizeColorManagement({ outputColor: 'nope' }))).toBe(false);
  });

  it('activates for a non-default output or working space', () => {
    expect(isColorManagementActive({ outputColor: 'display-p3', workingSpace: 'rec709' })).toBe(true);
    expect(isColorManagementActive({ outputColor: 'hdr10', workingSpace: 'rec709' })).toBe(true);
    expect(isColorManagementActive({ outputColor: 'rec709-sdr', workingSpace: 'rec2020-linear' })).toBe(true);
  });

  it('runs the output transform immediately before display-referred grain', () => {
    const output = COLOR_MANAGED_PASS_ORDER.indexOf('output');
    const grain = COLOR_MANAGED_PASS_ORDER.indexOf('grain');
    expect(grain).toBe(output + 1);
    expect(COLOR_MANAGED_PASS_ORDER[0]).toBe('input');
    expect(COLOR_MANAGED_PASS_ORDER.at(-1)).toBe('present');
  });
});

describe('color matrices', () => {
  it('round-trips Rec.709 linear through Rec.2020', () => {
    const samples: Array<[number, number, number]> = [
      [1, 1, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.2, 0.5, 0.8],
    ];
    for (const rgb of samples) {
      const back = mulMat3Vec(REC2020_TO_REC709, mulMat3Vec(REC709_TO_REC2020, rgb));
      expect(back[0]).toBeCloseTo(rgb[0], 6);
      expect(back[1]).toBeCloseTo(rgb[1], 6);
      expect(back[2]).toBeCloseTo(rgb[2], 6);
    }
  });

  it('matches the published Rec.709 → Rec.2020 matrix', () => {
    const published = [
      0.627404, 0.329283, 0.043313,
      0.069097, 0.91954, 0.011362,
      0.016391, 0.088013, 0.895595,
    ];
    published.forEach((value, i) => {
      expect(REC709_TO_REC2020[i]).toBeCloseTo(value, 5);
    });
  });
});

describe('ST 2084 PQ', () => {
  it('maps 0 nits to 0 and 10000 nits to 1', () => {
    expect(nitsToPq(0)).toBe(0);
    expect(nitsToPq(10000)).toBeCloseTo(1, 6);
  });

  it('maps 100 nits and 1000 nits to the known codes', () => {
    expect(nitsToPq(100)).toBeCloseTo(0.508078421517399, 6);
    expect(nitsToPq(1000)).toBeCloseTo(0.751827096247041, 6);
  });

  it('inverts those codes back to nits', () => {
    expect(pqToNits(nitsToPq(100))).toBeCloseTo(100, 4);
    expect(pqToNits(nitsToPq(1000))).toBeCloseTo(1000, 3);
    expect(linearToPq(1)).toBeCloseTo(nitsToPq(100), 6);
  });
});

describe('encoder color tags', () => {
  it('tags Rec.709, Display P3, and HDR10 differently', () => {
    expect(colorSpaceForOutput('rec709-sdr')).toEqual({
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: false,
    });
    expect(colorSpaceForOutput('display-p3')).toEqual(DISPLAY_P3_COLOR_SPACE);
    expect(colorSpaceForOutput('hdr10')).toEqual(HDR10_COLOR_SPACE);
    expect(HDR10_COLOR_SPACE.transfer).toBe('pq');
    expect(HDR10_COLOR_SPACE.primaries).toBe('bt2020');
  });
});

describe('canvas presentation', () => {
  it('plans the swapchain: float + extended P3 only for HDR10 on an HDR display or offscreen', () => {
    expect(planCanvasSurface('rec709-sdr', 'display', true, 'bgra8unorm')).toEqual({
      format: 'bgra8unorm',
      colorSpace: 'srgb',
      toneMapping: 'standard',
    });
    expect(planCanvasSurface('display-p3', 'offscreen', false, 'bgra8unorm')).toEqual({
      format: 'bgra8unorm',
      colorSpace: 'display-p3',
      toneMapping: 'standard',
    });
    expect(planCanvasSurface('hdr10', 'display', true, 'bgra8unorm')).toEqual({
      format: 'rgba16float',
      colorSpace: 'display-p3',
      toneMapping: 'extended',
    });
    // SDR monitor: today's 8-bit pq-to-sdr view.
    expect(planCanvasSurface('hdr10', 'display', false, 'bgra8unorm')).toEqual({
      format: 'bgra8unorm',
      colorSpace: 'srgb',
      toneMapping: 'standard',
    });
    // Export / harness: composite above 8 bits whatever the monitor.
    expect(planCanvasSurface('hdr10', 'offscreen', false, 'bgra8unorm').format).toBe('rgba16float');
  });

  it('never treats rg11b10ufloat as a float canvas (it is not a canvas format)', () => {
    const hdr = resolveCanvasPresentation('hdr10', { colorSpace: 'srgb', toneMapping: 'extended' }, 'rg11b10ufloat');
    expect(hdr.present).toBe('pq-to-sdr');
  });

  it('presents extended HDR in the canvas colour space', () => {
    const p3 = resolveCanvasPresentation('hdr10', { colorSpace: 'display-p3', toneMapping: 'extended' }, 'rgba16float');
    expect(p3).toMatchObject({ colorSpace: 'display-p3', present: 'pq-to-extended', presentFallback: false });
    expect(presentModeToXform(p3.present, p3.colorSpace)).toBe(ColorXformMode.presentPqToExtendedP3);
    expect(presentModeToXform('pq-to-extended', 'srgb')).toBe(ColorXformMode.presentPqToExtended);
    expect(matrixForXform(ColorXformMode.presentPqToExtendedP3)).toEqual(REC2020_TO_DISPLAY_P3);
  });

  it('falls back to SDR views when the canvas did not take P3 / extended', () => {
    const p3 = resolveCanvasPresentation(
      'display-p3',
      { colorSpace: 'srgb', toneMapping: 'standard' },
      'bgra8unorm',
    );
    expect(p3.present).toBe('p3-to-srgb');
    expect(p3.presentFallback).toBe(true);

    const p3ok = resolveCanvasPresentation(
      'display-p3',
      { colorSpace: 'display-p3', toneMapping: 'standard' },
      'bgra8unorm',
    );
    expect(p3ok.present).toBe('identity');
    expect(p3ok.presentFallback).toBe(false);

    const hdr8 = resolveCanvasPresentation(
      'hdr10',
      { colorSpace: 'srgb', toneMapping: 'extended' },
      'bgra8unorm',
    );
    expect(hdr8.present).toBe('pq-to-sdr');
    expect(hdr8.presentFallback).toBe(true);

    const hdrFloat = resolveCanvasPresentation(
      'hdr10',
      { colorSpace: 'srgb', toneMapping: 'extended' },
      'rgba16float',
    );
    expect(hdrFloat.present).toBe('pq-to-extended');
    expect(hdrFloat.presentFallback).toBe(false);
  });
});

describe('uniform packing and RGBA stride', () => {
  it('packs the mode, reference white, and matrix rows', () => {
    const packed = packColorXformUniforms(ColorXformMode.inputRec709ToLinear2020);
    expect(packed[0]).toBe(ColorXformMode.inputRec709ToLinear2020);
    expect(packed[1]).toBe(100);
    const m = matrixForXform(ColorXformMode.inputRec709ToLinear2020);
    expect(packed[4]).toBeCloseTo(m[0], 6);
    expect(packed[9]).toBeCloseTo(m[4], 6);
    expect(packed[14]).toBeCloseTo(m[8], 6);
  });

  it('pads RGBA rows to 256 bytes and strips the pad', () => {
    expect(rgbaRowStride(1920)).toBe(7680);
    expect(rgbaRowStride(3)).toBe(256);
    const stride = rgbaRowStride(2);
    const src = new Uint8Array(stride * 2);
    src.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    src.set([9, 10, 11, 12, 13, 14, 15, 16], stride);
    const tight = unpadRgbaRows(src, 2, 2, stride);
    expect(Array.from(tight)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('flips the scene-linear shader marker only when asked', () => {
    const src = `fn f() {}\n${SCENE_LINEAR_MARKER}\n`;
    expect(shaderForSceneLinear(src, false)).toBe(src);
    expect(shaderForSceneLinear(src, true)).toContain('const SCENE_LINEAR: bool = true;');
  });
});

describe('wide color render plan', () => {
  const plan = {
    path: 'effects-reencoding' as const,
    reason: 'test',
    willReencode: true,
    description: 'test',
  };

  it('leaves the plan alone on the Rec.709 default', () => {
    expect(stampWideColor(plan, 'ignored', DEFAULT_COLOR_MANAGEMENT)).toBe(plan);
  });

  it('marks a non-default output ignored on the FFmpeg path', () => {
    const stamped = stampWideColor(plan, 'ignored', {
      outputColor: 'hdr10',
      workingSpace: 'rec709',
    });
    expect(stamped.wideColor).toBe('ignored');
  });
});

describe('project round-trip', () => {
  it('omits the default and restores a chosen output', async () => {
    const omitted = serializeProject(createProjectSnapshot({ clips: [clip()] }));
    expect(omitted.colorManagement).toBeUndefined();

    const saved = serializeProject(createProjectSnapshot({ clips: [clip()], colorManagement: { outputColor: 'display-p3', workingSpace: 'rec2020-linear' } }));
    expect(saved.colorManagement).toEqual({
      outputColor: 'display-p3',
      workingSpace: 'rec2020-linear',
    });
    const restored = await applyProjectData(saved, [clip()]);
    expect(restored.colorManagement).toEqual(saved.colorManagement);

    const legacy = await applyProjectData({ clips: [] }, []);
    expect(legacy.colorManagement.outputColor).toBe('rec709-sdr');
    expect(legacy.colorManagement.workingSpace).toBe('rec709');
  });
});

describe('source import and graphics white', () => {
  it('imports sources as Display P3 only when management is on, and decodes what it imported', () => {
    expect(importColorSpaceFor(undefined)).toBe('srgb');
    expect(importColorSpaceFor({ outputColor: 'rec709-sdr', workingSpace: 'rec709' })).toBe('srgb');
    expect(importColorSpaceFor({ outputColor: 'hdr10', workingSpace: 'rec709' })).toBe('display-p3');
    expect(inputModeFor('srgb')).toBe(ColorXformMode.inputRec709ToLinear2020);
    expect(inputModeFor('display-p3')).toBe(ColorXformMode.inputDisplayP3ToLinear2020);
    expect(matrixForXform(ColorXformMode.inputDisplayP3ToLinear2020)).toEqual(DISPLAY_P3_TO_REC2020);
  });

  it('P3 white stays white and P3 red lands outside Rec.709 in Rec.2020', () => {
    const white = DISPLAY_P3_TO_REC2020;
    const rowSums = [0, 1, 2].map((r) => white[r * 3]! + white[r * 3 + 1]! + white[r * 3 + 2]!);
    rowSums.forEach((sum) => expect(sum).toBeCloseTo(1, 6));
    // Pure P3 red is more saturated than Rec.709 red (0.6274, 0.0691, 0.0164 in 2020).
    expect(DISPLAY_P3_TO_REC2020[0]).toBeGreaterThan(0.6274);
  });

  it('defaults graphics white to BT.2408 203 nits, clamps, and keeps old projects unchanged', () => {
    expect(resolveGraphicsWhiteNits(undefined)).toBe(203);
    expect(resolveGraphicsWhiteNits({ graphicsWhiteNits: 5000 })).toBe(1000);
    expect(resolveGraphicsWhiteNits({ graphicsWhiteNits: 10 })).toBe(80);
    expect(graphicsWhiteSceneGain({})).toBeCloseTo(2.03, 6);
    expect(normalizeColorManagement({ outputColor: 'hdr10' })).toEqual({
      outputColor: 'hdr10',
      workingSpace: 'rec709',
    });
    expect(normalizeColorManagement({ outputColor: 'hdr10', graphicsWhiteNits: 300 })).toEqual({
      outputColor: 'hdr10',
      workingSpace: 'rec709',
      graphicsWhiteNits: 300,
    });
    expect(normalizeColorManagement({ graphicsWhiteNits: 'x' })).not.toHaveProperty('graphicsWhiteNits');
  });
});
