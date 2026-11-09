import { describe, it, expect } from 'vitest';
import {
  findMatchingClipIndex,
  hasAutoGroupSuffix,
  isEditedVersion,
  normaliseBaseName,
} from './clipMatching';

describe('clipMatching', () => {
  it('normalises edited suffixes for comparison', () => {
    expect(normaliseBaseName('vacation_edited.mp4')).toBe('vacation');
    expect(normaliseBaseName('vacation.mp4')).toBe('vacation');
  });

  it('does not auto-group generic duplicate filenames', () => {
    expect(hasAutoGroupSuffix('clip (1).mp4')).toBe(false);
    expect(hasAutoGroupSuffix('clip copy.mp4')).toBe(false);
    expect(findMatchingClipIndex(['clip.mp4'], 'clip (1).mp4')).toBe(-1);
    expect(findMatchingClipIndex(['clip.mp4'], 'clip copy.mp4')).toBe(-1);
  });

  it('auto-groups intentional edit suffixes', () => {
    expect(hasAutoGroupSuffix('clip_edited.mp4')).toBe(true);
    expect(findMatchingClipIndex(['clip.mp4'], 'clip_edited.mp4')).toBe(0);
    expect(isEditedVersion('clip.mp4', 'clip_final.mp4')).toBe(true);
  });

  it('does not match unrelated files', () => {
    expect(findMatchingClipIndex(['first.mp4'], 'second.mp4')).toBe(-1);
  });
});
