import { useEffect, useRef, type RefObject } from 'react';
import { clampClipVolume } from '../utils/audioVolume';

/**
 * Applies per-clip volume (0–200%) to a media element. Values outside the
 * native 0–1 `HTMLMediaElement.volume` range are routed through Web Audio.
 */
export function useMediaVolume(
  mediaRef: RefObject<HTMLMediaElement | null>,
  volume: number | undefined,
  mediaKey: string,
): void {
  const routingRef = useRef<{
    ctx: AudioContext;
    gain: GainNode;
    media: HTMLMediaElement;
  } | null>(null);
  const clamped = clampClipVolume(volume);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const applyNativeVolume = () => {
      media.volume = clamped <= 0 ? 0 : Math.min(1, clamped);
      media.muted = clamped <= 0;
    };

    const existing = routingRef.current;
    if (existing?.media === media) {
      existing.gain.gain.value = clamped;
      media.muted = false;
      return;
    }

    routingRef.current?.ctx.close().catch(() => undefined);
    routingRef.current = null;

    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(media);
      const gain = ctx.createGain();
      gain.gain.value = clamped;
      source.connect(gain);
      gain.connect(ctx.destination);
      media.muted = false;
      routingRef.current = { ctx, gain, media };
    } catch {
      applyNativeVolume();
    }

    return () => {
      if (routingRef.current?.media === media) {
        routingRef.current.ctx.close().catch(() => undefined);
        routingRef.current = null;
      }
    };
  }, [mediaRef, clamped, mediaKey]);
}
