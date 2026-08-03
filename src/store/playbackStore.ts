import { createStore } from 'zustand/vanilla';

/** Ignore playhead churn smaller than this (media seek float noise). */
export const PLAYHEAD_EPSILON_SEC = 1e-4;

interface PlaybackState {
  playheadTime: number | null;
  setPlayheadTime: (t: number | null) => void;
}

function playheadTimesEqual(a: number | null, b: number | null): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < PLAYHEAD_EPSILON_SEC;
  }
  return false;
}

export const playbackStore = createStore<PlaybackState>()((set) => ({
  playheadTime: null,
  setPlayheadTime: (t) =>
    set((state) => {
      if (playheadTimesEqual(state.playheadTime, t)) return state;
      return { playheadTime: t };
    }),
}));

export const setPlayheadTime = (t: number | null) =>
  playbackStore.getState().setPlayheadTime(t);

/** Test helper — resets playhead without going through equality guards. */
export function __resetPlaybackStoreForTests(): void {
  playbackStore.setState({ playheadTime: null });
}
