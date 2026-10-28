import { useEffect, type RefObject } from 'react';
import { clampClipVolume } from '../utils/audioVolume';
import { getSharedAudioContext, resumeAudioContext } from '../audio/context';

/** Web Audio routing for one media element: element → gain → destination. */
interface MediaRouting {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  connected: boolean;
}

/**
 * `createMediaElementSource` may be called **once** per element — a second
 * call throws `InvalidStateError`, and the element stays bound to the first
 * context. So the routing lives as long as the element does, keyed by it, and
 * a volume change only moves the gain.
 */
const routings = new WeakMap<HTMLMediaElement, MediaRouting>();

/** Gain smoothing time constant — long enough to avoid zipper clicks. */
const GAIN_SMOOTHING_SEC = 0.015;

function routeMedia(media: HTMLMediaElement): MediaRouting | null {
  const existing = routings.get(media);
  if (existing) {
    if (!existing.connected) {
      existing.gain.connect(existing.ctx.destination);
      existing.connected = true;
    }
    return existing;
  }
  try {
    const ctx = getSharedAudioContext();
    const source = ctx.createMediaElementSource(media);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    const routing: MediaRouting = { ctx, source, gain, connected: true };
    routings.set(media, routing);
    return routing;
  } catch {
    return null;
  }
}

/**
 * Applies per-clip volume (0–200%) to a media element. Values outside the
 * native 0–1 `HTMLMediaElement.volume` range need Web Audio, so the element is
 * routed through a gain on the shared preview context; if that is unavailable
 * the native volume (capped at 100%) is used instead.
 */
export function useMediaVolume(
  mediaRef: RefObject<HTMLMediaElement | null>,
  volume: number | undefined,
  mediaKey: string,
): void {
  const clamped = clampClipVolume(volume);

  // Element lifetime: route once, resume the context when playback starts
  // (covers a play that is not itself a pointer/key gesture), and unhook the
  // gain on unmount. The source node stays bound to the element by design.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const routing = routeMedia(media);
    if (!routing) return;
    media.muted = false;
    media.volume = 1;
    const onPlay = () => resumeAudioContext(routing.ctx);
    media.addEventListener('play', onPlay);
    return () => {
      media.removeEventListener('play', onPlay);
      if (routing.connected) {
        routing.gain.disconnect();
        routing.connected = false;
      }
    };
  }, [mediaRef, mediaKey]);

  // Volume: only the gain moves.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const routing = routings.get(media);
    if (routing) {
      routing.gain.gain.setTargetAtTime(clamped, routing.ctx.currentTime, GAIN_SMOOTHING_SEC);
      return;
    }
    media.volume = clamped <= 0 ? 0 : Math.min(1, clamped);
    media.muted = clamped <= 0;
  }, [mediaRef, clamped, mediaKey]);
}
