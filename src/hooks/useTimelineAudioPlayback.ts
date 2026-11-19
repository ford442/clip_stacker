import { useEffect } from 'react';
import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import {
  disposeAudioPlaybackManager,
  getAudioPlaybackManager,
  type AudioPlaybackManager,
} from '../playback/playbackManager';
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
  // The shared manager (lazily created; a new one after the last dispose).
  const manager = getAudioPlaybackManager();
  const masterBus = useEditorMasterBus();

  useEffect(() => {
    getAudioPlaybackManager().syncTimeline(clips, groups, transitions, tracks, masterBus).catch((err: unknown) => {
      // A failed decode / schedule leaves the previous timeline playing; log it
      // rather than surfacing an unhandled rejection on every edit.
      console.warn('[audio] timeline sync failed', err);
    });
  }, [clips, groups, transitions, tracks, masterBus]);

  useEffect(() => {
    return () => {
      disposeAudioPlaybackManager().catch((err: unknown) => {
        console.warn('[audio] playback manager dispose failed', err);
      });
    };
  }, []);

  return manager;
}
