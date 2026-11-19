import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { createBusEffect, type LaneDuckSettings } from './audioBus';
import { MIX_BUS, MIX_BUS_STRIDE, MIX_BUS_TAP, MIX_FX_STRIDE } from '../wasm/mediaEngineLayout';
import { busGraphNeededForExport, busGraphNeededForPreview, orderLanes, planBusGraph } from './fxGraph';

const duck = (sourceTrackId: string): LaneDuckSettings => ({
  sourceTrackId,
  depthDb: 9,
  thresholdDb: -40,
  attack: 0.05,
  hold: 0.2,
  release: 0.5,
});

function track(id: string, kind: Track['kind'] = 'audio', extra: Partial<Track> = {}): Track {
  return { id, kind, items: [], ...extra };
}

describe('fxGraph: lane order', () => {
  it('keeps timeline order, skips titles lanes, and moves a key before its ducked lane', () => {
    const { lanes, ducks } = orderLanes([
      track('music', 'audio', { duck: duck('dialogue') }),
      track('titles', 'text'),
      track('dialogue', 'video'),
      track('sfx'),
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['dialogue', 'music', 'sfx']);
    expect([...ducks.keys()]).toEqual(['music']);
  });

  it('drops ducks keyed on a missing lane, on itself or on a titles lane', () => {
    const { ducks } = orderLanes([
      track('a', 'audio', { duck: duck('gone') }),
      track('b', 'audio', { duck: duck('b') }),
      track('c', 'audio', { duck: duck('t') }),
      track('t', 'text'),
    ]);
    expect(ducks.size).toBe(0);
  });

  it('breaks a cycle at the earliest lane, keeping the other duck', () => {
    const { lanes, ducks } = orderLanes([
      track('a', 'audio', { duck: duck('b') }),
      track('b', 'audio', { duck: duck('a') }),
    ]);
    expect([...ducks.keys()]).toEqual(['b']);
    expect(lanes.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('resolves chains of ducks in dependency order', () => {
    const { lanes } = orderLanes([
      track('c', 'audio', { duck: duck('b') }),
      track('b', 'audio', { duck: duck('a') }),
      track('a', 'video'),
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('fxGraph: packed plan', () => {
  it('packs each lane chain, its duck (keyed by packed index), the master chain and the final stage', () => {
    const plan = planBusGraph(
      [
        track('music', 'audio', { audioFx: [createBusEffect('compressor')], duck: duck('dialogue') }),
        track('dialogue', 'video', { audioFx: [createBusEffect('eq')] }),
      ],
      { fx: [createBusEffect('limiter')] },
      { finalRows: new Array(MIX_FX_STRIDE).fill(0), outputGainDb: 4.5 },
    );
    expect(plan.laneTrackIds).toEqual(['dialogue', 'music']);
    // dialogue: the default EQ's two bands; music: compressor + ducker. No taps.
    expect(plan.buses).toEqual([0, 2, 0, 2, 2, 0]);
    expect(plan.tapTrackIds).toEqual([]);
    expect(plan.tapDirect).toBe(false);
    const duckRow = plan.effects.slice(3 * MIX_FX_STRIDE, 4 * MIX_FX_STRIDE);
    expect(duckRow[0]).toBe(10); // MIX_FX_DUCKER
    expect(duckRow[12]).toBe(0); // keyed on packed lane 0 (dialogue)
    expect([plan.masterFirst, plan.masterCount, plan.finalFirst, plan.finalCount]).toEqual([4, 1, 5, 1]);
    expect(plan.outputGainDb).toBe(4.5);
    expect(plan.processing).toBe(true);
  });

  it('taps lanes for stems in packed order, flags their rows and packs the same effect rows', () => {
    const lanes = [
      track('music', 'audio', { audioFx: [createBusEffect('compressor')], duck: duck('dialogue') }),
      track('titles', 'text'),
      track('dialogue', 'video', { audioFx: [createBusEffect('eq')] }),
      track('sfx'),
    ];
    const untapped = planBusGraph(lanes, { fx: [createBusEffect('limiter')] });
    // Titles lanes are not buses and unknown ids are not lanes: neither is tapped.
    const plan = planBusGraph(lanes, { fx: [createBusEffect('limiter')] }, {
      tapTrackIds: ['music', 'titles', 'gone', 'dialogue'],
      tapDirect: true,
    });
    expect(plan.laneTrackIds).toEqual(['dialogue', 'music', 'sfx']);
    expect(plan.tapTrackIds).toEqual(['dialogue', 'music']);
    expect(plan.tapDirect).toBe(true);
    expect(plan.buses).toEqual([0, 2, MIX_BUS_TAP, 2, 2, MIX_BUS_TAP, 4, 0, 0]);
    // Tapping changes only the flags field of the bus rows.
    expect(plan.effects).toEqual(untapped.effects);
    expect(plan.buses.filter((_, i) => i % MIX_BUS_STRIDE !== MIX_BUS.flags)).toEqual(
      untapped.buses.filter((_, i) => i % MIX_BUS_STRIDE !== MIX_BUS.flags),
    );
    expect(untapped.buses.filter((_, i) => i % MIX_BUS_STRIDE === MIX_BUS.flags)).toEqual([0, 0, 0]);
    expect([plan.masterFirst, plan.masterCount, plan.finalFirst, plan.finalCount, plan.processing]).toEqual([
      untapped.masterFirst,
      untapped.masterCount,
      untapped.finalFirst,
      untapped.finalCount,
      untapped.processing,
    ]);
  });

  it('a project with dry lanes plans a pure sum', () => {
    const plan = planBusGraph([track('v1', 'video'), track('a1')], undefined);
    expect(plan.effects).toEqual([]);
    expect(plan.processing).toBe(false);
    expect(busGraphNeededForPreview([track('v1', 'video'), track('a1', 'audio', { duck: 'off' })], undefined)).toBe(
      false,
    );
  });

  it('the loudness target is export-only', () => {
    const master = { loudness: { targetLufs: -14, truePeakDb: -1 } };
    expect(busGraphNeededForPreview([track('v1', 'video')], master)).toBe(false);
    expect(busGraphNeededForExport([track('v1', 'video')], master)).toBe(true);
    expect(busGraphNeededForPreview([track('v1', 'video'), track('a1', 'audio', { duck: duck('v1') })], undefined)).toBe(
      true,
    );
  });
});
