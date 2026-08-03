import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECONDARY_COLOR,
  isSecondaryColorActive,
  isFinishingActive,
  normalizeFinishingSettings,
} from './finishing';
import {
  MAX_SECONDARY_GRADES,
  SECONDARY_COLOR_UNIFORM_FLOATS,
  SECONDARY_GRADE_PRESETS,
  appendSecondaryColorFilters,
  applySecondaryStackToRgb,
  bakeSecondaryColorLut,
  buildSecondaryColorFfmpegFilters,
  createSecondaryGrade,
  createSecondaryGradeFromPreset,
  evaluateGradeMask,
  evaluateHueMask,
  evaluateWindowMask,
  hasActiveSecondaryGrades,
  hueDistanceDegrees,
  hslToRgb,
  isSecondaryGradeNeutral,
  maskTypeToUniform,
  normalizeSecondaryColorPass,
  normalizeSecondaryGrade,
  packSecondaryColorUniforms,
  rgbToHsl,
  secondaryHasHueGrades,
  secondaryHasWindowGrades,
  secondaryLutToCubeText,
} from './secondaryColor';

describe('secondary color settings', () => {
  it('defaults are inactive', () => {
    expect(isSecondaryColorActive(DEFAULT_SECONDARY_COLOR)).toBe(false);
    expect(hasActiveSecondaryGrades(DEFAULT_SECONDARY_COLOR)).toBe(false);
    expect(isFinishingActive({ secondaryColor: DEFAULT_SECONDARY_COLOR })).toBe(false);
  });

  it('detects active secondary when enabled with a non-neutral grade', () => {
    const pass = {
      ...DEFAULT_SECONDARY_COLOR,
      enabled: true,
      grades: [
        createSecondaryGrade({
          hueCenter: 210,
          satScale: 0.5,
        }),
      ],
    };
    expect(isSecondaryColorActive(pass)).toBe(true);
    expect(isSecondaryGradeNeutral(pass.grades[0])).toBe(false);
  });

  it('ignores enabled pass with only neutral grades', () => {
    const pass = {
      ...DEFAULT_SECONDARY_COLOR,
      enabled: true,
      grades: [createSecondaryGrade({ hueShift: 0, satScale: 1 })],
    };
    expect(isSecondaryColorActive(pass)).toBe(false);
  });

  it('normalizes out-of-range values and unknown mask types', () => {
    const grade = normalizeSecondaryGrade({
      enabled: true,
      maskType: 'roto' as never,
      hueCenter: 999,
      hueWidth: -10,
      hueSoftness: 500,
      windowCenterX: 2,
      windowWidth: -1,
      hueShift: 400,
      satScale: 9,
      lumOffset: -5,
      satOffset: 3,
    });
    expect(grade.maskType).toBe('hue');
    expect(grade.hueCenter).toBe(360);
    expect(grade.hueWidth).toBe(0);
    expect(grade.hueSoftness).toBe(180);
    expect(grade.windowCenterX).toBe(1);
    expect(grade.windowWidth).toBe(0);
    expect(grade.hueShift).toBe(180);
    expect(grade.satScale).toBe(3);
    expect(grade.lumOffset).toBe(-1);
    expect(grade.satOffset).toBe(1);
  });

  it('caps grades at MAX_SECONDARY_GRADES', () => {
    const grades = Array.from({ length: 5 }, (_, i) =>
      createSecondaryGrade({ hueCenter: i * 10, satScale: 0.5 }),
    );
    const normalized = normalizeSecondaryColorPass(
      { enabled: true, grades },
      DEFAULT_SECONDARY_COLOR,
    );
    expect(normalized.grades).toHaveLength(MAX_SECONDARY_GRADES);
  });

  it('normalizeFinishingSettings restores secondary fields', () => {
    const normalized = normalizeFinishingSettings({
      secondaryColor: {
        enabled: true,
        amount: 0.8,
        grades: [
          {
            enabled: true,
            maskType: 'hue+window',
            hueCenter: 200,
            hueWidth: 50,
            hueSoftness: 10,
            windowCenterX: 0.4,
            windowCenterY: 0.3,
            windowWidth: 0.6,
            windowHeight: 0.5,
            windowRotation: 15,
            windowFeather: 0.2,
            hueShift: -12,
            satScale: 0.7,
            lumOffset: 0.05,
            satOffset: -0.1,
            invertMask: true,
          },
        ],
      },
    });
    expect(normalized.secondaryColor?.enabled).toBe(true);
    expect(normalized.secondaryColor?.amount).toBe(0.8);
    expect(normalized.secondaryColor?.grades).toHaveLength(1);
    expect(normalized.secondaryColor?.grades[0].maskType).toBe('hue+window');
    expect(normalized.secondaryColor?.grades[0].invertMask).toBe(true);
    expect(normalized.secondaryColor?.grades[0].hueShift).toBe(-12);
  });

  it('presets produce sky / skin / shadows starters', () => {
    expect(SECONDARY_GRADE_PRESETS.map((p) => p.id)).toEqual([
      'sky',
      'skin',
      'shadows',
    ]);
    expect(createSecondaryGradeFromPreset('sky').hueCenter).toBe(210);
    expect(createSecondaryGradeFromPreset('skin').maskType).toBe('hue');
    expect(createSecondaryGradeFromPreset('shadows').maskType).toBe('window');
  });
});

describe('hue / window masks', () => {
  it('computes circular hue distance', () => {
    expect(hueDistanceDegrees(10, 350)).toBe(20);
    expect(hueDistanceDegrees(0, 180)).toBe(180);
  });

  it('isolates sky-like blues with hue qualifier', () => {
    const sky = evaluateHueMask(210, 210, 60, 10);
    const orange = evaluateHueMask(30, 210, 60, 10);
    expect(sky).toBeGreaterThan(0.9);
    expect(orange).toBeLessThan(0.1);
  });

  it('builds a soft elliptical window mask', () => {
    const grade = createSecondaryGrade({
      maskType: 'window',
      windowCenterX: 0.5,
      windowCenterY: 0.5,
      windowWidth: 0.4,
      windowHeight: 0.4,
      windowFeather: 0.2,
    });
    expect(evaluateWindowMask(0.5, 0.5, grade)).toBeGreaterThan(0.9);
    expect(evaluateWindowMask(0, 0, grade)).toBeLessThan(0.1);
  });

  it('combines hue+window via intersection', () => {
    const grade = createSecondaryGrade({
      maskType: 'hue+window',
      hueCenter: 210,
      hueWidth: 80,
      hueSoftness: 5,
      windowCenterX: 0.5,
      windowCenterY: 0.5,
      windowWidth: 0.5,
      windowHeight: 0.5,
      windowFeather: 0.1,
    });
    // Blue at center — both masks on
    expect(evaluateGradeMask(210, 0.5, 0.5, grade)).toBeGreaterThan(0.8);
    // Blue outside window
    expect(evaluateGradeMask(210, 0.05, 0.05, grade)).toBeLessThan(0.2);
    // Orange inside window
    expect(evaluateGradeMask(30, 0.5, 0.5, grade)).toBeLessThan(0.2);
  });

  it('inverts the mask when requested', () => {
    const grade = createSecondaryGrade({
      maskType: 'hue',
      hueCenter: 210,
      hueWidth: 40,
      hueSoftness: 1,
      invertMask: true,
    });
    expect(evaluateGradeMask(210, 0.5, 0.5, grade)).toBeLessThan(0.1);
    expect(evaluateGradeMask(30, 0.5, 0.5, grade)).toBeGreaterThan(0.9);
  });
});

describe('applySecondaryStackToRgb', () => {
  it('desaturates sky blues without touching skin oranges', () => {
    const pass = {
      enabled: true,
      amount: 1,
      grades: [
        createSecondaryGrade({
          maskType: 'hue',
          hueCenter: 210,
          hueWidth: 70,
          hueSoftness: 10,
          satScale: 0.2,
        }),
      ],
    };
    const [br, bg, bb] = hslToRgb(210, 0.7, 0.5);
    const [or, og, ob] = hslToRgb(25, 0.55, 0.55);
    const blueOut = applySecondaryStackToRgb(br, bg, bb, pass);
    const orangeOut = applySecondaryStackToRgb(or, og, ob, pass);
    const blueHsl = rgbToHsl(...blueOut);
    const orangeHsl = rgbToHsl(...orangeOut);
    expect(blueHsl[1]).toBeLessThan(0.35);
    expect(orangeHsl[1]).toBeGreaterThan(0.45);
  });

  it('stacks up to three grades', () => {
    const pass = {
      enabled: true,
      amount: 1,
      grades: [
        createSecondaryGrade({ maskType: 'hue', hueCenter: 210, hueWidth: 80, satScale: 0.5 }),
        createSecondaryGrade({
          maskType: 'window',
          windowWidth: 2,
          windowHeight: 2,
          lumOffset: 0.1,
        }),
        createSecondaryGrade({ maskType: 'hue', hueCenter: 210, hueWidth: 80, hueShift: 20 }),
      ],
    };
    const [r, g, b] = hslToRgb(210, 0.6, 0.4);
    const out = applySecondaryStackToRgb(r, g, b, pass, 0.5, 0.5);
    const hsl = rgbToHsl(...out);
    expect(hsl[1]).toBeLessThan(0.6);
    expect(hsl[2]).toBeGreaterThan(0.4);
    // hue shifted toward cyan/green
    expect(hueDistanceDegrees(hsl[0], 230)).toBeLessThan(25);
  });
});

describe('packSecondaryColorUniforms', () => {
  it('packs header + grade slots', () => {
    const packed = packSecondaryColorUniforms({
      enabled: true,
      amount: 0.75,
      grades: [
        createSecondaryGrade({
          maskType: 'hue+window',
          hueCenter: 180,
          hueWidth: 90,
          invertMask: true,
          satScale: 0.8,
        }),
      ],
    });
    expect(packed).toHaveLength(SECONDARY_COLOR_UNIFORM_FLOATS);
    expect(packed[0]).toBeCloseTo(0.75);
    expect(packed[1]).toBe(1);
    expect(packed[4]).toBe(1); // enabled
    expect(packed[5]).toBe(maskTypeToUniform('hue+window'));
    expect(packed[6]).toBe(1); // invert
    expect(packed[8]).toBeCloseTo(0.5); // hueCenter turns
    expect(packed[21]).toBeCloseTo(0.8); // satScale
  });
});

describe('ffmpeg lut bake', () => {
  it('bakes hue grades and skips pure window grades', () => {
    const huePass = {
      enabled: true,
      amount: 1,
      grades: [createSecondaryGradeFromPreset('sky')],
    };
    const windowPass = {
      enabled: true,
      amount: 1,
      grades: [createSecondaryGradeFromPreset('shadows')],
    };
    expect(secondaryHasHueGrades(huePass)).toBe(true);
    expect(secondaryHasWindowGrades(windowPass)).toBe(true);
    expect(bakeSecondaryColorLut(huePass)?.size).toBe(17);
    expect(bakeSecondaryColorLut(windowPass)).toBeNull();
    const cube = secondaryLutToCubeText(bakeSecondaryColorLut(huePass)!);
    expect(cube).toContain('LUT_3D_SIZE 17');
    expect(buildSecondaryColorFfmpegFilters(huePass)).toBe(
      'lut3d=secondary_grade.cube',
    );
    expect(buildSecondaryColorFfmpegFilters(windowPass)).toBe('');
  });

  it('appendSecondaryColorFilters rewrites [vout] sink', () => {
    const base = '[0:v]null[vout]';
    const result = appendSecondaryColorFilters(base, {
      enabled: true,
      amount: 1,
      grades: [createSecondaryGradeFromPreset('sky')],
    });
    expect(result).toContain('[vpresecondary]');
    expect(result).toContain('lut3d=secondary_grade.cube[vout]');
  });
});
