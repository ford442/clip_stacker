import { describe, expect, it } from 'vitest';
import {
  activeBusEffectCount,
  busEffectsActive,
  createBusEffect,
  laneDuckActive,
  masterBusActive,
  MAX_BUS_EFFECTS,
  MAX_BUS_EQ_BANDS,
  normalizeBusEffects,
  normalizeLaneDuck,
  normalizeLoudnessTarget,
  normalizeMasterBus,
  type BusEffect,
} from './audioBus';
import { serializeProject, applyProjectData } from './project';
import { createTestClip } from './project.test.helpers';
import type { Track } from '../types';

describe('audioBus: coercion', () => {
  it('keeps every effect kind, clamps fields and keeps bypassed effects', () => {
    const fx = normalizeBusEffects([
      { id: 'e', kind: 'eq', enabled: true, bands: [{ type: 'lowPass', frequency: 99_000, gainDb: 0, q: 0.7, enabled: true }] },
      { id: 'c', kind: 'compressor', enabled: false, thresholdDb: -200, ratio: 50, attack: 0.01, release: 0.1, kneeDb: 6, makeupDb: 0 },
      { id: 'g', kind: 'gate', enabled: true, thresholdDb: -50, rangeDb: 500, attack: 0.001, hold: 0.05, release: 0.1 },
      { id: 'd', kind: 'deesser', enabled: true, frequency: 100, thresholdDb: -30, ratio: 4, rangeDb: 6 },
      { id: 'l', kind: 'limiter', enabled: true, ceilingDb: 3, lookahead: 1, release: 0.1 },
    ])!;
    expect(fx.map((e) => e.kind)).toEqual(['eq', 'compressor', 'gate', 'deesser', 'limiter']);
    expect((fx[0] as Extract<BusEffect, { kind: 'eq' }>).bands[0]!.frequency).toBe(20_000);
    expect(fx[1]).toMatchObject({ enabled: false, thresholdDb: -60, ratio: 20 });
    expect(fx[2]).toMatchObject({ rangeDb: 100 });
    expect(fx[3]).toMatchObject({ frequency: 1000 });
    expect(fx[4]).toMatchObject({ ceilingDb: 0, lookahead: 0.02 });
  });

  it('drops malformed entries rather than throwing, and caps chain / band counts', () => {
    const bands = Array.from({ length: 12 }, () => ({ type: 'peaking', frequency: 1000, gainDb: 1, q: 1, enabled: true }));
    const fx = normalizeBusEffects([
      null,
      'eq',
      { kind: 'reverb' },
      { kind: 'eq', bands: [{ type: 'notch' }] }, // no valid band left: dropped
      { kind: 'eq', bands },
      ...Array.from({ length: 12 }, () => ({ kind: 'gate' })),
    ])!;
    expect(fx).toHaveLength(MAX_BUS_EFFECTS);
    expect((fx[0] as Extract<BusEffect, { kind: 'eq' }>).bands).toHaveLength(MAX_BUS_EQ_BANDS);
    expect(normalizeBusEffects('nope')).toBeUndefined();
    expect(normalizeBusEffects([])).toBeUndefined();
  });

  it('gives every effect a unique id', () => {
    const fx = normalizeBusEffects([
      { id: 'same', kind: 'gate' },
      { id: 'same', kind: 'gate' },
      { kind: 'gate' },
    ])!;
    expect(new Set(fx.map((e) => e.id)).size).toBe(3);
  });

  it('coerces ducks and loudness targets', () => {
    expect(normalizeLaneDuck('off')).toBe('off');
    expect(normalizeLaneDuck({ depthDb: 9 })).toBeUndefined(); // no key lane
    expect(normalizeLaneDuck({ sourceTrackId: 'v1', depthDb: 500, attack: -1 })).toMatchObject({
      sourceTrackId: 'v1',
      depthDb: 60,
      attack: 0,
    });
    expect(normalizeLoudnessTarget({ targetLufs: -100, truePeakDb: 4 })).toEqual({ targetLufs: -40, truePeakDb: 0 });
    expect(normalizeLoudnessTarget({ targetLufs: 'loud' })).toBeUndefined();
    expect(normalizeMasterBus({})).toBeUndefined();
    expect(normalizeMasterBus({ loudness: { targetLufs: -14 } })).toEqual({
      loudness: { targetLufs: -14, truePeakDb: -1 },
    });
  });

  it('counts only effects that would process audio', () => {
    const eq = createBusEffect('eq') as Extract<BusEffect, { kind: 'eq' }>;
    const silentEq: BusEffect = { ...eq, bands: eq.bands.map((b) => ({ ...b, enabled: false })) };
    const bypassed: BusEffect = { ...createBusEffect('limiter'), enabled: false };
    expect(busEffectsActive([silentEq, bypassed])).toBe(false);
    expect(activeBusEffectCount([silentEq, bypassed, createBusEffect('gate')])).toBe(1);
    expect(laneDuckActive({ sourceTrackId: 'a', depthDb: 0, thresholdDb: -40, attack: 0, hold: 0, release: 0 })).toBe(false);
    expect(masterBusActive({ loudness: { targetLufs: -14, truePeakDb: -1 } })).toBe(true);
    expect(masterBusActive({ fx: [bypassed] })).toBe(false);
  });
});

describe('audioBus: project round-trip', () => {
  const tracks = (): Track[] => [
    { id: 'v1', kind: 'video', items: [{ clipId: 'a', startTime: 0 }], audioFx: [createBusEffect('deesser')] },
    {
      id: 'a1',
      kind: 'audio',
      items: [],
      audioFx: [{ ...createBusEffect('compressor'), enabled: false }],
      duck: { sourceTrackId: 'v1', depthDb: 12, thresholdDb: -35, attack: 0.03, hold: 0.2, release: 0.6 },
    },
    { id: 'a2', kind: 'audio', items: [], duck: 'off' },
  ];

  it('saves and restores lane FX, ducks and the master bus', async () => {
    const clips = [createTestClip('a', 4, 'A')];
    const masterBus = { fx: [createBusEffect('limiter')], loudness: { targetLufs: -16, truePeakDb: -1.5 } };
    const project = serializeProject(clips, [], [], [], undefined, tracks(), undefined, null, [], {}, undefined, masterBus);
    const restored = await applyProjectData(JSON.parse(JSON.stringify(project)), clips);
    const byId = new Map(restored.tracks.map((t) => [t.id, t]));
    expect(byId.get('v1')!.audioFx).toEqual(tracks()[0]!.audioFx!.map((e) => ({ ...e, id: expect.any(String) })));
    expect(byId.get('a1')!.audioFx![0]!.enabled).toBe(false);
    expect(byId.get('a1')!.duck).toMatchObject({ sourceTrackId: 'v1', depthDb: 12 });
    expect(byId.get('a2')!.duck).toBe('off');
    expect(restored.masterBus).toEqual(masterBus);
  });

  it('omits every bus field for projects that never used them', async () => {
    const clips = [createTestClip('a', 4, 'A')];
    const plain: Track[] = [{ id: 'v1', kind: 'video', items: [{ clipId: 'a', startTime: 0 }] }];
    const project = serializeProject(clips, [], [], [], undefined, plain);
    expect(project).not.toHaveProperty('masterBus');
    expect(project.tracks![0]).not.toHaveProperty('audioFx');
    expect(project.tracks![0]).not.toHaveProperty('duck');
    const restored = await applyProjectData(project, clips);
    expect(restored.masterBus).toBeUndefined();
    expect(restored.tracks[0]).not.toHaveProperty('audioFx');
  });

  it('drops malformed bus settings on load instead of failing it', async () => {
    const clips = [createTestClip('a', 4, 'A')];
    const project = serializeProject(clips, [], [], [], undefined, tracks());
    const hand = JSON.parse(JSON.stringify(project));
    hand.tracks[0].audioFx = [{ kind: 'flanger' }, 42];
    hand.tracks[1].duck = { depthDb: 'deep' };
    hand.masterBus = { fx: 'none', loudness: null };
    const restored = await applyProjectData(hand, clips);
    expect(restored.tracks.find((t) => t.id === 'v1')).not.toHaveProperty('audioFx');
    expect(restored.tracks.find((t) => t.id === 'a1')).not.toHaveProperty('duck');
    expect(restored.masterBus).toBeUndefined();
  });
});
