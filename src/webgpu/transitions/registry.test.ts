import { describe, it, expect } from 'vitest';
import {
  TRANSITION_IDS,
  TRANSITION_REGISTRY,
  getTransitionDef,
  getXfadeName,
  isRegisteredTransitionType,
  listTransitionOptions,
  resolveCustomUniforms,
} from './registry';
import { buildTransitionShader } from './shaderTemplate';
import { getTransitionXfadeName } from '../../utils/transitions';

describe('webgpu/transitions/registry', () => {
  it('contains at least 10 ported transition shaders', () => {
    expect(TRANSITION_IDS.length).toBeGreaterThanOrEqual(10);
    for (const id of TRANSITION_IDS) {
      expect(TRANSITION_REGISTRY[id]).toBeDefined();
      expect(TRANSITION_REGISTRY[id].wgslBody.length).toBeGreaterThan(0);
    }
  });

  it('builds valid WGSL for every registry entry', () => {
    for (const id of TRANSITION_IDS) {
      const def = getTransitionDef(id)!;
      const shader = buildTransitionShader(def);
      expect(shader).toContain('fn transitionEffect');
      expect(shader).toContain('texture_external');
      expect(shader).toContain(def.wgslBody.trim());
    }
  });

  it('lists all registry entries for the editor', () => {
    const options = listTransitionOptions();
    expect(options.length).toBe(TRANSITION_IDS.length);
    expect(options.map((o) => o.value)).toEqual(TRANSITION_IDS);
  });

  it('maps legacy dissolve and motion ids to FFmpeg xfade names', () => {
    expect(getXfadeName('dissolve')).toBe('fade');
    expect(getXfadeName('motion')).toBe('smoothleft');
    expect(getTransitionXfadeName('glitch')).toBe('hlslice');
  });

  it('resolves directional custom uniforms into slots', () => {
    const def = getTransitionDef('directional');
    const slots = resolveCustomUniforms(def, { dirX: -0.5, dirY: 0.25 });
    expect(slots[0]).toBe(-0.5);
    expect(slots[1]).toBe(0.25);
  });

  it('treats none as unregistered', () => {
    expect(isRegisteredTransitionType('none')).toBe(false);
    expect(isRegisteredTransitionType('dissolve')).toBe(true);
  });
});
