import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip } from '../types';
import { decodeAudioBuffer } from '../utils/waveform';
import { AudioAnalysisWorkerClient } from '../wasm/audioAnalysisClient';
import {
  analyzeAudioBuffer,
  applyBeatMetadata,
  type OfflineAnalysisResult,
} from '../wasm/offlineAnalysis';

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      out[i]! += data[i]! / numberOfChannels;
    }
  }
  return out;
}

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
  const clientRef = useRef<AudioAnalysisWorkerClient | null>(null);

  useEffect(() => {
    return () => {
      clientRef.current?.destroy();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const Ctx =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
    if (!Ctx) return;

    const pending = clips.filter(
      (c) =>
        !c.beatTimestamps?.length &&
        !analyzing.current.has(c.id) &&
        !failed.current.has(c.id) &&
        Boolean(c.objectUrl),
    );
    if (pending.length === 0) return;

    const run = async () => {
      let ctx: AudioContext | null = null;
      try {
        ctx = new Ctx();
      } catch {
        return;
      }

      if (!clientRef.current) {
        const client = new AudioAnalysisWorkerClient();
        if (client.start()) clientRef.current = client;
      }

      for (const clip of pending) {
        if (cancelled) break;
        analyzing.current.add(clip.id);
        try {
          const buffer = await decodeAudioBuffer(clip.objectUrl, ctx);
          if (cancelled) break;

          let result: OfflineAnalysisResult;
          const client = clientRef.current;
          if (client?.available) {
            const pcm = mixToMono(buffer);
            result = await client.analyzeOffline(pcm, buffer.sampleRate);
          } else {
            result = await analyzeAudioBuffer(buffer);
          }

          if (!result.available) {
            failed.current.add(clip.id);
            continue;
          }
          if (result.beatTimestamps.length === 0) {
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

      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [clips, setClips]);
}
