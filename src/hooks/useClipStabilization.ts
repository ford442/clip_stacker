import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip } from '../types';
import { clipProxyKey } from '../utils/proxyMedia';
import { proxyStore } from '../store/proxyStore';

/**
 * Analysis input for a clip: its preview proxy when one is ready (a 960p
 * decode instead of a 4K one), the original otherwise. Independent of the
 * playback toggle — the matrices are the same either way.
 */
export function stabilizationSourceFor(clip: Clip): Blob {
  const key = clipProxyKey(clip);
  return (key && proxyStore.getState().ready[key]?.blob) || clip.file;
}

/**
 * Computes stabilization matrices for clips the user has toggled `stabilize`
 * on, once each. Analysis is the expensive part (a full sequential decode plus
 * optical flow), so it runs one clip at a time in the background and the
 * result is cached on the clip.
 *
 * Matrices are deliberately not serialized with the project, so a loaded
 * project arrives with `stabilize: true` and no matrices — this hook is what
 * refills them. Failures record `stabilizeError` and are not retried, leaving
 * the clip to play unstabilized.
 */
export function useClipStabilization(
  clips: Clip[],
  setClips: Dispatch<SetStateAction<Clip[]>>,
): void {
  const analyzing = useRef(new Set<string>());
  const failed = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    const pending = clips.filter(
      (c) =>
        c.stabilize &&
        c.kind === 'video' &&
        !c.stillImage &&
        !c.stabilization &&
        Boolean(c.file) &&
        !analyzing.current.has(c.id) &&
        !failed.current.has(c.id),
    );
    if (pending.length === 0) return;

    const run = async () => {
      for (const clip of pending) {
        if (cancelled) break;
        analyzing.current.add(clip.id);
        try {
          // Decode + optical flow (and mp4box) load with the first clip that
          // needs analysis, not with the editor.
          const { stabilizeClip } = await import('../utils/stabilizePipeline');
          const result = await stabilizeClip(clip, {
            source: stabilizationSourceFor(clip),
            isCancelled: () => cancelled,
          });
          if (cancelled) break;

          if (!result.ok) {
            if (result.reason !== 'cancelled') {
              failed.current.add(clip.id);
              setClips((prev) =>
                prev.map((c) =>
                  c.id === clip.id ? { ...c, stabilizeError: result.reason } : c,
                ),
              );
            }
            continue;
          }

          setClips((prev) =>
            prev.map((c) => {
              // The user may have toggled it back off mid-analysis.
              if (c.id !== clip.id || !c.stabilize || c.stabilization) return c;
              return {
                ...c,
                stabilization: result.stabilization,
                stabilizeError: undefined,
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

/**
 * Toggle stabilization on one clip.
 *
 * Turning it off keeps the computed matrices so flipping back is instant;
 * `isStabilizationActive` gates on the toggle, not on their presence.
 */
export function setClipStabilize(clip: Clip, enabled: boolean): Clip {
  if (!enabled) return { ...clip, stabilize: false };
  return { ...clip, stabilize: true, stabilizeError: undefined };
}
