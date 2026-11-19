import { useState, useSyncExternalStore } from 'react';
import { playbackStore } from '../store/playbackStore';

export function usePlayheadTime(): number | null {
  return useSyncExternalStore(
    playbackStore.subscribe,
    () => playbackStore.getState().playheadTime,
    () => null,
  );
}

/**
 * The playhead, or — while it is cleared (nothing selected) — the last time
 * it held since the caller mounted (0 before any). What a transport readout
 * shows: clearing the playhead does not jump the display back to 0.
 */
export function useHeldPlayheadTime(): number {
  const [held] = useState(createHeldPlayhead);
  return useSyncExternalStore(held.subscribe, held.get, held.get);
}

function createHeldPlayhead() {
  let last = playbackStore.getState().playheadTime ?? 0;
  const get = () => {
    const time = playbackStore.getState().playheadTime;
    if (time !== null) last = time;
    return last;
  };
  return {
    get,
    subscribe: (onChange: () => void) =>
      playbackStore.subscribe((state) => {
        if (state.playheadTime !== null) last = state.playheadTime;
        onChange();
      }),
  };
}
