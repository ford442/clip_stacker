import { describe, expect, it } from 'vitest';
import grainShader from './shaders/grain.wgsl?raw';
import { GRAIN_UNIFORM_FLOATS } from '../utils/grain';

/**
 * `packGrainUniforms` writes `GrainUniforms` from flat float offsets and
 * `GrainGpuPass` pokes `blurAxis` at slot 14, so the struct order is pinned
 * here from the shader source itself.
 */
function grainFields(): string[] {
  const body = /struct GrainUniforms \{([\s\S]*?)\n\};/.exec(grainShader)?.[1];
  if (!body) throw new Error('GrainUniforms struct not found in grain.wgsl');
  const fields: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(f32|vec2<f32>)\s*,$/.exec(line);
    if (!match) throw new Error(`Unexpected GrainUniforms field: ${line}`);
    if (match[2] === 'f32') fields.push(match[1]);
    else fields.push(`${match[1]}.x`, `${match[1]}.y`);
  }
  return fields;
}

describe('grain.wgsl uniform layout', () => {
  const fields = grainFields();

  it('is exactly the size the pass allocates', () => {
    expect(fields).toHaveLength(GRAIN_UNIFORM_FLOATS);
    expect((GRAIN_UNIFORM_FLOATS * 4) % 16).toBe(0);
  });

  it('keeps the packed slots where packGrainUniforms writes them', () => {
    expect(fields[0]).toBe('amount');
    expect(fields[7]).toBe('frameSeed');
    expect(fields[12]).toBe('texelSize.x');
    expect(fields[14]).toBe('blurAxis');
    expect(fields.slice(16, 19)).toEqual(['quality', 'monochromeBias', 'temporalCoherence']);
    expect(fields.slice(20, 23)).toEqual([
      'responseShadows',
      'responseMidtones',
      'responseHighlights',
    ]);
  });
});
