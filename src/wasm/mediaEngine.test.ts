import { describe, expect, it, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  MIX_ENTRY_STRIDE,
  __setMediaEngineKillSwitchForTests,
  _resetMediaEngineLoadStateForTests,
  formatMediaEngineDiagnostics,
  isMediaEngineMixEnabled,
  mixTimelineAudio,
  type ClipPcm,
  type MediaEngineMixEntry,
} from './mediaEngine';

const WASM_BASE = pathToFileURL(
  path.resolve(process.cwd(), 'public/wasm') + path.sep,
).href;

const SAMPLE_RATE = 48000;

function makeTone(freq: number, seconds: number, channels = 2): ClipPcm {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const frames = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    for (let ch = 0; ch < channels; ch++) frames[i * channels + ch] = s;
  }
  return { sampleRate: SAMPLE_RATE, channels, frames };
}

/** Independent spec of the C++ mixer (linear fade, same-rate copy). */
function referenceMix(
  schedule: MediaEngineMixEntry[],
  pcmByClipId: Record<string, ClipPcm>,
  durationSec: number,
): Float32Array {
  const outFrames = Math.ceil(durationSec * SAMPLE_RATE);
  const out = new Float32Array(outFrames * 2);
  for (const entry of schedule) {
    const clip = pcmByClipId[entry.clipId];
    if (!clip) continue;
    const ch = clip.channels;
    const srcFrames = clip.frames.length / ch;
    const rate = entry.playbackRate && entry.playbackRate > 0 ? entry.playbackRate : 1;
    for (let of = 0; of < outFrames; of++) {
      const t = of / SAMPLE_RATE;
      const local = t - entry.timelineStart;
      if (local < 0 || local >= entry.duration) continue;
      let gain = entry.volume;
      if (entry.audioFadeIn > 0 && local < entry.audioFadeIn) {
        gain *= local / entry.audioFadeIn;
      }
      if (entry.audioFadeOut > 0 && local > entry.duration - entry.audioFadeOut) {
        gain *= Math.max(0, Math.min(1, (entry.duration - local) / entry.audioFadeOut));
      }
      const srcFrame = (entry.bufferOffset + local * rate) * clip.sampleRate;
      if (srcFrame < 0 || srcFrame >= srcFrames) continue;
      const i0 = Math.min(srcFrames - 1, Math.floor(srcFrame));
      const i1 = Math.min(srcFrames - 1, i0 + 1);
      const frac = srcFrame - i0;
      const sample = (idx: number, c: number) =>
        clip.frames[idx * ch + Math.min(c, ch - 1)] ?? 0;
      const l = sample(i0, 0) + (sample(i1, 0) - sample(i0, 0)) * frac;
      const r = sample(i0, 1) + (sample(i1, 1) - sample(i0, 1)) * frac;
      out[of * 2] += l * gain;
      out[of * 2 + 1] += r * gain;
    }
  }
  return out;
}

function meanAbsError(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return s / n;
}

function quantizedFingerprint(pcm: Float32Array): string {
  let h = 2166136261;
  for (let i = 0; i < pcm.length; i++) {
    const q = Math.max(-128, Math.min(127, Math.round((pcm[i] ?? 0) * 127)));
    h ^= q + (i | 0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('mediaEngine WASM', () => {
  beforeEach(() => {
    _resetMediaEngineLoadStateForTests();
  });

  it('honors ?no_media_engine kill switch', () => {
    expect(isMediaEngineMixEnabled('')).toBe(true);
    expect(isMediaEngineMixEnabled('?no_media_engine')).toBe(false);
    __setMediaEngineKillSwitchForTests(true);
    expect(isMediaEngineMixEnabled()).toBe(false);
    expect(formatMediaEngineDiagnostics()).toMatch(/disabled/);
  });

  it('returns null when WASM is disabled without throwing', async () => {
    __setMediaEngineKillSwitchForTests(true);
    const mixed = await mixTimelineAudio([], {}, { baseUrl: WASM_BASE });
    expect(mixed).toBeNull();
  });

  it('mixes two overlapping faded clips within PCM tolerance', async () => {
    const clipA = makeTone(440, 1);
    const clipB = makeTone(880, 1);
    const schedule: MediaEngineMixEntry[] = [
      {
        clipId: 'a',
        timelineStart: 0,
        duration: 1,
        bufferOffset: 0,
        volume: 1,
        audioFadeIn: 0,
        audioFadeOut: 0.25,
      },
      {
        clipId: 'b',
        timelineStart: 0.75,
        duration: 1,
        bufferOffset: 0,
        volume: 1,
        audioFadeIn: 0.25,
        audioFadeOut: 0,
      },
    ];
    const pcmByClipId = { a: clipA, b: clipB };
    const durationSec = 1.75;

    const mixed = await mixTimelineAudio(schedule, pcmByClipId, {
      sampleRate: SAMPLE_RATE,
      durationSec,
      baseUrl: WASM_BASE,
    });
    expect(mixed).not.toBeNull();
    if (!mixed) return;

    expect(mixed.sampleRate).toBe(SAMPLE_RATE);
    expect(mixed.channels).toBe(2);
    expect(mixed.frames.length).toBe(Math.ceil(durationSec * SAMPLE_RATE) * 2);

    const expected = referenceMix(schedule, pcmByClipId, durationSec);
    expect(meanAbsError(mixed.frames, expected)).toBeLessThan(1e-4);

    const overlapStart = Math.floor(0.75 * SAMPLE_RATE) * 2;
    const overlapEnd = Math.floor(1.0 * SAMPLE_RATE) * 2;
    let overlapEnergy = 0;
    for (let i = overlapStart; i < overlapEnd; i++) {
      overlapEnergy += (mixed.frames[i] ?? 0) ** 2;
    }
    expect(overlapEnergy / (overlapEnd - overlapStart)).toBeGreaterThan(0.05);

    const fp = quantizedFingerprint(mixed.frames);
    const expectedFp = quantizedFingerprint(expected);
    expect(fp).toBe(expectedFp);
    expect(MIX_ENTRY_STRIDE).toBe(8);
  });

  it('disables cleanly when the module URL is missing', async () => {
    _resetMediaEngineLoadStateForTests();
    const mixed = await mixTimelineAudio(
      [
        {
          clipId: 'a',
          timelineStart: 0,
          duration: 0.1,
          bufferOffset: 0,
          volume: 1,
          audioFadeIn: 0,
          audioFadeOut: 0,
        },
      ],
      { a: makeTone(440, 0.1) },
      { baseUrl: 'file:///nonexistent-wasm-dir/' },
    );
    expect(mixed).toBeNull();
    expect(formatMediaEngineDiagnostics()).toMatch(/unavailable/i);
  });
});
