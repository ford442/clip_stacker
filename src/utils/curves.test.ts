import { describe, expect, it } from 'vitest';
import curvesShader from '../webgpu/shaders/curves.wgsl?raw';
import type { Project } from '../types';
import {
  CURVES_UNIFORM_FLOATS,
  CURVE_MAX_POINTS,
  CURVE_PRESETS,
  DEFAULT_LEVELS,
  curvesPixel,
  identityCurves,
  insertCurvePoint,
  isIdentityCurve,
  monotoneSlopes,
  moveCurvePoint,
  normalizeCurvePoints,
  normalizeLevels,
  packCurvesUniforms,
  removeCurvePoint,
  sampleCurve,
  type CurvePoint,
  type CurvesSettings,
} from './curves';
import {
  DEFAULT_CURVES,
  DEFAULT_FINISHING,
  isCurvesActive,
  isFinishingActive,
  normalizeFinishingSettings,
} from './finishing';
import { applyProjectData, serializeProject } from './project';
import { createTestClip } from './project.test.helpers';

const on = (over: Partial<CurvesSettings> = {}): CurvesSettings => ({
  ...DEFAULT_CURVES,
  enabled: true,
  levels: { ...DEFAULT_LEVELS },
  curves: identityCurves(),
  ...over,
});

const pixel = (s: CurvesSettings, rgb: [number, number, number], sceneLinear = false) =>
  curvesPixel(rgb, packCurvesUniforms(s), sceneLinear);

const S_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.15 },
  { x: 0.75, y: 0.86 },
  { x: 1, y: 1 },
];

describe('curves settings', () => {
  it('defaults are an inactive identity and old projects load them disabled', () => {
    expect(isCurvesActive(DEFAULT_CURVES)).toBe(false);
    expect(isFinishingActive(DEFAULT_FINISHING)).toBe(false);
    expect(isCurvesActive(on())).toBe(false); // enabled but identity = no-op
    const legacy = normalizeFinishingSettings({ sharpen: DEFAULT_FINISHING.sharpen });
    expect(legacy.curves).toEqual(DEFAULT_CURVES);
  });

  it('is active with a curve edit or a levels edit, not at amount 0', () => {
    expect(isCurvesActive(on({ curves: { ...identityCurves(), red: S_CURVE } }))).toBe(true);
    expect(isCurvesActive(on({ levels: { ...DEFAULT_LEVELS, gamma: 1.3 } }))).toBe(true);
    expect(isCurvesActive(on({ amount: 0, levels: { ...DEFAULT_LEVELS, gamma: 1.3 } }))).toBe(
      false,
    );
  });

  it('normalizes knots: sort, clamp, merge near-duplicates, cap, keep two', () => {
    expect(
      normalizeCurvePoints([
        { x: 0.8, y: 2 },
        { x: -1, y: 0.1 },
        { x: 0.5, y: 0.4 },
        { x: 0.505, y: 0.6 },
      ]),
    ).toEqual([
      { x: 0, y: 0.1 },
      { x: 0.5, y: 0.6 },
      { x: 0.8, y: 1 },
    ]);
    expect(normalizeCurvePoints([{ x: 0.5, y: 0.5 }])).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(normalizeCurvePoints('nope')).toHaveLength(2);
    const many = Array.from({ length: 30 }, (_, i) => ({ x: i / 29, y: i / 29 }));
    expect(normalizeCurvePoints(many)).toHaveLength(CURVE_MAX_POINTS);
  });

  it('keeps a usable levels input range and clamps gamma', () => {
    expect(normalizeLevels({ inBlack: 0.6, inWhite: 0.2, gamma: 99 })).toMatchObject({
      inBlack: 0.6,
      inWhite: 0.61,
      gamma: 10,
    });
    expect(normalizeLevels(undefined)).toEqual(DEFAULT_LEVELS);
  });

  it('round-trips through project save / load', async () => {
    const sourceClips = [createTestClip('source1', 5)];
    const curves = on({
      amount: 0.8,
      levels: { inBlack: 0.05, inWhite: 0.9, gamma: 1.2, outBlack: 0.02, outWhite: 0.98 },
      curves: { ...identityCurves(), master: S_CURVE, blue: CURVE_PRESETS[3].points },
    });
    const serialized = serializeProject(sourceClips, [], [], [], {
      ...DEFAULT_FINISHING,
      curves,
    });
    const json = JSON.parse(JSON.stringify(serialized)) as Project;
    const project: Project = {
      clips: [
        {
          id: 'saved',
          title: 'Clip',
          kind: 'video',
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: 'source1.mp4',
        },
      ],
      finishing: json.finishing,
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.curves).toEqual(curves);
  });
});

describe('monotone cubic curve', () => {
  it('passes through every knot and is flat outside the end knots', () => {
    const pts: CurvePoint[] = [
      { x: 0.1, y: 0.2 },
      { x: 0.4, y: 0.35 },
      { x: 0.8, y: 0.9 },
    ];
    const s = on({ curves: { ...identityCurves(), master: pts } });
    for (const p of pts) expect(pixel(s, [p.x, p.x, p.x])[0]).toBeCloseTo(p.y, 6);
    expect(pixel(s, [0.02, 0.02, 0.02])[0]).toBeCloseTo(0.2, 6);
    expect(pixel(s, [0.95, 0.95, 0.95])[0]).toBeCloseTo(0.9, 6);
  });

  it('never overshoots between knots (no ringing on a steep edit)', () => {
    const steep: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.45, y: 0.05 },
      { x: 0.55, y: 0.95 },
      { x: 1, y: 1 },
    ];
    const samples = sampleCurve(steep, 400);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].y).toBeGreaterThanOrEqual(samples[i - 1].y - 1e-9);
      expect(samples[i].y).toBeGreaterThanOrEqual(0);
      expect(samples[i].y).toBeLessThanOrEqual(1);
    }
  });

  it('puts zero slope at a local extremum (non-monotone curves stay bounded)', () => {
    const peak: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 0.2 },
    ];
    expect(monotoneSlopes(peak)[1]).toBe(0);
    expect(Math.max(...sampleCurve(peak, 400).map((p) => p.y))).toBeCloseTo(0.8, 6);
  });

  it('identity curves are recognised', () => {
    expect(isIdentityCurve(identityCurves().master)).toBe(true);
    expect(isIdentityCurve(S_CURVE)).toBe(false);
    // On the diagonal but not reaching the ends clips: not identity.
    expect(
      isIdentityCurve([
        { x: 0.1, y: 0.1 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false);
  });
});

describe('levels and pass order', () => {
  it('maps input black / white to output black / white', () => {
    const s = on({ levels: { inBlack: 0.1, inWhite: 0.9, gamma: 1, outBlack: 0.05, outWhite: 0.95 } });
    expect(pixel(s, [0.1, 0.1, 0.1])[0]).toBeCloseTo(0.05, 6);
    expect(pixel(s, [0.9, 0.9, 0.9])[0]).toBeCloseTo(0.95, 6);
    expect(pixel(s, [0, 0, 0])[0]).toBeCloseTo(0.05, 6);
    expect(pixel(s, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.5, 6);
  });

  it('gamma above 1 brightens midtones and keeps the end points', () => {
    const s = on({ levels: { ...DEFAULT_LEVELS, gamma: 2 } });
    expect(pixel(s, [0.25, 0.25, 0.25])[0]).toBeCloseTo(0.5, 6);
    expect(pixel(s, [0, 0, 0])[0]).toBe(0);
    expect(pixel(s, [1, 1, 1])[0]).toBe(1);
  });

  it('applies levels, then master, then the channel curve; channels are independent', () => {
    const half: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
    ];
    const s = on({
      levels: { ...DEFAULT_LEVELS, inWhite: 0.5 },
      curves: { ...identityCurves(), master: half, red: half },
    });
    // 0.4 → levels 0.8 → master 0.4 → red 0.2; green has no channel curve.
    const [r, g, b] = pixel(s, [0.4, 0.4, 0.4]);
    expect(r).toBeCloseTo(0.2, 6);
    expect(g).toBeCloseTo(0.4, 6);
    expect(b).toBeCloseTo(0.4, 6);
  });

  it('amount blends with the source', () => {
    const s = on({ amount: 0.5, levels: { ...DEFAULT_LEVELS, outWhite: 0.5 } });
    expect(pixel(s, [1, 1, 1])[0]).toBeCloseTo(0.75, 6);
    expect(pixel(on({ amount: 0, levels: { ...DEFAULT_LEVELS, outWhite: 0.5 } }), [1, 1, 1])[0]).toBe(1);
  });

  it('scene-linear: identity is a pass-through and HDR values above 1 survive', () => {
    const id = on({ levels: { ...DEFAULT_LEVELS } });
    for (const v of [0.01, 0.18, 0.7, 2.5]) {
      expect(pixel(id, [v, v, v], true)[0]).toBeCloseTo(v, 5);
    }
    const s = on({ curves: { ...identityCurves(), master: S_CURVE } });
    const hi = pixel(s, [3, 3, 3], true)[0];
    expect(hi).toBeGreaterThan(1);
    // A knot at 0.5 means display mid-grey (linear ≈ 0.214) in managed mode too.
    const mid = on({
      curves: {
        ...identityCurves(),
        master: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.6 },
          { x: 1, y: 1 },
        ],
      },
    });
    const display = pixel(mid, [0.5, 0.5, 0.5])[0];
    const linear = pixel(mid, [0.214041, 0.214041, 0.214041], true)[0];
    expect(display).toBeCloseTo(0.6, 4);
    expect(linear).toBeCloseTo(Math.pow((0.6 + 0.055) / 1.055, 2.4), 4);
  });
});

describe('curve editor operations', () => {
  it('inserts on the curve, keeps order, and refuses near-duplicates and overflow', () => {
    const { points, index } = insertCurvePoint(identityCurves().master, 0.3);
    expect(index).toBe(1);
    expect(points[1]).toEqual({ x: 0.3, y: 0.3 });
    expect(insertCurvePoint(points, 0.305).index).toBe(1);
    const full = Array.from({ length: CURVE_MAX_POINTS }, (_, i) => ({
      x: i / (CURVE_MAX_POINTS - 1),
      y: i / (CURVE_MAX_POINTS - 1),
    }));
    expect(insertCurvePoint(full, 0.51).index).toBe(-1);
  });

  it('moves a knot but never past its neighbours', () => {
    const pts = S_CURVE;
    const moved = moveCurvePoint(pts, 1, 0.9, 1.4);
    expect(moved[1].x).toBeCloseTo(0.74, 6);
    expect(moved[1].y).toBe(1);
    expect(moveCurvePoint(pts, 0, -0.5, 0.1)[0]).toEqual({ x: 0, y: 0.1 });
  });

  it('removes a knot but keeps at least two', () => {
    expect(removeCurvePoint(S_CURVE, 1)).toHaveLength(3);
    expect(removeCurvePoint(identityCurves().master, 0)).toHaveLength(2);
  });
});

describe('curves.wgsl mirrors curves.ts', () => {
  it('has the packed layout: 3 header vec4s and 4 × 16 knot vec4s', () => {
    expect(CURVES_UNIFORM_FLOATS).toBe(12 + 4 * CURVE_MAX_POINTS * 4);
    expect((CURVES_UNIFORM_FLOATS * 4) % 16).toBe(0);
    const body = /struct CurvesUniforms \{([\s\S]*?)\n\};/.exec(curvesShader)?.[1] ?? '';
    const fields = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'));
    expect(fields).toEqual([
      'levels0: vec4<f32>,',
      'levels1: vec4<f32>,',
      'counts: vec4<f32>,',
      `knots: array<vec4<f32>, ${4 * CURVE_MAX_POINTS}>,`,
    ]);
    expect(/const CURVE_MAX_POINTS: i32 = (\d+);/.exec(curvesShader)?.[1]).toBe(
      String(CURVE_MAX_POINTS),
    );
  });

  it('packs identity channels as count 0 (skipped in the shader)', () => {
    const u = packCurvesUniforms(on({ curves: { ...identityCurves(), green: S_CURVE } }));
    expect(Array.from(u.slice(8, 12))).toEqual([0, 0, 4, 0]);
    expect(u[5]).toBe(1);
  });
});
