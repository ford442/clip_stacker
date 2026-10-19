/**
 * Lane buses -> the media engine's packed bus layout.
 *
 * Both consumers of the C++ bus graph start here: the export premix
 * (`openTimelineMixStream`'s `bus` option) and the preview AudioWorklet
 * (`src/wasm/audioFx.ts`). One plan, so the two run the same graph.
 *
 * Every lane that can carry audio (video and audio lanes; titles lanes
 * cannot) becomes a bus, even a dry one: its entries still sum there, and a
 * dry lane may be another lane's sidechain key. Lanes are packed in timeline
 * order except where a duck needs its key processed first — the engine runs
 * lanes in packed order, one frame at a time, so a key must come earlier.
 * A duck whose key lane is missing, is itself, or closes a cycle is dropped
 * (deterministically: the earliest lane in timeline order loses its duck).
 *
 * Lane mute needs nothing here: a muted lane has no schedule entries, so its
 * bus is silent and keys no duck.
 */

import type { Track } from '../types';
import {
  busEffectsActive,
  laneDuckActive,
  masterBusActive,
  type LaneDuckSettings,
  type MasterBusSettings,
} from '../utils/audioBus';
import {
  MIX_BUS_MAX_LANES,
  MIX_FX_STRIDE,
  packBusEffectRows,
  packDuckRow,
} from '../wasm/mediaEngineLayout';

export interface BusGraphPlan {
  /** Lane track ids in packed order: an entry's `MIX_ENTRY_FX_BUS` is its index here. */
  laneTrackIds: string[];
  laneIndex: ReadonlyMap<string, number>;
  /** `MIX_FX_STRIDE` rows: lane chains (and ducks), the master chain, the final stage. */
  effects: number[];
  /** `MIX_BUS_STRIDE` ints per lane. */
  buses: number[];
  masterFirst: number;
  masterCount: number;
  finalFirst: number;
  finalCount: number;
  outputGainDb: number;
  /** Ducks that resolved, as ducked lane -> key lane. */
  ducks: Array<{ trackId: string; keyTrackId: string }>;
  /** True when the graph processes anything beyond summing the lanes. */
  processing: boolean;
}

export interface BusGraphOptions {
  /** Export-only final stage after the output gain (limiter rows). */
  finalRows?: number[];
  /** Static gain after the master chain (loudness normalization), dB. */
  outputGainDb?: number;
}

/** Lanes that can carry audio, in timeline order, capped at the engine's lane limit. */
function audioLanes(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind !== 'text').slice(0, MIX_BUS_MAX_LANES);
}

/** The duck a lane asks for, if its key is another audio lane. */
function requestedDuck(lane: Track, ids: ReadonlySet<string>): LaneDuckSettings | null {
  const duck = lane.duck;
  if (!laneDuckActive(duck)) return null;
  if (duck.sourceTrackId === lane.id || !ids.has(duck.sourceTrackId)) return null;
  return duck;
}

/** Packed lane order plus the ducks that survived it. */
export function orderLanes(tracks: Track[]): { lanes: Track[]; ducks: Map<string, LaneDuckSettings> } {
  const pending = audioLanes(tracks);
  const ids = new Set(pending.map((t) => t.id));
  const ducks = new Map<string, LaneDuckSettings>();
  for (const lane of pending) {
    const duck = requestedDuck(lane, ids);
    if (duck) ducks.set(lane.id, duck);
  }
  const placed = new Set<string>();
  const lanes: Track[] = [];
  while (pending.length > 0) {
    const ready = pending.findIndex((lane) => {
      const duck = ducks.get(lane.id);
      return !duck || placed.has(duck.sourceTrackId);
    });
    if (ready < 0) {
      // Every remaining lane waits on another: a cycle. Break it at the
      // earliest lane, which keeps its place but loses its duck.
      ducks.delete(pending[0]!.id);
      continue;
    }
    const [lane] = pending.splice(ready, 1);
    placed.add(lane!.id);
    lanes.push(lane!);
  }
  return { lanes, ducks };
}

export function planBusGraph(
  tracks: Track[],
  masterBus: MasterBusSettings | undefined,
  options: BusGraphOptions = {},
): BusGraphPlan {
  const { lanes, ducks } = orderLanes(tracks);
  const laneIndex = new Map(lanes.map((lane, i) => [lane.id, i]));
  const effects: number[] = [];
  const buses: number[] = [];
  const resolved: BusGraphPlan['ducks'] = [];
  for (const lane of lanes) {
    const first = effects.length / MIX_FX_STRIDE;
    effects.push(...packBusEffectRows(lane.audioFx));
    const duck = ducks.get(lane.id);
    if (duck) {
      effects.push(...packDuckRow(duck, laneIndex.get(duck.sourceTrackId)!));
      resolved.push({ trackId: lane.id, keyTrackId: duck.sourceTrackId });
    }
    buses.push(first, effects.length / MIX_FX_STRIDE - first);
  }
  const masterFirst = effects.length / MIX_FX_STRIDE;
  effects.push(...packBusEffectRows(masterBus?.fx));
  const masterCount = effects.length / MIX_FX_STRIDE - masterFirst;
  const finalFirst = effects.length / MIX_FX_STRIDE;
  effects.push(...(options.finalRows ?? []));
  const finalCount = effects.length / MIX_FX_STRIDE - finalFirst;
  const outputGainDb = Number.isFinite(options.outputGainDb) ? options.outputGainDb! : 0;
  return {
    laneTrackIds: lanes.map((lane) => lane.id),
    laneIndex,
    effects,
    buses,
    masterFirst,
    masterCount,
    finalFirst,
    finalCount,
    outputGainDb,
    ducks: resolved,
    processing: effects.length > 0 || outputGainDb !== 0,
  };
}

/**
 * Whether the preview needs the bus graph: lane FX, sidechain ducks or
 * master FX. The loudness target is export-only and does not count.
 */
export function busGraphNeededForPreview(tracks: Track[], masterBus: MasterBusSettings | undefined): boolean {
  if (busEffectsActive(masterBus?.fx)) return true;
  return orderLanes(tracks).ducks.size > 0 || audioLanes(tracks).some((t) => busEffectsActive(t.audioFx));
}

/** Whether an export must run the bus graph (preview needs + the loudness target). */
export function busGraphNeededForExport(tracks: Track[], masterBus: MasterBusSettings | undefined): boolean {
  return masterBusActive(masterBus) || busGraphNeededForPreview(tracks, masterBus);
}
