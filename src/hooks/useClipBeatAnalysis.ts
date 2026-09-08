import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip } from '../types';
import { MediaBeatAnalyzer } from '../wasm/analyzeMedia';
import { applyBeatMetadata } from '../wasm/offlineAnalysis';

/**
 * Offline WASM beat analysis for clips missing beatTimestamps.
 * Prefers a dedicated Worker; falls back to main-thread analysis.
 * Failures leave clips unchanged (feature disabled).
 */
export function useClipBeatAnalysis(
  clips: Clip[],
  setClips: Dispatch<SetStateAction<Clip[]>>,
): void {
  const analyzing = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const analyzerRef = useRef<MediaBeatAnalyzer | null>(null);

  useEffect(() => {
    return () => {
      analyzerRef.current?.destroy();
      analyzerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const pending = clips.filter(
      (c) =>
        !c.beatTimestamps?.length &&
        !analyzing.current.has(c.id) &&
        !failed.current.has(c.id) &&
        Boolean(c.objectUrl),
    );
    if (pending.length === 0) return;

    const run = async () => {
      if (!analyzerRef.current) {
        analyzerRef.current = new MediaBeatAnalyzer();
      }
      const analyzer = analyzerRef.current;

      for (const clip of pending) {
        if (cancelled) break;
        analyzing.current.add(clip.id);
        try {
          const result = await analyzer.analyze(clip.objectUrl);
          if (cancelled) break;

          if (!result.available || result.beatTimestamps.length === 0) {
            failed.current.add(clip.id);
            continue;
          }
          setClips((prev) =>
            prev.map((c) => {
              if (c.id !== clip.id || c.beatTimestamps?.length) return c;
              const next = { ...c };
              applyBeatMetadata(next, result);
              return next;
            }),
          );
        } catch {
          failed.current.add(clip.id);
        } finally {
          analyzing.current.delete(clip.id);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [clips, setClips]);
}
