import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import {
  buildIntercutAudioExtractArgs,
  buildIntercutRenderArgs,
  buildIntercutSourceInputArgs,
  estimateIntercut,
  generateIntercutFromVfs,
  intercutAudioSlices,
  intercutNeedsNormalization,
} from './intercutGenerator';
import { encodeWavPcm16, parseWavPcm16, quantizeIntercutSlices } from '../utils/intercutRender';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-a',
    file: new File([], 'a.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:a',
    title: 'a.mp4',
    kind: 'video',
    duration: 10,
    videoWidth: 1280,
    videoHeight: 720,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('intercutGenerator helpers', () => {
  it('detects resolution mismatch as needing normalization', () => {
    const a = makeClip();
    const b = makeClip({
      id: 'clip-b',
      videoWidth: 1920,
      videoHeight: 1080,
      file: new File([], 'b.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(a, b)).toBe(true);
    expect(intercutNeedsNormalization(a, makeClip({ id: 'clip-b2' }))).toBe(false);
  });

  it('detects fps and container mismatch', () => {
    const a = makeClip({ originalFps: 24 });
    const b = makeClip({
      id: 'b',
      originalFps: 30,
      file: new File([], 'b.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(a, b)).toBe(true);

    const webm = makeClip({
      id: 'w',
      file: new File([], 'b.webm', { type: 'video/webm' }),
    });
    expect(intercutNeedsNormalization(a, webm)).toBe(true);
  });

  it('detects audio-stream mismatch as needing normalization', () => {
    const withAudio = makeClip();
    const silent = makeClip({
      id: 'clip-b',
      hasAudio: false,
      file: new File([], 'b.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(withAudio, silent)).toBe(true);
    expect(intercutNeedsNormalization(withAudio, makeClip({ id: 'clip-b2' }))).toBe(false);
  });

  it('detects a third-clip mismatch as needing normalization', () => {
    const a = makeClip();
    const b = makeClip({ id: 'clip-b', file: new File([], 'b.mp4', { type: 'video/mp4' }) });
    const c = makeClip({
      id: 'clip-c',
      videoWidth: 1920,
      videoHeight: 1080,
      file: new File([], 'c.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(a, b, c)).toBe(true);
    expect(intercutNeedsNormalization(a, b, makeClip({ id: 'clip-c2' }))).toBe(false);
  });

  it('estimate flags shortage and always reports re-encode', () => {
    const long = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 4,
        startFrequencyHz: 1,
        endFrequencyHz: 1,
      },
    });
    expect(long.shortageMessage).toBeNull();
    // Generation always re-encodes (stream-copy is unsafe for alternating inpoints).
    expect(long.usedStreamCopy).toBe(false);
    expect(long.sliceCount).toBeGreaterThan(0);

    const strobe = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 2,
        startFrequencyHz: 8,
        endFrequencyHz: 12,
      },
    });
    expect(strobe.usedStreamCopy).toBe(false);

    const short = estimateIntercut({
      clipA: makeClip({ duration: 0.2, trimEnd: 0.2 }),
      clipB: makeClip({ id: 'b', duration: 10, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 5,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });
    expect(short.shortageMessage).toMatch(/only cover/i);
  });

  it('estimate includes tail duration and honors forced landing clip', () => {
    const withTail = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 0.4,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'B',
      tailDurationSec: 2,
    });
    expect(withTail.shortageMessage).toBeNull();
    expect(withTail.outputDurationSec).toBeCloseTo(2.4, 5);
    expect(withTail.slices[withTail.slices.length - 1]!.slot).toBe('B');
  });

  it('estimate plans A/B/C slices when clip C is set', () => {
    const triple = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      clipC: makeClip({ id: 'c', duration: 30, trimEnd: 30, file: new File([], 'c.mp4') }),
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });
    expect(triple.shortageMessage).toBeNull();
    expect(triple.slices.map((s) => s.slot)).toEqual(['A', 'B', 'C']);
  });
});

describe('intercut frame-grid render args', () => {
  it('seeks video sources to their trim start and loops stills at 30fps', () => {
    expect(buildIntercutSourceInputArgs(makeClip(), 'a.mp4', 1.5, 4)).toEqual([
      '-ss',
      '1.5',
      '-t',
      '4',
      '-i',
      'a.mp4',
    ]);
    expect(buildIntercutSourceInputArgs(makeClip(), 'a.mp4', 0, 2)).toEqual([
      '-t',
      '2',
      '-i',
      'a.mp4',
    ]);
    const still = makeClip({ stillImage: true, file: new File([], 's.png', { type: 'image/png' }) });
    expect(buildIntercutSourceInputArgs(still, 's.png', 3, 2)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '2',
      '-i',
      's.png',
    ]);
  });

  it('decodes audio to stereo 44.1k PCM starting at sample 0 of the trim window', () => {
    const args = buildIntercutAudioExtractArgs('a.mp4', 'a.wav', 1.25, 3);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('1.25');
    expect(args[args.indexOf('-t') + 1]).toBe('3');
    expect(args[args.indexOf('-af') + 1]).toBe('aresample=44100:async=1:first_pts=0');
    expect(args[args.indexOf('-c:a') + 1]).toBe('pcm_s16le');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args.at(-1)).toBe('a.wav');
  });

  it('render args encode the graph and the spliced WAV in one CFR pass without concat', () => {
    const args = buildIntercutRenderArgs({
      sourceInputs: [
        ['-t', '1', '-i', 'a.mp4'],
        ['-t', '1', '-i', 'b.mp4'],
      ],
      audioName: 'audio.wav',
      filterGraph: '[0:v]null[vout]',
      totalFrames: 42,
      outputName: 'out.mp4',
    });
    expect(args).not.toContain('concat');
    expect(args).not.toContain('+genpts');
    expect(args[args.indexOf('-map') + 1]).toBe('[vout]');
    expect(args).toContain('2:a:0');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('42');
    expect(args[args.indexOf('-r') + 1]).toBe('30');
    expect(args[args.indexOf('-vsync') + 1]).toBe('cfr');
    expect(args[args.indexOf('-bf') + 1]).toBe('0');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
  });

  it('audio policy picks per-slice sound, continuous A, or nothing', () => {
    const plan = quantizeIntercutSlices([
      { slot: 'A', inpoint: 0, outpoint: 0.5 },
      { slot: 'B', inpoint: 0, outpoint: 0.5 },
    ]);
    expect(intercutAudioSlices('both', plan)).toBe(plan.slices);
    expect(intercutAudioSlices('aOnly', plan)).toEqual([
      { slot: 'A', sourceFrame: 0, outputFrame: 0, frameCount: 30 },
    ]);
    expect(intercutAudioSlices('silent', plan)).toEqual([]);
  });
});

/** In-memory FFmpeg double: audio decodes yield a constant per-source level. */
function fakeRuntime(levels: Record<string, number | null>) {
  const files = new Map<string, Uint8Array | string>();
  const execs: string[][] = [];
  const runtime: IFfmpegRuntime = {
    async exec(args) {
      execs.push(args);
      const out = args.at(-1)!;
      if (out.endsWith('.wav')) {
        const input = args[args.indexOf('-i') + 1]!;
        const level = levels[input];
        if (level === null) throw new Error('Stream map 0:a:0 matches no streams.');
        const seconds = Number(args[args.indexOf('-t') + 1]);
        const pcm = new Int16Array(Math.round(seconds * 44100) * 2).fill(level ?? 0);
        files.set(out, encodeWavPcm16(pcm, 44100, 2));
      } else {
        files.set(out, new Uint8Array(64));
      }
      return 0;
    },
    async writeFile(name, data) {
      files.set(name, data);
      return true;
    },
    async readFile(name) {
      const data = files.get(name);
      if (!data) throw new Error(`missing ${name}`);
      return data;
    },
    async deleteFile(name) {
      return files.delete(name);
    },
    async listDir() {
      return [];
    },
    terminate() {},
  };
  return { runtime, files, execs };
}

describe('generateIntercutFromVfs', () => {
  const clipA = makeClip({ duration: 10, trimStart: 1, trimEnd: 10 });
  const clipB = makeClip({
    id: 'clip-b',
    title: 'b.mp4',
    duration: 10,
    trimEnd: 10,
    file: new File([], 'b.mp4', { type: 'video/mp4' }),
  });
  const automation = { totalDurationSec: 2, startFrequencyHz: 2, endFrequencyHz: 2 };

  async function run(
    audioPolicy: 'both' | 'aOnly' | 'silent',
    levels: Record<string, number | null> = { 'a.mp4': 1000, 'b.mp4': -2000 },
  ) {
    const fake = fakeRuntime(levels);
    let writtenAudio: Uint8Array | undefined;
    const writeFile = fake.runtime.writeFile.bind(fake.runtime);
    fake.runtime.writeFile = async (name, data) => {
      if (name === 'intercut-audio.wav') writtenAudio = data as Uint8Array;
      return writeFile(name, data);
    };
    const result = await generateIntercutFromVfs(
      fake.runtime,
      'a.mp4',
      'b.mp4',
      { clipA, clipB, automation, audioPolicy },
      () => {},
      'out.mp4',
    );
    return { ...fake, result, audio: parseWavPcm16(writtenAudio!) };
  }

  it('splices each slice’s own sound on the frame grid and renders once', async () => {
    const { execs, result, audio, files } = await run('both');
    expect(result.outputDurationSec).toBe(2);
    // Two audio decodes (seeked to each trim start) + one render; no concat demuxer.
    expect(execs).toHaveLength(3);
    expect(execs[0]).toEqual(expect.arrayContaining(['-ss', '1', '-i', 'a.mp4']));
    expect(execs.flat()).not.toContain('concat');
    const render = execs[2]!;
    expect(render[render.indexOf('-frames:v') + 1]).toBe('60');
    expect(render[render.indexOf('-filter_complex') + 1]).toContain('interleave=nb_inputs=2');

    // Exactly 60 frames × 1470 samples, A's level then B's (2 Hz → 0.5 s slices).
    expect(audio.samples.length).toBe(60 * 1470 * 2);
    const at = (sec: number) => audio.samples[Math.round(sec * 44100) * 2]!;
    expect(at(0.25)).toBe(1000);
    expect(at(0.75)).toBe(-2000);
    expect(at(1.25)).toBe(1000);
    expect(at(1.75)).toBe(-2000);
    // Scratch files are cleaned up.
    expect([...files.keys()].filter((n) => n.endsWith('.wav'))).toEqual([]);
  });

  it('aOnly decodes only A and keeps it continuous', async () => {
    const { execs, audio } = await run('aOnly');
    expect(execs).toHaveLength(2);
    expect(audio.samples.every((v) => v === 1000)).toBe(true);
  });

  it('silent renders a zero track without decoding any source audio', async () => {
    const { execs, audio } = await run('silent');
    expect(execs).toHaveLength(1);
    expect(audio.samples.length).toBe(60 * 1470 * 2);
    expect(audio.samples.every((v) => v === 0)).toBe(true);
  });

  it('a source without an audio stream contributes silence instead of failing', async () => {
    const { audio } = await run('both', { 'a.mp4': 1000, 'b.mp4': null });
    const at = (sec: number) => audio.samples[Math.round(sec * 44100) * 2]!;
    expect(at(0.25)).toBe(1000);
    expect(at(0.75)).toBe(0);
  });
});

