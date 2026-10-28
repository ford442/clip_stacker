import { describe, expect, it, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  MEDIA_ENGINE_CHUNK_FRAMES,
  MIX_ENTRY_STRIDE,
  __setMediaEngineKillSwitchForTests,
  _resetMediaEngineLoadStateForTests,
  formatMediaEngineDiagnostics,
  getLastMediaEngineMixBackend,
  getMediaEngineHeapBytes,
  isMediaEngineMixEnabled,
  loadMediaEngineModule,
  mixTimelineAudio,
  openTimelineMixStream,
  scheduleNeedsOfflineAudioMix,
  type ClipPcm,
  type MediaEngineMixEntry,
} from './mediaEngine';
import { EASING_PRESETS, sampleKeyframes } from '../utils/keyframes';

const WASM_BASE = pathToFileURL(
  path.resolve(process.cwd(), 'public/wasm') + path.sep,
).href;

const SAMPLE_RATE = 48000;

function makeTone(
  freq: number | number[],
  seconds: number,
  channels = 2,
  sampleRate = SAMPLE_RATE,
): ClipPcm {
  const n = Math.floor(sampleRate * seconds);
  const freqs = Array.isArray(freq) ? freq : [freq];
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const f = freqs[Math.min(ch, freqs.length - 1)]!;
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sampleRate);
    channelData.push(plane);
  }
  return { sampleRate, channelData };
}

/** `StereoPannerNode` equal-power law (Web Audio spec). */
function panFrame(pan: number, l: number, r: number, mono: boolean): [number, number] {
  if (mono) {
    const x = (pan + 1) / 2;
    return [l * Math.cos((x * Math.PI) / 2), l * Math.sin((x * Math.PI) / 2)];
  }
  if (pan === 0) return [l, r];
  const x = pan <= 0 ? pan + 1 : pan;
  const gl = Math.cos((x * Math.PI) / 2);
  const gr = Math.sin((x * Math.PI) / 2);
  return pan < 0 ? [l + r * gl, r * gr] : [l * gl, r + l * gr];
}

/**
 * Independent spec of the WASM mixer for same-rate clips on the sample grid:
 * integer-frame copy, applyGainEnvelope gain (curve × fades, clamped 0…2, or
 * volume × fades), sampleKeyframes pan, StereoPannerNode law.
 */
function referenceMix(
  schedule: MediaEngineMixEntry[],
  pcmByClipId: Record<string, ClipPcm>,
  durationSec: number,
): Float32Array {
  const outFrames = Math.ceil(durationSec * SAMPLE_RATE);
  const out = new Float64Array(outFrames * 2);
  for (const entry of schedule) {
    const clip = pcmByClipId[entry.clipId]!;
    const mono = clip.channelData.length === 1;
    const left = clip.channelData[0]!;
    const right = clip.channelData[mono ? 0 : 1]!;
    const shift = Math.round((entry.bufferOffset - entry.timelineStart) * SAMPLE_RATE);
    for (let of = 0; of < outFrames; of++) {
      const local = of / SAMPLE_RATE - entry.timelineStart;
      if (local < 0 || local >= entry.duration) continue;
      let fades = 1;
      if (entry.audioFadeIn > 0 && local < entry.audioFadeIn) fades *= local / entry.audioFadeIn;
      if (entry.audioFadeOut > 0 && local > entry.duration - entry.audioFadeOut) {
        fades *= Math.max(0, Math.min(1, (entry.duration - local) / entry.audioFadeOut));
      }
      const gain = entry.volumeAutomation?.length
        ? Math.max(0, Math.min(2, sampleKeyframes(entry.volumeAutomation, local, entry.volume) * fades))
        : entry.volume * fades;
      const pan = Math.max(-1, Math.min(1, sampleKeyframes(entry.panAutomation, local, 0)));
      const src = of + shift;
      if (src < 0 || src >= left.length) continue;
      const [l, r] = panFrame(pan, left[src]!, right[src]!, mono);
      out[of * 2] += l * gain;
      out[of * 2 + 1] += r * gain;
    }
  }
  return Float32Array.from(out);
}

function maxAbsError(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
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
    expect(await openTimelineMixStream([], {}, { baseUrl: WASM_BASE })).toBeNull();
    expect(getLastMediaEngineMixBackend()).toBe('disabled');
  });

  it('mixes two overlapping faded clips sample-exactly', async () => {
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
    expect(maxAbsError(mixed.frames, referenceMix(schedule, pcmByClipId, durationSec))).toBeLessThan(1e-6);

    const overlapStart = Math.floor(0.75 * SAMPLE_RATE) * 2;
    const overlapEnd = Math.floor(1.0 * SAMPLE_RATE) * 2;
    let overlapEnergy = 0;
    for (let i = overlapStart; i < overlapEnd; i++) {
      overlapEnergy += (mixed.frames[i] ?? 0) ** 2;
    }
    expect(overlapEnergy / (overlapEnd - overlapStart)).toBeGreaterThan(0.01);
    expect(MIX_ENTRY_STRIDE).toBe(12);
    expect(getLastMediaEngineMixBackend()).toBe('wasm');
  });

  it('premixes volume and pan keyframes through WASM', async () => {
    const pcmByClipId = {
      voice: makeTone(300, 2, 1),
      music: makeTone([500, 700], 2.5, 2),
    };
    const schedule: MediaEngineMixEntry[] = [
      {
        clipId: 'voice',
        timelineStart: 0.25,
        duration: 1.5,
        bufferOffset: 0.1,
        volume: 1,
        audioFadeIn: 0.1,
        audioFadeOut: 0.2,
        volumeAutomation: [
          { t: 0, value: 0.2 },
          { t: 0.75, value: 1.5, easing: EASING_PRESETS.easeInOut },
          { t: 1.5, value: 0.6 },
        ],
        panAutomation: [
          { t: 0, value: -1 },
          { t: 1.5, value: 1 },
        ],
      },
      {
        clipId: 'music',
        timelineStart: 0,
        duration: 2,
        bufferOffset: 0,
        volume: 0.4,
        audioFadeIn: 0,
        audioFadeOut: 0.5,
        panAutomation: [
          { t: 0.5, value: 0.5, easing: EASING_PRESETS.bellCurveSmooth },
          { t: 1.5, value: -0.5 },
        ],
      },
    ];
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    expect(scheduleNeedsOfflineAudioMix(schedule)).toBe(false);

    const mixed = await mixTimelineAudio(schedule, pcmByClipId, { durationSec: 2, baseUrl: WASM_BASE });
    expect(mixed).not.toBeNull();
    if (!mixed) return;
    expect(getLastMediaEngineMixBackend()).toBe('wasm');
    expect(maxAbsError(mixed.frames, referenceMix(schedule, pcmByClipId, 2))).toBeLessThan(2e-6);
  });

  it('treats an unknown easing type as bezier, like applyEasing', async () => {
    const pcmByClipId = { a: makeTone(250, 1.5, 2) };
    const schedule: MediaEngineMixEntry[] = [
      {
        clipId: 'a',
        timelineStart: 0,
        duration: 1,
        bufferOffset: 0,
        volume: 1,
        audioFadeIn: 0,
        audioFadeOut: 0,
        // e.g. a hand-edited project file: must not reach C++ as NaN.
        volumeAutomation: [
          { t: 0, value: 0.1, easing: { type: 'toString' as never } },
          { t: 1, value: 1.2 },
        ],
      },
    ];
    const mixed = await mixTimelineAudio(schedule, pcmByClipId, { durationSec: 1, baseUrl: WASM_BASE });
    expect(maxAbsError(mixed!.frames, referenceMix(schedule, pcmByClipId, 1))).toBeLessThan(2e-6);
  });

  it('resamples 44.1 kHz with the polyphase kernel; linear stays available', async () => {
    const tone = makeTone(1000, 2, 2, 44100);
    const schedule: MediaEngineMixEntry[] = [
      { clipId: 't', timelineStart: 0, duration: 1.5, bufferOffset: 0, volume: 1, audioFadeIn: 0, audioFadeOut: 0 },
    ];
    const errorVsAnalytic = (frames: Float32Array) => {
      let worst = 0;
      for (let of = 12000; of < 60000; of++) {
        const want = 0.5 * Math.sin((2 * Math.PI * 1000 * of) / SAMPLE_RATE);
        worst = Math.max(worst, Math.abs(frames[of * 2]! - want));
      }
      return worst;
    };
    const sinc = await mixTimelineAudio(schedule, { t: tone }, { durationSec: 1.5, baseUrl: WASM_BASE });
    const linear = await mixTimelineAudio(schedule, { t: tone }, {
      durationSec: 1.5,
      baseUrl: WASM_BASE,
      resampler: 'linear',
    });
    expect(errorVsAnalytic(sinc!.frames)).toBeLessThan(2e-5);
    expect(errorVsAnalytic(linear!.frames)).toBeGreaterThan(1e-4);
  });

  it('produces bit-identical PCM for any chunk size', async () => {
    const pcmByClipId = { a: makeTone([330, 990], 3, 2, 44100), b: makeTone(220, 3, 1, 32000) };
    const schedule: MediaEngineMixEntry[] = [
      {
        clipId: 'a',
        timelineStart: 0.1234,
        duration: 2.2,
        bufferOffset: 0.3,
        volume: 0.8,
        audioFadeIn: 0.2,
        audioFadeOut: 0.3,
        playbackRate: 1.2,
        volumeAutomation: [{ t: 0, value: 0.3 }, { t: 1, value: 1.4, easing: EASING_PRESETS.easeIn }],
        panAutomation: [{ t: 0, value: 1 }, { t: 2, value: -1 }],
      },
      {
        clipId: 'b',
        timelineStart: 0.9,
        duration: 1.5,
        bufferOffset: 0,
        volume: 0.5,
        audioFadeIn: 0,
        audioFadeOut: 0,
        playbackRate: 0.75,
      },
    ];
    const whole = await mixTimelineAudio(schedule, pcmByClipId, { durationSec: 2.5, baseUrl: WASM_BASE });
    expect(whole).not.toBeNull();
    for (const chunkFrames of [1000, 4099]) {
      const stream = await openTimelineMixStream(schedule, pcmByClipId, {
        durationSec: 2.5,
        chunkFrames,
        baseUrl: WASM_BASE,
      });
      const chunked = new Float32Array(whole!.frames.length);
      try {
        for await (const chunk of stream!) chunked.set(chunk.frames, chunk.startFrame * 2);
      } finally {
        stream!.close();
      }
      expect(Buffer.from(chunked.buffer).equals(Buffer.from(whole!.frames.buffer))).toBe(true);
    }
  });

  it('streams a >45 minute schedule in chunks without a full-length buffer', async () => {
    const durationSec = 50 * 60;
    const tone = makeTone(440, 2);
    const starts = [...Array.from({ length: 10 }, (_, i) => i * 300 + 0.5), durationSec - 1.5];
    const schedule: MediaEngineMixEntry[] = starts.map((timelineStart) => ({
      clipId: 'tone',
      timelineStart,
      duration: 2,
      bufferOffset: 0,
      volume: 0.5,
      audioFadeIn: 0,
      audioFadeOut: 0,
    }));
    const events: string[] = [];
    const stream = await openTimelineMixStream(
      schedule,
      {
        acquire: (i) => {
          events.push(`acquire ${i}`);
          return tone;
        },
        release: (i) => {
          events.push(`release ${i}`);
        },
      },
      { durationSec, baseUrl: WASM_BASE },
    );
    expect(stream).not.toBeNull();
    if (!stream) return;

    const totalFrames = durationSec * SAMPLE_RATE;
    const probes = starts.map((s) => Math.round((s + 1) * SAMPLE_RATE));
    const silentProbes = starts.slice(0, -1).map((s) => Math.round((s + 100) * SAMPLE_RATE));
    let chunks = 0;
    let frames = 0;
    let maxBackingBytes = 0;
    let probesHit = 0;
    try {
      for await (const chunk of stream) {
        chunks += 1;
        frames += chunk.frameCount;
        maxBackingBytes = Math.max(maxBackingBytes, chunk.frames.buffer.byteLength);
        const end = chunk.startFrame + chunk.frameCount;
        for (const f of probes) {
          if (f < chunk.startFrame || f >= end) continue;
          probesHit += 1;
          expect(chunk.frames[(f - chunk.startFrame) * 2]).toBe(tone.channelData[0]![SAMPLE_RATE]! * 0.5);
        }
        for (const f of silentProbes) {
          if (f >= chunk.startFrame && f < end) expect(chunk.frames[(f - chunk.startFrame) * 2]).toBe(0);
        }
      }
    } finally {
      stream.close();
    }

    expect(frames).toBe(totalFrames);
    expect(chunks).toBe(Math.ceil(totalFrames / MEDIA_ENGINE_CHUNK_FRAMES));
    expect(probesHit).toBe(probes.length);
    // Only one chunk of output ever exists in JS (a full 50-min stereo f32 mix is ~1.1 GB)…
    expect(maxBackingBytes).toBe(MEDIA_ENGINE_CHUNK_FRAMES * 2 * 4);
    // …and the WASM heap never held it either (MAXIMUM_MEMORY is 512 MB).
    expect(getMediaEngineHeapBytes()).toBeLessThan(64 * 1024 * 1024);
    // Clip PCM is requested when an entry starts and handed back once it has played.
    for (let i = 1; i < schedule.length; i++) {
      expect(events.indexOf(`release ${i - 1}`)).toBeLessThan(events.indexOf(`acquire ${i}`));
    }
    expect(events.filter((e) => e.startsWith('release'))).toHaveLength(schedule.length);
  });

  it('keeps curves on OfflineAudioContext until the module has loaded', async () => {
    const curves = [{ volumeAutomation: [{ t: 0, value: 1 }], panAutomation: [] }];
    expect(scheduleNeedsOfflineAudioMix(curves)).toBe(true);
    expect(scheduleNeedsOfflineAudioMix([{}])).toBe(false);
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    expect(scheduleNeedsOfflineAudioMix(curves)).toBe(false);
    __setMediaEngineKillSwitchForTests(true);
    expect(scheduleNeedsOfflineAudioMix(curves)).toBe(true);
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
