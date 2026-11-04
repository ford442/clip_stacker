import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { safeGet, safeSet } from '../utils/storageKeys';

/**
 * Per-browser A/V offset calibration: how much later (ms) this machine's
 * audio is heard than the browser reports. The playhead already subtracts
 * the reported output latency (`heardContextTime`); this covers what is left
 * — a Bluetooth headset that under-reports, a TV's audio delay. Positive
 * delays the picture; negative advances it.
 *
 * View state like the workspace layout: localStorage, never in a project or
 * undo history, because it describes the listener's hardware, not the edit.
 */

export const AUDIO_SYNC_OFFSET_MIN_MS = -500;
export const AUDIO_SYNC_OFFSET_MAX_MS = 500;
export const AUDIO_SYNC_OFFSET_STEP_MS = 5;

/** Clamp to the supported range on the 5 ms grid; 0 for anything non-numeric. */
export function sanitizeAudioSyncOffsetMs(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 0;
  const stepped = Math.round(n / AUDIO_SYNC_OFFSET_STEP_MS) * AUDIO_SYNC_OFFSET_STEP_MS;
  const clamped = Math.max(AUDIO_SYNC_OFFSET_MIN_MS, Math.min(AUDIO_SYNC_OFFSET_MAX_MS, stepped));
  return clamped === 0 ? 0 : clamped;  // no -0
}

export function loadAudioSyncOffsetMs(): number {
  return sanitizeAudioSyncOffsetMs(safeGet('audioSyncOffset'));
}

export interface AudioSyncState {
  offsetMs: number;
  setOffsetMs: (ms: number) => void;
}

export const audioSyncStore = createStore<AudioSyncState>()((set) => ({
  offsetMs: loadAudioSyncOffsetMs(),
  setOffsetMs: (ms) => {
    const offsetMs = sanitizeAudioSyncOffsetMs(ms);
    set({ offsetMs });
    safeSet('audioSyncOffset', String(offsetMs));
  },
}));

/** The calibration in seconds, for the playback clock. */
export function audioSyncOffsetSec(): number {
  return audioSyncStore.getState().offsetMs / 1000;
}

export function useAudioSyncStore<T>(selector: (s: AudioSyncState) => T): T {
  return useStore(audioSyncStore, selector);
}
