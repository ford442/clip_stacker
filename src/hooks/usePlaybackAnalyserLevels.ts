import { useEffect, useState } from 'react';
import type { AudioPlaybackManager } from '../playback/playbackManager';
import {
  ZERO_ANALYSER_LEVELS,
  type AnalyserLevels,
} from '../playback/playbackManager';

/**
 * Polls the playback AnalyserNode while the timeline is playing so meters /
 * reactive UI can follow the Web Audio clock.
 */
export function usePlaybackAnalyserLevels(
  manager: AudioPlaybackManager,
  active: boolean,
  fps = 30,
): AnalyserLevels {
  const [levels, setLevels] = useState<AnalyserLevels>(ZERO_ANALYSER_LEVELS);
  // Meters drop to zero while inactive (adjusted during render).
  if (!active && levels !== ZERO_ANALYSER_LEVELS) setLevels(ZERO_ANALYSER_LEVELS);

  useEffect(() => {
    if (!active) return;

    let raf = 0;
    let last = 0;
    const minDelta = 1000 / Math.max(1, fps);

    const tick = (now: number) => {
      if (now - last >= minDelta) {
        last = now;
        setLevels(manager.readAnalyserLevels());
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [manager, active, fps]);

  return levels;
}
