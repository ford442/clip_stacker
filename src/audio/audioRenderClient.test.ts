import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
import { createBusEffect } from '../utils/audioBus';
import { planBusGraph } from './fxGraph';
import {
  _resetMediaEngineLoadStateForTests,
  __setMediaEngineKillSwitchForTests,
  openTimelineMixStream,
  type ClipPcm,
  type ClipPcmProvider,
  type MediaEngineMixEntry,
  type TimelineMixStreamOptions,
} from '../wasm/mediaEngine';
import { __setAudioRenderWorkerFactoryForTests, openMixStream, type MixStream, type RenderWorkerLike } from './audioRenderClient';
import { AudioRenderWorkerCore } from './audioRender.worker';
import { PCM_PART_FRAMES, type RenderWorkerRequest, type RenderWorkerResponse } from './audioRenderProtocol';

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;
const RATE = 48_000;

/** Client and worker core joined in-process, through structuredClone with transfer (as postMessage). */
class InProcessRenderWorker implements RenderWorkerLike {
  onmessage: ((ev: MessageEvent<RenderWorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly received: RenderWorkerRequest[] = [];
  readonly sent: RenderWorkerResponse[] = [];
  terminated = false;
  private readonly core = new AudioRenderWorkerCore((message, transfer) => {
    const copy = structuredClone(message, { transfer: transfer ?? [] });
    this.sent.push(copy);
    setTimeout(() => this.onmessage?.({ data: copy } as MessageEvent<RenderWorkerResponse>), 0);
  });
  postMessage(message: RenderWorkerRequest, transfer: Transferable[]): void {
    const copy = structuredClone(message, { transfer });
    this.received.push(copy);
    queueMicrotask(() => this.core.handle(copy));
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function tone(seconds: number, hz: number, level: number): ClipPcm {
  const n = Math.round(seconds * RATE);
  const planes = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 0.5 * t));
    planes[0]![i] = level * env * Math.sin(2 * Math.PI * hz * t);
    planes[1]![i] = level * env * Math.sin(2 * Math.PI * (hz + 3) * t);
  }
  return { sampleRate: RATE, channelData: planes };
}

const tracks = (): Track[] => [
  { id: 'dialogue', kind: 'video', items: [], audioFx: [createBusEffect('compressor')] },
  {
    id: 'music',
    kind: 'audio',
    items: [],
    duck: { sourceTrackId: 'dialogue', depthDb: 9, thresholdDb: -40, attack: 0.05, hold: 0.2, release: 0.5 },
  },
];

async function collect(stream: MixStream): Promise<Float32Array> {
  const out = new Float32Array(stream.totalFrames * stream.channels);
  try {
    for await (const chunk of stream) out.set(chunk.frames, chunk.startFrame * stream.channels);
  } finally {
    stream.close();
  }
  return out;
}

describe('export premix in the audio render worker', () => {
  beforeEach(() => {
    _resetMediaEngineLoadStateForTests();
  });
  afterEach(() => {
    __setAudioRenderWorkerFactoryForTests(undefined);
    __setMediaEngineKillSwitchForTests(null);
    _resetMediaEngineLoadStateForTests();
    vi.restoreAllMocks();
  });

  it('mixes lane buses in the worker, bit for bit with the in-realm stream', async () => {
    // Long enough that each clip's PCM crosses in more than one slice.
    const seconds = Math.ceil((PCM_PART_FRAMES * 1.3) / RATE);
    const pcm = [tone(seconds, 220, 0.4), tone(seconds, 330, 0.3)];
    const plan = planBusGraph(tracks(), { fx: [createBusEffect('limiter')] });
    const entries: MediaEngineMixEntry[] = ['dialogue', 'music'].map((id) => ({
      clipId: id,
      timelineStart: 0.25,
      duration: seconds - 0.5,
      bufferOffset: 0.1,
      volume: 0.9,
      audioFadeIn: 0.05,
      audioFadeOut: 0.05,
      bus: plan.laneIndex.get(id)!,
    }));
    const options: TimelineMixStreamOptions = {
      baseUrl: WASM_BASE,
      sampleRate: RATE,
      durationSec: seconds,
      chunkFrames: 96_000,
      bus: plan,
      meter: true,
    };
    const released: number[] = [];
    const provider = (): ClipPcmProvider => ({
      acquire: (index) => pcm[index]!,
      release: (index) => released.push(index),
    });

    const reference = await openTimelineMixStream(entries, provider(), options);
    expect(reference).not.toBeNull();
    const want = await (async () => {
      const out = new Float32Array(reference!.totalFrames * 2);
      for await (const chunk of reference!) out.set(chunk.frames, chunk.startFrame * 2);
      return { out, meters: reference!.readMeters() };
    })();
    reference!.close();
    released.length = 0;

    const worker = new InProcessRenderWorker();
    __setAudioRenderWorkerFactoryForTests(() => worker);
    const stream = await openMixStream(entries, provider(), options);
    expect(stream).not.toBeNull();
    expect(stream!.totalFrames).toBe(reference!.totalFrames);
    const out = new Float32Array(stream!.totalFrames * 2);
    for await (const chunk of stream!) out.set(chunk.frames, chunk.startFrame * 2);
    const meters = stream!.readMeters();
    stream!.close();

    let mismatches = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== want.out[i]) mismatches++;
    expect(mismatches).toBe(0);
    expect(meters).toEqual(want.meters);
    // The worker asked for each clip once, in slices, and released both.
    expect(worker.sent.filter((m) => m.type === 'need-pcm').map((m) => (m as { index: number }).index)).toEqual([0, 1]);
    expect(worker.received.filter((m) => m.type === 'pcm-part').length).toBe(2 * 2 * 2);
    expect(released.sort()).toEqual([0, 1]);
    // The page's resampler choice and wasm base travel with the stream.
    const open = worker.received.find((m) => m.type === 'open') as Extract<RenderWorkerRequest, { type: 'open' }>;
    expect(open.options.resampler).toBe('polyphase');
    expect(open.options.baseUrl).toBe(WASM_BASE);
  }, 60_000);

  it('aborts the stream when a clip fails to decode', async () => {
    __setAudioRenderWorkerFactoryForTests(() => new InProcessRenderWorker());
    const stream = await openMixStream(
      [{ clipId: 'a', timelineStart: 0, duration: 1, bufferOffset: 0, volume: 1, audioFadeIn: 0, audioFadeOut: 0 }],
      {
        acquire: () => {
          throw new Error('Could not decode audio for clip "a"');
        },
      },
      { baseUrl: WASM_BASE, sampleRate: RATE, durationSec: 1 },
    );
    expect(stream).not.toBeNull();
    await expect(collect(stream!)).rejects.toThrow(/Could not decode audio for clip "a"/);
  });

  it('fails an open stream when the worker dies, so export can fall back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = new InProcessRenderWorker();
    __setAudioRenderWorkerFactoryForTests(() => worker);
    let release: () => void = () => {};
    const stream = await openMixStream(
      [{ clipId: 'a', timelineStart: 0, duration: 1, bufferOffset: 0, volume: 1, audioFadeIn: 0, audioFadeOut: 0 }],
      { acquire: () => new Promise<ClipPcm>((resolve) => (release = () => resolve(tone(1, 440, 0.2)))) },
      { baseUrl: WASM_BASE, sampleRate: RATE, durationSec: 1 },
    );
    const pending = collect(stream!);
    await new Promise((r) => setTimeout(r, 10));
    worker.crash('out of memory');
    release();
    await expect(pending).rejects.toThrow(/audio render worker failed: out of memory/);
    expect(worker.terminated).toBe(true);
  });

  it('stays on this thread under ?no_media_engine (and returns no stream)', async () => {
    const factory = vi.fn(() => new InProcessRenderWorker());
    __setAudioRenderWorkerFactoryForTests(factory);
    __setMediaEngineKillSwitchForTests(true);
    const stream = await openMixStream([], { acquire: () => null }, { baseUrl: WASM_BASE });
    expect(stream).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
});
