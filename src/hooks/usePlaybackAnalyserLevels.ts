import { useEffect, useState } from 'react';
import type { AudioPlaybackManager } from '../audio/playbackManager';
import {
  ZERO_ANALYSER_LEVELS,
  type AnalyserLevels,
} from '../audio/playbackManager';

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

  useEffect(() => {
    if (!active) {
      setLevels(ZERO_ANALYSER_LEVELS);
      return;
    }

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
