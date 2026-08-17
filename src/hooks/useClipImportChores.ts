import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip } from '../types';
import { analyzeImportedStillFile } from '../gpu-chores/stillImport';

/**
 * gpu-chores import analysis: Rec.709 luma histogram + library poster.
 * Failures leave clips unchanged (CPU/GPU/worker all optional).
 */
export function useClipImportChores(
  clips: Clip[],
  setClips: Dispatch<SetStateAction<Clip[]>>,
): void {
  const analyzing = useRef(new Set<string>());
  const failed = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    const pending = clips.filter(
      (c) =>
        c.stillImage &&
        Boolean(c.file) &&
        !c.lumaHistogram?.length &&
        !analyzing.current.has(c.id) &&
        !failed.current.has(c.id),
    );
    if (pending.length === 0) return;

    const run = async () => {
      for (const clip of pending) {
        if (cancelled) break;
        analyzing.current.add(clip.id);
        try {
          const stats = await analyzeImportedStillFile(clip.file);
          if (cancelled) break;
          setClips((prev) =>
            prev.map((c) => {
              if (c.id !== clip.id || c.lumaHistogram?.length) return c;
              return {
                ...c,
                lumaHistogram: stats.lumaHistogram,
                lumaLevels: stats.lumaLevels,
                posterUrl: stats.posterUrl ?? c.posterUrl,
                gpuChoreBackend: stats.gpuChoreBackend,
                gpuChoreReason: stats.gpuChoreReason,
              };
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
