import { describe, expect, it } from 'vitest';
import previewShader from './shaders/preview.wgsl?raw';
import { AUDIO_UNIFORM_OFFSET } from '../wasm/audioReactiveUniforms';
import { KEY_UNIFORM_FLOATS } from '../utils/overlayKey';

/**
 * `previewEngine.ts` packs `Uniforms` by hand from flat float offsets, so a
 * field inserted into the WGSL struct silently shifts everything after it —
 * stabilization reading the audio slots, the key reading the stab matrix, and
 * so on. These checks pin the layout from the shader source itself.
 *
 * The constants mirrored here are the private ones in `previewEngine.ts`;
 * changing either side without the other is what this test is for.
 */
const UNIFORM_FLOATS = 32;
const STAB_UNIFORM_OFFSET = 17;
const KEY_UNIFORM_OFFSET = 23;

/** Field names of the `Uniforms` struct, in declaration order. */
function uniformFields(): string[] {
  const body = /struct Uniforms \{([\s\S]*?)\n\};/.exec(previewShader)?.[1];
  if (!body) throw new Error('Uniforms struct not found in preview.wgsl');
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*f32\s*,$/.exec(line);
      if (!match) throw new Error(`Unexpected Uniforms field: ${line}`);
      return match[1];
    });
}

describe('preview.wgsl uniform layout', () => {
  const fields = uniformFields();

  it('is exactly the size previewEngine allocates', () => {
    expect(fields).toHaveLength(UNIFORM_FLOATS);
    // 16-byte alignment is a uniform-buffer requirement, not a nicety.
    expect((UNIFORM_FLOATS * 4) % 16).toBe(0);
  });

  it('keeps the audio-reactive slots where the shared constants say', () => {
    expect(fields[AUDIO_UNIFORM_OFFSET.bass]).toBe('bass');
    expect(fields[AUDIO_UNIFORM_OFFSET.mid]).toBe('mid');
    expect(fields[AUDIO_UNIFORM_OFFSET.treble]).toBe('treble');
    expect(fields[AUDIO_UNIFORM_OFFSET.beat]).toBe('beat');
  });

  it('keeps the stabilization affine at its offset', () => {
    expect(fields.slice(STAB_UNIFORM_OFFSET, STAB_UNIFORM_OFFSET + 6)).toEqual([
      'stabA',
      'stabB',
      'stabTx',
      'stabC',
      'stabD',
      'stabTy',
    ]);
  });

  it('keeps the key block in the order packKeyUniforms writes', () => {
    expect(
      fields.slice(KEY_UNIFORM_OFFSET, KEY_UNIFORM_OFFSET + KEY_UNIFORM_FLOATS),
    ).toEqual([
      'keyMode',
      'keyR',
      'keyG',
      'keyB',
      'keySimilarity',
      'keyBlend',
    ]);
  });

  it('pads the tail rather than leaving the struct unaligned', () => {
    expect(fields.slice(KEY_UNIFORM_OFFSET + KEY_UNIFORM_FLOATS)).toEqual([
      '_pad0',
      '_pad1',
      '_pad2',
    ]);
  });
});

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
