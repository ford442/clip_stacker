import { useEffect, useRef } from 'react';
import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import {
  disposeAudioPlaybackManager,
  getAudioPlaybackManager,
  type AudioPlaybackManager,
} from '../audio/playbackManager';
import { useEditorMasterBus } from '../store/editorStore';

/**
 * Keeps the session `AudioPlaybackManager` in sync with the timeline (lane
 * buses and the master bus included — read from the editor store, so a bus
 * edit retunes the preview) and disposes the AudioContext when the consumer
 * unmounts (project unload / leaving timeline preview).
 */
export function useTimelineAudioPlayback(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  tracks: Track[] = [],
): AudioPlaybackManager {
  const managerRef = useRef(getAudioPlaybackManager());
  const masterBus = useEditorMasterBus();

  useEffect(() => {
    const manager = getAudioPlaybackManager();
    managerRef.current = manager;
    void manager.syncTimeline(clips, groups, transitions, tracks, masterBus);
  }, [clips, groups, transitions, tracks, masterBus]);

  useEffect(() => {
    return () => {
      void disposeAudioPlaybackManager();
    };
  }, []);

  return managerRef.current;
}
