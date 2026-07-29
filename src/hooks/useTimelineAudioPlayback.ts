import { useEffect, useRef } from 'react';
import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import {
  disposeAudioPlaybackManager,
  getAudioPlaybackManager,
  type AudioPlaybackManager,
} from '../audio/playbackManager';

/**
 * Keeps the session `AudioPlaybackManager` in sync with the timeline and
 * disposes the AudioContext when the consumer unmounts (project unload /
 * leaving timeline preview).
 */
export function useTimelineAudioPlayback(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  tracks: Track[] = [],
): AudioPlaybackManager {
  const managerRef = useRef(getAudioPlaybackManager());

  useEffect(() => {
    const manager = getAudioPlaybackManager();
    managerRef.current = manager;
    void manager.syncTimeline(clips, groups, transitions, tracks);
  }, [clips, groups, transitions, tracks]);

  useEffect(() => {
    return () => {
      void disposeAudioPlaybackManager();
    };
  }, []);

  return managerRef.current;
}
