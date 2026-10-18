import { describe, expect, it } from 'vitest';
import {
  SECTION_STATE_STORAGE_KEY,
  isSectionOpen,
  loadSectionState,
  sanitizeSectionState,
  saveSectionOpen,
} from './sectionState';

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SECTION_STATE_STORAGE_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('sectionState', () => {
  it('keeps only boolean entries', () => {
    expect(sanitizeSectionState({ a: true, b: 'no', c: 1, d: false })).toEqual({ a: true, d: false });
    expect(sanitizeSectionState(null)).toEqual({});
    expect(sanitizeSectionState([true])).toEqual({});
  });

  it('falls back to the default for unknown ids', () => {
    expect(isSectionOpen('x', true, {})).toBe(true);
    expect(isSectionOpen('x', false, {})).toBe(false);
    expect(isSectionOpen('x', true, { x: false })).toBe(false);
  });

  it('round-trips and merges saves', () => {
    const storage = memoryStorage();
    saveSectionOpen('a', false, storage);
    saveSectionOpen('b', true, storage);
    expect(loadSectionState(storage)).toEqual({ a: false, b: true });
  });

  it('survives corrupt or missing storage', () => {
    expect(loadSectionState(memoryStorage('{nope'))).toEqual({});
    expect(loadSectionState(null)).toEqual({});
    expect(() => saveSectionOpen('a', true, null)).not.toThrow();
  });
});
