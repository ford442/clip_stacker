/**
 * Lane buses, master bus and loudness normalization on the export premix.
 *
 * The premix (`webcodecs-audio.ts`) runs the media engine's bus graph when
 * the project has lane FX, sidechain ducks, master FX or a loudness target
 * (`busGraphNeededForExport`). A loudness target makes it two passes over
 * the same graph: pass 1 meters the master output (no encode), pass 2
 * applies `target - measured` as a static gain followed by a true-peak
 * limiter at the target's ceiling, and streams into the encoder.
 *
 * Without the media engine the premix falls back to OfflineAudioContext,
 * which mixes dry: the bus settings are skipped and the render plan says so
 * (`RenderPlan.audioFx: 'offline-fallback'`), never approximated with Web
 * Audio nodes.
 */

import type { RenderPlan, Track } from '../types';
import { editorStore } from '../store/editorStore';
import { audioTracks } from './trackModel';
import type { LoudnessTarget, MasterBusSettings } from './audioBus';
import type { MasterLimiterSettings } from './audioEffects';
import { busGraphNeededForExport, planBusGraph, type BusGraphPlan } from '../audio/fxGraph';
import { packLimiterRow, packTruePeakLimiterRow } from '../wasm/mediaEngineLayout';
import type { MixMeterReading, TimelineMixStream } from '../wasm/mediaEngine';

/** The lane and master settings an export mixes with. */
export interface ExportAudioBus {
  tracks: Track[];
  masterBus?: MasterBusSettings;
}

/** The editor's current lanes and master bus (read when the export starts). */
export function exportAudioBus(): ExportAudioBus {
  const { tracks, masterBus } = editorStore.getState();
  return { tracks, ...(masterBus ? { masterBus } : {}) };
}

/** True when the export must run the bus graph. */
export function exportBusActive(bus: ExportAudioBus | null | undefined): bus is ExportAudioBus {
  return Boolean(bus && busGraphNeededForExport(bus.tracks, bus.masterBus));
}

/**
 * Whether unmuted audio lanes hold clips. The FFmpeg filter graph mixes only
 * the video lanes' own audio, so these force the browser premix.
 */
export function exportHasAudioLaneClips(bus: ExportAudioBus | null | undefined): boolean {
  return Boolean(bus && audioTracks(bus.tracks).some((track) => !track.muted && track.items.length > 0));
}

/** What the last export's audio premix did, for the resolved render plan. */
export type ExportAudioReport = Pick<RenderPlan, 'audioFx' | 'loudness'>;

let lastReport: ExportAudioReport = {};

export function resetExportAudioReport(): void {
  lastReport = {};
}

export function noteExportAudio(report: ExportAudioReport): void {
  lastReport = { ...report };
}

export function getLastExportAudioReport(): ExportAudioReport {
  return { ...lastReport };
}

/** Stream options for one pass of the export mix. */
export interface ExportMixPass {
  bus: BusGraphPlan | null;
  meter: boolean;
  limiter: MasterLimiterSettings | null;
}

/**
 * The final pass: the bus graph with the loudness gain and true-peak limiter
 * (or the export settings' limiter when there is no target), or the plain
 * limiter-only mix when the project has no bus settings.
 */
export function finalExportPass(
  bus: ExportAudioBus | null | undefined,
  limiter: MasterLimiterSettings | null,
  gainDb = 0,
): ExportMixPass {
  if (!exportBusActive(bus)) return { bus: null, meter: false, limiter };
  const loudness = bus.masterBus?.loudness;
  const finalRows = loudness ? packTruePeakLimiterRow(loudness.truePeakDb) : packLimiterRow(limiter);
  return {
    bus: planBusGraph(bus.tracks, bus.masterBus, { finalRows, outputGainDb: gainDb }),
    meter: true,
    limiter: null,
  };
}

/** The metering pass a loudness target needs first (no gain, no final limiter). */
export function measuringExportPass(bus: ExportAudioBus): ExportMixPass {
  return { bus: planBusGraph(bus.tracks, bus.masterBus), meter: true, limiter: null };
}

/** Gain that moves `measured` onto the target (0 for silence: nothing to normalize). */
export function loudnessGainDb(target: LoudnessTarget, measured: number): number {
  return Number.isFinite(measured) ? target.targetLufs - measured : 0;
}

/**
 * Run a metering stream to the end (decode + mix, no encode) and return the
 * programme's integrated loudness. Closes the stream.
 */
export async function measureStream(stream: TimelineMixStream): Promise<number> {
  try {
    for await (const chunk of stream) void chunk;
    return stream.readMeters()?.integrated ?? -Infinity;
  } finally {
    stream.close();
  }
}

/** The render-plan report for an engine mix that just finished. */
export function engineReport(
  bus: ExportAudioBus | null | undefined,
  measured: number,
  gainDb: number,
  output: MixMeterReading | null,
): ExportAudioReport {
  if (!exportBusActive(bus)) return {};
  const target = bus.masterBus?.loudness;
  return {
    audioFx: 'engine',
    ...(target && output
      ? {
          loudness: {
            targetLufs: target.targetLufs,
            measuredLufs: measured,
            gainDb,
            outputLufs: output.integrated,
            outputTruePeakDb: output.truePeak,
          },
        }
      : {}),
  };
}
