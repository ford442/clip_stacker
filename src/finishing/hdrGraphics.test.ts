import { describe, expect, it } from 'vitest';
import overlayShader from '../webgpu/shaders/graphicsOverlay.wgsl?raw';
import { packGraphicsOverlayUniforms } from '../webgpu/graphicsOverlayPass';
import {
  DEFAULT_GRAPHICS_WHITE_NITS,
  PQ_REFERENCE_WHITE_NITS,
  REC709_TO_REC2020,
  graphicsWhiteSceneGain,
  linearToPq,
  nitsToPq,
} from './colorManagement';
import { graphicsOverlayPixel, graphicsOverlayTexel, srgbToLinearChannel } from './hdrGraphics';

const gain = graphicsWhiteSceneGain({ graphicsWhiteNits: DEFAULT_GRAPHICS_WHITE_NITS });

describe('HDR10 graphics overlay reference', () => {
  it('puts opaque sRGB white at the graphics white (203 nits)', () => {
    expect(gain).toBeCloseTo(DEFAULT_GRAPHICS_WHITE_NITS / PQ_REFERENCE_WHITE_NITS, 12);
    const [r, g, b] = graphicsOverlayPixel([1, 1, 1, 1], [5, 0.2, 0.1], gain);
    for (const c of [r, g, b]) {
      expect(c).toBeCloseTo(gain, 9);
      expect(linearToPq(c)).toBeCloseTo(nitsToPq(203), 9);
    }
  });

  it('leaves the frame untouched where the overlay is transparent', () => {
    expect(graphicsOverlayTexel([0, 0, 0, 0], gain)).toEqual([0, 0, 0, 0]);
    expect(graphicsOverlayPixel([0, 0, 0, 0], [3, 2, 1], gain)).toEqual([3, 2, 1]);
  });

  it('blends anti-aliased edges in linear light (by coverage, not code value)', () => {
    // 50 % coverage of white over black: half the white's light, which is
    // brighter than decoding a 50 % code value would give.
    const [r] = graphicsOverlayPixel([0.5, 0.5, 0.5, 0.5], [0, 0, 0], gain);
    expect(r).toBeCloseTo(gain * 0.5, 9);
    expect(r).toBeGreaterThan(gain * srgbToLinearChannel(0.5));
  });

  it('converts Rec.709 primaries into the Rec.2020 working space', () => {
    const t = graphicsOverlayTexel([1, 0, 0, 1], 1);
    expect(t[0]).toBeCloseTo(REC709_TO_REC2020[0], 9);
    expect(t[1]).toBeCloseTo(REC709_TO_REC2020[3], 9);
    expect(t[2]).toBeCloseTo(REC709_TO_REC2020[6], 9);
  });
});

describe('graphicsOverlay.wgsl', () => {
  it('reads the gain and the 709 → 2020 rows where the pass packs them', () => {
    const u = packGraphicsOverlayUniforms(2.03);
    expect(u).toHaveLength(16);
    expect(u[0]).toBeCloseTo(2.03, 6);
    expect(Array.from(u.subarray(4, 7))).toEqual(Array.from(new Float32Array(REC709_TO_REC2020.slice(0, 3))));
    expect(Array.from(u.subarray(8, 11))).toEqual(Array.from(new Float32Array(REC709_TO_REC2020.slice(3, 6))));
    expect(Array.from(u.subarray(12, 15))).toEqual(Array.from(new Float32Array(REC709_TO_REC2020.slice(6, 9))));
    // Struct order the offsets above rely on.
    const struct = /struct GraphicsUniforms \{([\s\S]*?)\};/.exec(overlayShader)?.[1] ?? '';
    const fields = [...struct.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(['gain', '_pad0', '_pad1', '_pad2', 'row0', 'row1', 'row2']);
  });

  it('uses the same sRGB EOTF and unpremultiply as the reference', () => {
    expect(overlayShader).toContain('v <= vec3<f32>(0.04045)');
    expect(overlayShader).toContain('v / 12.92');
    expect(overlayShader).toContain('pow((v + 0.055) / 1.055, vec3<f32>(2.4))');
    expect(overlayShader).toContain('srgbToLinear(texel.rgb / a)');
    expect(overlayShader).toContain('vec4<f32>(lin * u.gain * a, a)');
  });
});
