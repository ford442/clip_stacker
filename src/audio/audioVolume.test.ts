import { describe, it, expect } from 'vitest';
import {
  audioVolumeFilterSegment,
  clampClipVolume,
  clipHasVolumeAdjustment,
  getClipVolume,
} from './audioVolume';

describe('audioVolume', () => {
  it('clamps volume to 0–2', () => {
    expect(clampClipVolume(-1)).toBe(0);
    expect(clampClipVolume(0)).toBe(0);
    expect(clampClipVolume(1)).toBe(1);
    expect(clampClipVolume(2)).toBe(2);
    expect(clampClipVolume(3)).toBe(2);
    expect(clampClipVolume(undefined)).toBe(1);
  });

  it('detects non-default volume', () => {
    expect(clipHasVolumeAdjustment({ volume: 1 })).toBe(false);
    expect(clipHasVolumeAdjustment({ volume: 0.5 })).toBe(true);
    expect(clipHasVolumeAdjustment({})).toBe(false);
  });

  it('formats FFmpeg volume filter segments', () => {
    expect(audioVolumeFilterSegment(1)).toBe('');
    expect(audioVolumeFilterSegment(0.5)).toBe(',volume=0.5000');
    expect(audioVolumeFilterSegment(2)).toBe(',volume=2.0000');
    expect(getClipVolume({ volume: 1.25 })).toBe(1.25);
  });
});
