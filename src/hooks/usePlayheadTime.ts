import { useSyncExternalStore } from 'react';
import { playbackStore } from '../store/playbackStore';

export function usePlayheadTime(): number | null {
  return useSyncExternalStore(
    playbackStore.subscribe,
    () => playbackStore.getState().playheadTime,
    () => null,
  );
}
