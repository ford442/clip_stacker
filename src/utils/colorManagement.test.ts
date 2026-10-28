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
  requestedCanvasColor,
  resolveCanvasPresentation,
  rgbaRowStride,
  shaderForSceneLinear,
  stampWideColor,
  unpadRgbaRows,
  SCENE_LINEAR_MARKER,
} from './colorManagement';
import { serializeProject, applyProjectData } from './project';
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
  it('asks for display-p3 or extended HDR and falls back without crashing the choice', () => {
    expect(requestedCanvasColor('rec709-sdr')).toEqual({
      colorSpace: 'srgb',
      toneMapping: 'standard',
    });
    expect(requestedCanvasColor('display-p3').colorSpace).toBe('display-p3');
    expect(requestedCanvasColor('hdr10').toneMapping).toBe('extended');

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
    const omitted = serializeProject([clip()], [], [], [], undefined, [], undefined, null, [], {}, undefined);
    expect(omitted.colorManagement).toBeUndefined();

    const saved = serializeProject(
      [clip()], [], [], [], undefined, [], undefined, null, [], {},
      { outputColor: 'display-p3', workingSpace: 'rec2020-linear' },
    );
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
