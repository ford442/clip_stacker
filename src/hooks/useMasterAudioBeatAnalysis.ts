import { useEffect, useRef } from 'react';
import { editorActions, useEditorMasterAudio } from '../store';
import { MediaBeatAnalyzer } from '../wasm/analyzeMedia';
import { applyBeatMetadata } from '../wasm/offlineAnalysis';

/**
 * Offline beat analysis for the master audio reference.
 *
 * Runs whenever a master track is loaded without beat metadata — covering both
 * `MasterAudioTrack` drops and `applyProjectData` restores of projects saved
 * before the beats were computed. Failures leave the master audio loaded with
 * no BPM (beatmatch targets just do not offer it).
 */
export function useMasterAudioBeatAnalysis(): void {
  const masterAudio = useEditorMasterAudio();
  const analyzerRef = useRef<MediaBeatAnalyzer | null>(null);
  const failed = useRef(new Set<string>());

  useEffect(() => {
    return () => {
      analyzerRef.current?.destroy();
      analyzerRef.current = null;
    };
  }, []);

  const objectUrl = masterAudio?.objectUrl ?? null;
  const hasBeats = Boolean(masterAudio?.beatTimestamps?.length);

  useEffect(() => {
    if (!objectUrl || hasBeats || failed.current.has(objectUrl)) return;
    let cancelled = false;

    const run = async () => {
      if (!analyzerRef.current) {
        analyzerRef.current = new MediaBeatAnalyzer();
      }
      try {
        const result = await analyzerRef.current.analyze(objectUrl);
        if (cancelled) return;
        if (!result.available || result.beatTimestamps.length === 0) {
          failed.current.add(objectUrl);
          return;
        }
        editorActions.setMasterAudio((prev) => {
          // The user may have swapped or removed the track mid-analysis.
          if (!prev || prev.objectUrl !== objectUrl || prev.beatTimestamps?.length) {
            return prev;
          }
          return applyBeatMetadata({ ...prev }, result);
        });
      } catch {
        failed.current.add(objectUrl);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [objectUrl, hasBeats]);
}
