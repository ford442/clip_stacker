import { describe, it, expect } from 'vitest';
import { mapParamsToUniformSlots } from './textFill';

describe('mapParamsToUniformSlots', () => {
  it('maps gradient params to their declared slots and mode 0', () => {
    const slots = mapParamsToUniformSlots('gradient', { speed: 2, angle: 1.5 });
    expect(slots).toEqual({ p0: 2, p1: 1.5, p2: 0, mode: 0 });
  });

  it('maps plasma params to their declared slots and mode 1', () => {
    const slots = mapParamsToUniformSlots('plasma', { scale: 10, speed: 3 });
    expect(slots).toEqual({ p0: 10, p1: 3, p2: 0, mode: 1 });
  });

  it('falls back to the shader defaults for omitted params', () => {
    const slots = mapParamsToUniformSlots('gradient', {});
    expect(slots).toEqual({ p0: 1.0, p1: 0.6, p2: 0, mode: 0 });
  });

  it('returns all-zero slots and mode 0 for an unknown shader id', () => {
    const slots = mapParamsToUniformSlots('not-a-real-shader', { speed: 5 });
    expect(slots).toEqual({ p0: 0, p1: 0, p2: 0, mode: 0 });
  });

  it('returns mode 0 slots when no shader id is given', () => {
    const slots = mapParamsToUniformSlots(undefined);
    expect(slots).toEqual({ p0: 0, p1: 0, p2: 0, mode: 0 });
  });
});
