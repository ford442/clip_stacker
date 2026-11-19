/**
 * The media engine's raw C surface and its fx-session constructors, split
 * from `mediaEngine.ts` (which owns loading and the chunked stream). Pure
 * bindings: every allocation goes through `withHeap`.
 */

import { withHeap } from './emscriptenLoader';
import type { BusGraphPlan } from '../audio/fxGraph';
import {
  MIX_BUS,
  MIX_BUS_FLAG_METER,
  MIX_BUS_FLAG_TAP_DIRECT,
  MIX_BUS_STRIDE,
  MIX_FX_STRIDE,
  MIX_METER,
} from './mediaEngineLayout';

/** The media-engine module's C exports (`EXPORTED_FUNCTIONS` in its CMakeLists). */
export interface MediaEngineWasmModule {
  _mix_timeline_audio_range(
    outPtr: number,
    outFrames: number,
    startFrame: number,
    outSampleRate: number,
    outChannels: number,
    pcmPtr: number,
    pcmFloats: number,
    slicesPtr: number,
    sliceCount: number,
    entriesPtr: number,
    entryCount: number,
    keyframesPtr: number,
    keyframeCount: number,
    flags: number,
  ): number;
  _mix_fx_session_create?(
    outSampleRate: number,
    outChannels: number,
    stateCount: number,
    effectsPtr: number,
    effectCount: number,
    busFirst: number,
    busCount: number,
  ): number;
  _mix_bus_session_create?(
    outSampleRate: number,
    outChannels: number,
    stateCount: number,
    effectsPtr: number,
    effectCount: number,
    busesPtr: number,
    busCount: number,
    masterFirst: number,
    masterCount: number,
    outputGainDb: number,
    finalFirst: number,
    finalCount: number,
    flags: number,
  ): number;
  _mix_fx_session_meters?(session: number, outPtr: number, capacity: number): number;
  _mix_bus_session_tap_count?(session: number): number;
  /** `_mix_fx_session_range` plus `tapsPtr`: `tapCount * outFrames * channels` floats, tap-major. */
  _mix_bus_session_range?(
    session: number,
    outPtr: number,
    tapsPtr: number,
    outFrames: number,
    startFrame: number,
    pcmPtr: number,
    pcmFloats: number,
    slicesPtr: number,
    sliceCount: number,
    entriesPtr: number,
    entryCount: number,
    keyframesPtr: number,
    keyframeCount: number,
    flags: number,
  ): number;
  _loudness_meter_create?(sampleRate: number, channels: number): number;
  _loudness_meter_process?(meter: number, interleavedPtr: number, frames: number): number;
  _loudness_meter_read?(meter: number, outPtr: number, capacity: number): number;
  _loudness_meter_destroy?(meter: number): void;
  _mix_fx_session_destroy?(session: number): void;
  _mix_fx_session_latency?(session: number): number;
  _mix_fx_session_range?(
    session: number,
    outPtr: number,
    outFrames: number,
    startFrame: number,
    pcmPtr: number,
    pcmFloats: number,
    slicesPtr: number,
    sliceCount: number,
    entriesPtr: number,
    entryCount: number,
    keyframesPtr: number,
    keyframeCount: number,
    flags: number,
  ): number;
  _insert_chain_create?(designSampleRate: number, effectsPtr: number, effectCount: number): number;
  _insert_chain_process?(chain: number, planarPtr: number, frames: number, channels: number): number;
  _insert_chain_destroy?(chain: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

/** The C++ fx session behind a stream with inserts, buses or a bus limiter. */
export interface FxSession {
  handle: number;
  /** Bus look-ahead (frames): entries are mixed this far ahead of the output. */
  latency: number;
  /** Lane buses in the session's graph (sizes the meter readout). */
  lanes: number;
  /** Output taps (`BusGraphPlan.tapTrackIds`, then direct); 0 = mix with `_mix_fx_session_range`. */
  taps: number;
}

/** A meter readout (`MIX_METER` layout): LUFS, LU, dBTP / dBFS, gain reduction dB. */
export interface MixMeterReading {
  momentary: number;
  shortTerm: number;
  integrated: number;
  range: number;
  truePeak: number;
  samplePeak: number;
  masterGainReduction: number;
  /** Per lane bus, in `BusGraphPlan.laneTrackIds` order. */
  laneGainReduction: number[];
}

/** Decode a `MIX_METER` readout. */
export function decodeMeterReading(values: ArrayLike<number>): MixMeterReading {
  const lanes: number[] = [];
  for (let i = MIX_METER.laneGainReduction; i < values.length; i++) lanes.push(values[i]!);
  return {
    momentary: values[MIX_METER.momentary] ?? -Infinity,
    shortTerm: values[MIX_METER.shortTerm] ?? -Infinity,
    integrated: values[MIX_METER.integrated] ?? -Infinity,
    range: values[MIX_METER.range] ?? 0,
    truePeak: values[MIX_METER.truePeak] ?? -Infinity,
    samplePeak: values[MIX_METER.samplePeak] ?? -Infinity,
    masterGainReduction: values[MIX_METER.masterGainReduction] ?? 0,
    laneGainReduction: lanes,
  };
}

/** Session handle (0 on failure). The session copies the effect rows. */
export function createFxSession(
  mod: MediaEngineWasmModule,
  sampleRate: number,
  channels: number,
  stateCount: number,
  fxValues: number[],
  busFirst: number,
): number {
  const effectCount = fxValues.length / MIX_FX_STRIDE;
  return (
    withHeap(mod, (heap) =>
      mod._mix_fx_session_create!(
        sampleRate,
        channels,
        stateCount,
        heap.f64(fxValues),
        effectCount,
        busFirst,
        effectCount - busFirst,
      ),
    ) ?? 0
  );
}

/**
 * Session with lane buses. `busFirst` is where the plan's rows start in
 * `fxValues` (after the clip insert rows), so the plan's ranges shift by it.
 */
export function createBusSession(
  mod: MediaEngineWasmModule,
  sampleRate: number,
  channels: number,
  stateCount: number,
  fxValues: number[],
  busFirst: number,
  bus: BusGraphPlan,
  meter: boolean,
): number {
  const effectCount = fxValues.length / MIX_FX_STRIDE;
  const lanes = bus.laneTrackIds.length;
  return (
    withHeap(mod, (heap) => {
      const effects = heap.f64(fxValues.length > 0 ? fxValues : [0]);
      const buses = heap.alloc(Math.max(1, lanes * MIX_BUS_STRIDE) * 4);
      const view = heap.i32View(buses, lanes * MIX_BUS_STRIDE);
      view.set(bus.buses.slice(0, lanes * MIX_BUS_STRIDE));
      // Each lane's first row shifts past the clip insert rows; count and flags copy as they are.
      for (let i = 0; i < lanes; i++) {
        const first = i * MIX_BUS_STRIDE + MIX_BUS.fxFirst;
        view[first] = (bus.buses[first] ?? 0) + busFirst;
      }
      return mod._mix_bus_session_create!(
        sampleRate,
        channels,
        stateCount,
        effects,
        effectCount,
        buses,
        lanes,
        bus.masterFirst + busFirst,
        bus.masterCount,
        bus.outputGainDb,
        bus.finalFirst + busFirst,
        bus.finalCount,
        (meter ? MIX_BUS_FLAG_METER : 0) | (bus.tapDirect ? MIX_BUS_FLAG_TAP_DIRECT : 0),
      );
    }) ?? 0
  );
}
