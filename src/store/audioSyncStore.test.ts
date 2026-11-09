import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIO_SYNC_OFFSET_MAX_MS,
  AUDIO_SYNC_OFFSET_MIN_MS,
  audioSyncOffsetSec,
  audioSyncStore,
  loadAudioSyncOffsetMs,
  sanitizeAudioSyncOffsetMs,
} from './audioSyncStore';
import { STORAGE_KEYS, safeGet, safeRemove } from '../utils/storageKeys';

describe('audioSyncStore', () => {
  afterEach(() => {
    audioSyncStore.getState().setOffsetMs(0);
    safeRemove('audioSyncOffset');
  });

  it('sanitizes to the 5 ms grid inside the supported range', () => {
    expect(sanitizeAudioSyncOffsetMs(42)).toBe(40);
    expect(sanitizeAudioSyncOffsetMs('-118')).toBe(-120);
    expect(sanitizeAudioSyncOffsetMs(10_000)).toBe(AUDIO_SYNC_OFFSET_MAX_MS);
    expect(sanitizeAudioSyncOffsetMs(-10_000)).toBe(AUDIO_SYNC_OFFSET_MIN_MS);
    expect(sanitizeAudioSyncOffsetMs('nope')).toBe(0);
    expect(sanitizeAudioSyncOffsetMs(null)).toBe(0);
    expect(Object.is(sanitizeAudioSyncOffsetMs(-1), 0)).toBe(true);
  });

  it('persists per browser under its own key and reads it back', () => {
    expect(STORAGE_KEYS.audioSyncOffset.key).toBe('clip_stacker.audioSyncOffset.v1');
    audioSyncStore.getState().setOffsetMs(85);
    expect(audioSyncStore.getState().offsetMs).toBe(85);
    expect(audioSyncOffsetSec()).toBeCloseTo(0.085, 12);
    expect(safeGet('audioSyncOffset')).toBe('85');
    expect(loadAudioSyncOffsetMs()).toBe(85);
  });
});
