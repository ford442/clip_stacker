import { describe, expect, it } from 'vitest';
import {
  assembleIntercutAudio,
  buildIntercutVideoFilterGraph,
  encodeWavPcm16,
  INTERCUT_SAMPLES_PER_FRAME,
  parseWavPcm16,
  quantizeIntercutSlices,
  toStereo,
} from './intercutRender';

describe('quantizeIntercutSlices', () => {
  it('places cuts from cumulative time so rounding never drifts', () => {
    // 0.34 s = 10.2 frames each; rounding every slice would lose a frame.
    const slices = Array.from({ length: 4 }, (_, i) => ({
      slot: i % 2 === 0 ? ('A' as const) : ('B' as const),
      inpoint: i * 0.34,
      outpoint: (i + 1) * 0.34,
    }));
    const plan = quantizeIntercutSlices(slices);
    expect(plan.totalFrames).toBe(41);
    expect(plan.slices.map((s) => [s.outputFrame, s.frameCount])).toEqual([
      [0, 10],
      [10, 10],
      [20, 11],
      [31, 10],
    ]);
  });

  it('drops slices shorter than a frame without opening a gap', () => {
    const plan = quantizeIntercutSlices([
      { slot: 'A', inpoint: 0, outpoint: 0.5 },
      { slot: 'B', inpoint: 0, outpoint: 0.01 },
      { slot: 'A', inpoint: 0.5, outpoint: 1 },
    ]);
    expect(plan.slices.map((s) => s.slot)).toEqual(['A', 'A']);
    expect(plan.slices[1]!.outputFrame).toBe(15);
    expect(plan.totalFrames).toBe(30);
  });

  it('never lets two slices of one source share a frame', () => {
    // freezeHidden: A resumes exactly where it stopped, but 0.52 s rounds up to 16 frames.
    const plan = quantizeIntercutSlices([
      { slot: 'A', inpoint: 0, outpoint: 0.52 },
      { slot: 'B', inpoint: 0, outpoint: 0.3 },
      { slot: 'A', inpoint: 0.52, outpoint: 1 },
    ]);
    const [first, , third] = plan.slices;
    expect(first!.sourceFrame + first!.frameCount).toBe(16);
    expect(third!.sourceFrame).toBe(16);
  });
});

describe('buildIntercutVideoFilterGraph', () => {
  const plan = quantizeIntercutSlices([
    { slot: 'A', inpoint: 1, outpoint: 1.5 },
    { slot: 'B', inpoint: 0, outpoint: 0.5 },
    { slot: 'A', inpoint: 1.5, outpoint: 2 },
  ]);

  it('selects each slice in source frames and retimes it to its output frames', () => {
    const graph = buildIntercutVideoFilterGraph(
      plan,
      [
        { slot: 'A', inputIndex: 0 },
        { slot: 'B', inputIndex: 1 },
      ],
      1280,
      720,
    );
    const [a, b, merge] = graph.split(';');
    expect(a).toContain('[0:v]fps=30,');
    expect(a).toContain("select='between(pts,30,44)+between(pts,45,59)'");
    // A frame 30 → output 0; A frame 45 → output 30.
    expect(a).toContain("setpts='between(PTS,30,44)*(PTS+-30)+between(PTS,45,59)*(PTS+-15)'");
    expect(a).toContain('scale=1280:720:force_original_aspect_ratio=decrease');
    expect(a!.indexOf('select=')).toBeLessThan(a!.indexOf('scale='));
    expect(b).toContain("select='between(pts,0,14)'");
    expect(b).toContain("setpts='between(PTS,0,14)*(PTS+15)'");
    expect(merge).toBe('[vA][vB]interleave=nb_inputs=2[vout]');
  });

  it('skips unused sources and labels a lone source [vout]', () => {
    const solo = quantizeIntercutSlices([{ slot: 'B', inpoint: 0, outpoint: 1 }]);
    const graph = buildIntercutVideoFilterGraph(
      solo,
      [
        { slot: 'A', inputIndex: 0 },
        { slot: 'B', inputIndex: 1 },
      ],
      640,
      360,
    );
    expect(graph.startsWith('[1:v]')).toBe(true);
    expect(graph.endsWith('[vout]')).toBe(true);
    expect(graph).not.toContain('interleave');
  });
});

describe('WAV helpers', () => {
  it('round-trips 16-bit PCM', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 42]);
    const pcm = parseWavPcm16(encodeWavPcm16(samples, 44100, 2));
    expect(pcm.sampleRate).toBe(44100);
    expect(pcm.channels).toBe(2);
    expect(Array.from(pcm.samples)).toEqual(Array.from(samples));
  });

  it('skips extra chunks and trusts the bytes over an oversized data length', () => {
    const base = encodeWavPcm16(new Int16Array([5, 6, 7, 8]), 44100, 2);
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]);
    const bytes = new Uint8Array(base.length + list.length);
    bytes.set(base.subarray(0, 36));
    bytes.set(list, 36);
    bytes.set(base.subarray(36), 36 + list.length);
    new DataView(bytes.buffer).setUint32(36 + list.length + 4, 0xffffffff, true);
    expect(Array.from(parseWavPcm16(bytes).samples)).toEqual([5, 6, 7, 8]);
  });

  it('rejects non-PCM16 input', () => {
    const bytes = encodeWavPcm16(new Int16Array(2), 44100, 2);
    new DataView(bytes.buffer).setUint16(34, 24, true);
    expect(() => parseWavPcm16(bytes)).toThrow(/16-bit PCM/);
    expect(() => parseWavPcm16(new Uint8Array(8))).toThrow(/RIFF/);
  });

  it('duplicates mono to stereo', () => {
    expect(Array.from(toStereo({ sampleRate: 44100, channels: 1, samples: new Int16Array([1, 2]) }))).toEqual([
      1, 1, 2, 2,
    ]);
  });
});

describe('assembleIntercutAudio', () => {
  const spf = INTERCUT_SAMPLES_PER_FRAME;
  const constant = (value: number, frames: number) => new Int16Array(frames * spf * 2).fill(value);
  const left = (pcm: Int16Array, sample: number) => pcm[sample * 2]!;

  it('is exactly totalFrames long and cuts on the frame boundary', () => {
    const out = assembleIntercutAudio({
      slices: [
        { slot: 'A', sourceFrame: 0, outputFrame: 0, frameCount: 3 },
        { slot: 'B', sourceFrame: 0, outputFrame: 3, frameCount: 2 },
      ],
      totalFrames: 5,
      sources: { A: constant(1000, 10), B: constant(-1000, 10) },
      crossfadeSamples: 0,
    });
    expect(out.length).toBe(5 * spf * 2);
    expect(left(out, 3 * spf - 1)).toBe(1000);
    expect(left(out, 3 * spf)).toBe(-1000);
    expect(left(out, 5 * spf - 1)).toBe(-1000);
  });

  it('reads each slice from its own source offset', () => {
    const ramp = new Int16Array(10 * spf * 2);
    for (let i = 0; i < ramp.length / 2; i++) ramp[i * 2] = Math.floor(i / spf);
    const out = assembleIntercutAudio({
      slices: [{ slot: 'A', sourceFrame: 7, outputFrame: 0, frameCount: 2 }],
      totalFrames: 2,
      sources: { A: ramp },
    });
    expect(left(out, 0)).toBe(7);
    expect(left(out, spf)).toBe(8);
  });

  it('crossfades a cut with equal power and leaves continuations alone', () => {
    const fade = 100;
    const out = assembleIntercutAudio({
      slices: [
        { slot: 'A', sourceFrame: 0, outputFrame: 0, frameCount: 2 },
        { slot: 'B', sourceFrame: 0, outputFrame: 2, frameCount: 2 },
        { slot: 'B', sourceFrame: 2, outputFrame: 4, frameCount: 2 },
      ],
      totalFrames: 6,
      sources: { A: constant(10000, 10), B: constant(0, 10) },
      crossfadeSamples: fade,
    });
    const cut = 2 * spf;
    // Outgoing A fades out over the first `fade` samples of B's slice.
    expect(left(out, cut)).toBeGreaterThan(9990);
    const mid = fade / 2;
    expect(left(out, cut + mid)).toBe(Math.round(10000 * Math.cos((Math.PI / 2) * ((mid + 0.5) / fade))));
    expect(left(out, cut + fade)).toBe(0);
    // B → B continuing on the next source frame is not a cut: no A bleeds in.
    expect(left(out, 4 * spf)).toBe(0);
  });

  it('fills missing sources and reads past their end with silence', () => {
    const out = assembleIntercutAudio({
      slices: [
        { slot: 'A', sourceFrame: 0, outputFrame: 0, frameCount: 2 },
        { slot: 'C', sourceFrame: 0, outputFrame: 2, frameCount: 1 },
      ],
      totalFrames: 3,
      sources: { A: constant(500, 1) },
      crossfadeSamples: 0,
    });
    expect(left(out, 0)).toBe(500);
    expect(left(out, spf)).toBe(0);
    expect(left(out, 2 * spf)).toBe(0);
  });
});
