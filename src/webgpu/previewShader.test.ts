import { describe, expect, it } from 'vitest';
import { DISPLAY_P3_TO_REC709 } from '../finishing/colorManagement';
import { PREVIEW_SHADER as previewShader } from './previewDeviceResources';

// The `Uniforms` layout itself is `PREVIEW_LAYER_UNIFORMS` (uniformSpecs.ts),
// checked by uniformLayout.test.ts; these pin the shader body's behaviour.

describe('preview.wgsl keying', () => {
  it('applies the key before opacity and the fades', () => {
    // Keying a premultiplied colour after the fades would squash the soft
    // edge; the shader samples, keys, then multiplies.
    const keyIndex = previewShader.indexOf('let keyed = keyAlpha(');
    const fadeIndex = previewShader.indexOf('var fadeAlpha = 1.0;');
    expect(keyIndex).toBeGreaterThan(-1);
    expect(keyIndex).toBeLessThan(fadeIndex);
  });
});

describe('preview.wgsl layer warp', () => {
  it('has exactly one warp function, and no separate stabilization step', () => {
    expect(previewShader).toContain('fn applyLayerWarp(');
    expect(previewShader).not.toContain('applyStabilization');
    expect(previewShader.match(/applyLayerWarp\(/g)).toHaveLength(2);
  });
});

describe('preview.wgsl key input for P3-imported sources', () => {
  it('uses the same Display P3 → Rec.709 matrix as colorManagement.ts', () => {
    const rows = [0, 1, 2].map((row) => {
      const match = new RegExp(`P3_TO_709_ROW${row} = vec3<f32>\\(([^)]*)\\)`).exec(previewShader);
      if (!match) throw new Error(`P3_TO_709_ROW${row} missing`);
      return match[1]!.split(',').map((v) => Number(v.trim()));
    });
    rows.flat().forEach((value, i) => expect(value).toBeCloseTo(DISPLAY_P3_TO_REC709[i]!, 6));
  });
});
