import { describe, expect, it } from 'vitest';
import type { Clip, TextOverlay } from '../../types';
import { buildPreviewCompositionPlan } from '../../composition/previewComposition';
import { createTestClip } from '../../project/project.test.helpers';
import { quantizePlan } from '../renderKey';
import {
  inBandAvcCodec,
  parseAvcDecoderConfig,
  passthroughFrame,
  passthroughRuns,
  planCopy,
  smartRenderBlockers,
  sourceCopyBlocker,
  withInBandParameterSets,
  type PassthroughFrame,
  type SourcePacket,
} from './smartRender';

const FRAME = 33_333;

function clip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return { ...createTestClip(id, duration), videoWidth: 640, videoHeight: 360, ...overrides };
}

function planAt(clips: Clip[], t: number, overlays: TextOverlay[] = []) {
  return quantizePlan(
    buildPreviewCompositionPlan(clips, [], [], overlays, { outputResolution: '640x360' }, t, 360, 640),
  );
}

/** An avcC with one SPS and one PPS. */
function avcC(sps: number[], pps: number[], lengthSizeMinusOne = 3): Uint8Array {
  return new Uint8Array([
    1, 0x64, 0, 0x1e, 0xfc | lengthSizeMinusOne,
    0xe1, 0, sps.length, ...sps,
    1, 0, pps.length, ...pps,
  ]);
}

/** Packets with `pts` in decode order (frame units), key frames where `keys` says. */
function packets(pts: number[], keys: number[]): SourcePacket[] {
  return pts.map((p) => ({
    type: keys.includes(p) ? 'key' : 'delta',
    timestamp: p * FRAME,
    duration: FRAME,
    data: new Uint8Array([0, 0, 0, 1, p]),
  }));
}

function run(clipRef: Clip, firstOutput: number, firstSource: number, count: number): PassthroughFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    frameIndex: firstOutput + i,
    clip: clipRef,
    sourceUs: (firstSource + i) * FRAME,
  }));
}

describe('passthrough frames', () => {
  const clips = [clip('a', 4)];
  const byId = new Map(clips.map((c) => [c.id, c]));

  it('accepts an untouched full-frame base layer', () => {
    const frame = passthroughFrame(planAt(clips, 1), 30, byId);
    expect(frame).toMatchObject({ frameIndex: 30, sourceUs: 1_000_000 });
  });

  it('refuses fades, transforms, titles and reversed clips', () => {
    const faded = [clip('a', 4, { videoFadeIn: 2 })];
    expect(passthroughFrame(planAt(faded, 1), 30, new Map([['a', faded[0]!]]))).toBeNull();
    const titled = [{ id: 't', text: 'Hi', x: 0, y: 0, fontsize: 20, fontcolor: '#fff', scrolling: false, scrollSpeed: 0 } as TextOverlay];
    expect(passthroughFrame(planAt(clips, 1, titled), 30, byId)).toBeNull();
    const reversed = [clip('a', 4, { reversed: true } as Partial<Clip>)];
    expect(passthroughFrame(planAt(reversed, 1), 30, new Map([['a', reversed[0]!]]))).toBeNull();
    const capped = buildPreviewCompositionPlan(clips, [], [], [], { outputResolution: '640x360' }, 1, 180, 320);
    expect(passthroughFrame(capped, 30, byId)).toBeNull();
  });

  it('ignores a title while it is invisible', () => {
    const hidden = [
      {
        id: 't',
        text: 'Hi',
        x: 0,
        y: 0,
        fontsize: 20,
        fontcolor: '#fff',
        scrolling: false,
        scrollSpeed: 0,
        keyframes: { opacity: [{ t: 0, value: 0 }] },
      } as TextOverlay,
    ];
    expect(passthroughFrame(planAt(clips, 1, hidden), 30, byId)).not.toBeNull();
  });

  it('groups runs by clip and by one-frame source steps', () => {
    const a = clip('a', 4);
    const b = clip('b', 4);
    const frames = [
      ...run(a, 0, 0, 3),
      null,
      ...run(a, 4, 4, 2),
      ...run(b, 6, 0, 2),
      { frameIndex: 8, clip: b, sourceUs: 5 * FRAME },
    ];
    expect(passthroughRuns(frames, FRAME).map((r) => r.map((f) => f.frameIndex))).toEqual([
      [0, 1, 2],
      [4, 5],
      [6, 7],
      [8],
    ]);
  });
});

describe('planCopy', () => {
  const a = clip('a', 10);

  it('copies a whole run that starts on a key frame', () => {
    const plan = planCopy(run(a, 100, 0, 6), packets([0, 1, 2, 3, 4, 5, 6], [0]), FRAME);
    expect(plan.copy).toMatchObject({ start: 100, end: 106 });
    expect(plan.copy!.packets.map((p) => p.timestamp / FRAME)).toEqual([100, 101, 102, 103, 104, 105]);
    expect(plan.reason).toBeUndefined();
  });

  it('starts at the next key frame when the cut lands inside a GOP', () => {
    const src = packets([0, 1, 2, 3, 4, 5, 6, 7], [0, 4]);
    const plan = planCopy(run(a, 0, 2, 6), src, FRAME);
    expect(plan.copy).toMatchObject({ start: 2, end: 6 });
    expect(plan.copy!.packets[0]!.type).toBe('key');
    expect(plan.reason).toMatch(/inside a source GOP/);
  });

  it('ends at the last closed decode-order prefix under B-frames', () => {
    // Decode order I0 P3 B1 B2 P6 B4 B5; the run shows frames 0..4.
    const src = packets([0, 3, 1, 2, 6, 4, 5], [0]);
    const plan = planCopy(run(a, 0, 0, 5), src, FRAME);
    expect(plan.copy).toMatchObject({ start: 0, end: 4 });
    expect(plan.copy!.packets.map((p) => p.timestamp / FRAME)).toEqual([0, 3, 1, 2]);
    expect(plan.reason).toMatch(/reordered GOP/);
  });

  it('stops at an open-GOP leading picture', () => {
    // Decode order I2 B0 B1 P3: the run starts at the key frame (source frame 2).
    const src = packets([2, 0, 1, 3], [2]);
    const plan = planCopy(run(a, 0, 2, 2), src, FRAME);
    expect(plan.copy).toMatchObject({ start: 0, end: 1 });
  });

  it('copies nothing when the source rate differs from the export rate', () => {
    const src = [0, 1, 2, 3, 4].map((i) => ({ type: i === 0 ? 'key' : 'delta', timestamp: i * 40_000, duration: 40_000, data: new Uint8Array(1) }) as SourcePacket);
    const plan = planCopy(run(a, 0, 0, 4), src, FRAME);
    expect(plan.copy).toBeNull();
    expect(plan.reason).toMatch(/25.00 fps/);
  });

  it('copies nothing without a key frame inside the run', () => {
    expect(planCopy(run(a, 0, 1, 3), packets([0, 1, 2, 3], [0]), FRAME).copy).toBeNull();
  });
});

describe('sources and parameter sets', () => {
  const config = (overrides: Partial<VideoDecoderConfig> = {}): VideoDecoderConfig => ({
    codec: 'avc1.64001e',
    codedWidth: 640,
    codedHeight: 360,
    description: avcC([0x67, 1, 2], [0x68, 3]),
    ...overrides,
  });

  it('accepts matching H.264 and names what does not match', () => {
    expect(sourceCopyBlocker({ config: config(), colorSpace: null }, 640, 360)).toBeNull();
    expect(sourceCopyBlocker({ config: config(), colorSpace: null }, 320, 180)).toMatch(/not the output/);
    expect(sourceCopyBlocker({ config: config({ codec: 'vp09.00.10.08' }), colorSpace: null }, 640, 360)).toMatch(/not H.264/);
    expect(
      sourceCopyBlocker({ config: config(), colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' } as unknown as VideoColorSpaceInit }, 640, 360),
    ).toMatch(/Rec.709/);
    expect(
      sourceCopyBlocker({ config: config({ description: avcC([0x67], [0x68], 1) }), colorSpace: null }, 640, 360),
    ).toMatch(/NAL length/);
  });

  it('parses avcC and prepends SPS / PPS to a key frame once', () => {
    const parsed = parseAvcDecoderConfig(avcC([0x67, 1, 2], [0x68, 3]))!;
    expect(parsed.lengthSize).toBe(4);
    expect([...parsed.sps[0]!]).toEqual([0x67, 1, 2]);
    const frame = new Uint8Array([0, 0, 0, 2, 0x65, 9]);
    const withSets = withInBandParameterSets(frame, parsed);
    expect([...withSets]).toEqual([0, 0, 0, 3, 0x67, 1, 2, 0, 0, 0, 2, 0x68, 3, 0, 0, 0, 2, 0x65, 9]);
    expect(withInBandParameterSets(withSets, parsed)).toBe(withSets);
    expect(parseAvcDecoderConfig(new Uint8Array([1, 2]))).toBeNull();
    expect(inBandAvcCodec('avc1.64001e')).toBe('avc3.64001e');
  });

  it('lists what keeps a whole export from copying', () => {
    expect(smartRenderBlockers({ smartRender: true, forceReencode: false, muxerCodec: 'avc' })).toEqual([]);
    expect(
      smartRenderBlockers({
        smartRender: true,
        forceReencode: true,
        muxerCodec: 'hevc',
        finishing: { grain: { enabled: true, amount: 0.5 } } as never,
      }),
    ).toEqual(['Force re-encode is on', 'the export codec is not H.264', 'finishing applies to every frame']);
  });
});
