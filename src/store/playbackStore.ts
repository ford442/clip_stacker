import { createStore } from 'zustand/vanilla';

interface PlaybackState {
  playheadTime: number | null;
  setPlayheadTime: (t: number | null) => void;
}

export const playbackStore = createStore<PlaybackState>()((set) => ({
  playheadTime: null,
  setPlayheadTime: (t) => set({ playheadTime: t }),
}));

export const setPlayheadTime = (t: number | null) =>
  playbackStore.getState().setPlayheadTime(t);
