/**
 * Stems: one Broadcast WAV per audio-carrying lane plus the master, in a zip
 * with the timeline (OTIO) and `manifest.json`, for a DAW or audio post.
 *
 * The stems come out of the same mix the export premix runs (`openMixStream`,
 * the media engine's bus graph), in the same pass as the master: each lane's
 * tap is the lane after its chain, delay compensation and sidechain duck,
 * before the sum (`MIX_BUS_TAP`), so the stems sum to the master's input and
 * a duck still keys from the real key lane. There is no OfflineAudioContext
 * fallback: stems need the media engine and say so.
 *
 * Loudness: the project's loudness target (if any) applies to the master only.
 * Lane stems are written as mixed unless `normalize` is set, which measures
 * every stem first and gains each to −23 LUFS (EBU R 128) for broadcast
 * deliverables. Every file carries a BWF `bext` whose `TimeReference` is the
 * project timecode start, so Cubase, Pro Tools, Resolve and Reaper place it
 * at the right position, and an `iXML` with the lane name and frame rate.
 */

import type { Clip, ClipGroup, ClipTransition, ProjectTimecode, Track } from '../types';
import { buildAudioSchedule, type AudioScheduleEntry } from '../audio/schedule';
import { getTimelineClips } from '../timeline/timelineClips';
import { computeTotalDuration } from '../timeline/transitions';
import { ClipAudioCache } from '../audio/clipAudioCache';
import { planBusGraph } from '../audio/fxGraph';
import type { MasterBusSettings } from '../audio/audioBus';
import { openMixStream, type MixStream } from '../audio/audioRenderClient';
import type { TapMeterReading } from '../wasm/mediaEngine';
import { packTruePeakLimiterRow } from '../wasm/mediaEngineLayout';
import { timecodeRate, timecodeStartSeconds } from '../interchange/timecode';
import { createWavWriter, timeReferenceSamples, type WavSampleFormat, type WavWriter } from './container/wavWriter';
import { createZipBundle } from './container/zipBundle';
import { loudnessGainDb } from './exportAudioBus';
import {
  AAC_CHANNELS,
  AAC_SAMPLE_RATE,
  createBufferContext,
  createSchedulePcmProvider,
  prepareStreamingAudioMix,
  scheduleCanStream,
  toMixEntries,
} from './webcodecsAudio';

/** Broadcast loudness each stem is normalized to with `normalize` (EBU R 128). */
export const STEM_NORMALIZE_LUFS = -23;

export interface StemExportInput {
  /** The flattened timeline view (`selectTimelineClips`) and the pool's audio clips. */
  clips: Clip[];
  groups: ClipGroup[];
  transitions: ClipTransition[];
  tracks: Track[];
  masterBus?: MasterBusSettings | undefined;
  projectName: string;
  timecode: ProjectTimecode;
  /** Files bundled next to the stems (the OTIO timeline). */
  extraFiles?: Array<{ name: string; data: string | Uint8Array }>;
}

export interface StemExportOptions {
  /** Lanes to export (track ids); default every lane that carries sound. */
  trackIds?: readonly string[] | undefined;
  /** Write the master too (default true). */
  includeMaster?: boolean | undefined;
  format?: WavSampleFormat | undefined;
  /** Gain every stem to −23 LUFS (measures first: two passes). */
  normalize?: boolean | undefined;
  onProgress?: ((progress: StemProgress) => void) | undefined;
  /** Origination date / time stamped into `bext` (default: now). */
  now?: Date | undefined;
  /** Decoded-audio cache to read clips through (default: a fresh one). */
  cache?: Pick<ClipAudioCache, 'get' | 'delete'> | undefined;
}

export interface StemProgress {
  stage: 'measuring' | 'mixing' | 'bundling';
  /** 0–1 across the whole export. */
  fraction: number;
}

export interface StemFileReport {
  fileName: string;
  /** Lane name, `Master`, or `Direct` (audio routed to no lane). */
  name: string;
  /** The lane's track id; null for the master and the direct input. */
  trackId: string | null;
  role: 'lane' | 'master' | 'direct';
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  /** Static gain applied while writing (normalize), dB. */
  gainDb: number;
}

export interface StemsReport {
  files: StemFileReport[];
  sampleRate: number;
  format: WavSampleFormat;
  durationSec: number;
  timecodeStart: string;
  timecodeRate: string;
  /** BWF `TimeReference` every stem carries (samples since midnight). */
  timeReference: number;
  /** The loudness target applied to the master, LUFS (null when none). */
  masterTargetLufs: number | null;
  normalized: boolean;
}

export interface StemsResult {
  bundle: Blob | Uint8Array;
  report: StemsReport;
}

/** Why the stems cannot be exported (no media engine, nothing to mix), or null. */
export class StemExportError extends Error {
  override name = 'StemExportError';
}

/** File-name-safe stem name (`Dialog / VO` → `Dialog - VO`). */
function stemFileName(index: number, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' - ').replace(/\s+/g, ' ').trim() || 'Stem';
  return `${String(index).padStart(2, '0')} ${safe}.wav`;
}

const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);

/** Lanes that carry sound in the schedule (the default stem list), in lane order. */
export function stemLanes(tracks: Track[], schedule: AudioScheduleEntry[]): Track[] {
  const audible = new Set(schedule.map((entry) => entry.trackId).filter((id): id is string => Boolean(id)));
  return tracks.filter((track) => track.kind !== 'text' && audible.has(track.id));
}

function laneLabel(track: Track, tracks: Track[]): string {
  if (track.label?.trim()) return track.label.trim();
  const same = tracks.filter((t) => t.kind === track.kind);
  return `${track.kind === 'audio' ? 'Audio' : 'Video'} ${same.indexOf(track) + 1}`;
}

interface MixPass {
  stream: MixStream;
  tapIds: Array<string | null>;
}

async function openStemPass(
  schedule: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache,
  input: StemExportInput,
  tapTrackIds: string[],
  gainDb: number,
  measuring: boolean,
): Promise<MixPass> {
  const loudness = input.masterBus?.loudness;
  const plan = planBusGraph(input.tracks, input.masterBus, {
    ...(loudness && !measuring ? { finalRows: packTruePeakLimiterRow(loudness.truePeakDb), outputGainDb: gainDb } : {}),
    tapTrackIds,
    tapDirect: true,
  });
  const stream = await openMixStream(
    toMixEntries(schedule, schedule, plan),
    createSchedulePcmProvider(schedule, cache, createBufferContext(), false),
    { sampleRate: AAC_SAMPLE_RATE, channels: AAC_CHANNELS, durationSec, bus: plan, meter: true, meterTaps: true },
  );
  if (!stream) throw new StemExportError('Stems need the media engine, and it is off or failed to load (?no_media_engine, or the WASM could not be fetched).');
  return { stream, tapIds: [...plan.tapTrackIds, null] };
}

/** Run a pass to the end without writing anything; returns its master and tap meters. */
async function measurePass(pass: MixPass, onChunk: (fraction: number) => void): Promise<{ master: number; taps: TapMeterReading[] }> {
  try {
    for await (const chunk of pass.stream) onChunk((chunk.startFrame + chunk.frameCount) / Math.max(1, pass.stream.totalFrames));
    return { master: pass.stream.readMeters()?.integrated ?? -Infinity, taps: pass.stream.readTapMeters() ?? [] };
  } finally {
    pass.stream.close();
  }
}

function applyGain(source: Float32Array, gain: number, scratch: Float32Array): Float32Array {
  if (gain === 1) return source;
  const out = scratch.length >= source.length ? scratch.subarray(0, source.length) : new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source[i]! * gain;
  return out;
}

/** Render the stems and bundle them (BWF per lane + master, the timeline, `manifest.json`). */
export async function exportStems(input: StemExportInput, options: StemExportOptions = {}): Promise<StemsResult> {
  const format = options.format ?? 'pcm24';
  const includeMaster = options.includeMaster ?? true;
  const normalize = Boolean(options.normalize);
  const progress = options.onProgress ?? (() => {});
  const timelineClips = getTimelineClips(input.clips, input.groups);
  const durationSec = computeTotalDuration(timelineClips.filter((clip) => clip.kind !== 'audio'), input.transitions);
  const schedule = buildAudioSchedule(input.clips, input.groups, input.transitions, input.tracks);
  if (schedule.length === 0 || !(durationSec > 0)) throw new StemExportError('The timeline has no audio to export as stems.');
  if (!(await prepareStreamingAudioMix())) throw new StemExportError('Stems need the media engine, and it is off or failed to load.');
  if (!scheduleCanStream(schedule)) throw new StemExportError('A clip on this timeline needs the OfflineAudioContext mix, which cannot tap lanes: stems are unavailable.');

  const lanes = stemLanes(input.tracks, schedule).filter((track) => !options.trackIds || options.trackIds.includes(track.id));
  const tapTrackIds = lanes.map((track) => track.id);
  const cache = (options.cache ?? new ClipAudioCache()) as ClipAudioCache;
  const target = input.masterBus?.loudness;
  const passes = target || normalize ? 2 : 1;

  // Pass 1 (only with a loudness target or normalize): measure master and every tap.
  let masterGainDb = 0;
  let tapGainsDb = new Map<string | null, number>();
  if (passes === 2) {
    const pass = await openStemPass(schedule, durationSec, cache, input, tapTrackIds, 0, true);
    const measured = await measurePass(pass, (f) => progress({ stage: 'measuring', fraction: f * 0.5 }));
    if (target) masterGainDb = loudnessGainDb(target, measured.master);
    if (normalize) {
      tapGainsDb = new Map(
        measured.taps.map((tap) => [tap.trackId, Number.isFinite(tap.integrated) ? STEM_NORMALIZE_LUFS - tap.integrated : 0]),
      );
    }
  }

  const pass = await openStemPass(schedule, durationSec, cache, input, tapTrackIds, masterGainDb, false);
  const rate = timecodeRate(input.timecode.rate);
  const timeReference = timeReferenceSamples(timecodeStartSeconds(input.timecode.start, input.timecode.rate), AAC_SAMPLE_RATE);
  const now = options.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const originationDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const originationTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const writerFor = (name: string) =>
    createWavWriter({
      channels: AAC_CHANNELS,
      sampleRate: AAC_SAMPLE_RATE,
      format,
      trackName: name,
      timeReference,
      bext: {
        description: `${input.projectName} — ${name}`.slice(0, 256),
        originationDate,
        originationTime,
        // Measured while writing; filled in at finish.
        loudness: {},
      },
      ixml: {
        project: input.projectName,
        note: `Clip Stacker stem: ${name}`,
        frameRate: { numerator: rate.num, denominator: rate.den },
        dropFrame: rate.dropFrame,
      },
    });

  const tapNames = pass.tapIds.map((id) => (id === null ? 'Direct' : laneLabel(lanes.find((l) => l.id === id)!, input.tracks)));
  const tapWriters: WavWriter[] = tapNames.map(writerFor);
  const tapGains = pass.tapIds.map((id) => Math.pow(10, (tapGainsDb.get(id) ?? 0) / 20));
  const masterWriter = includeMaster ? writerFor('Master') : null;
  const scratch = new Float32Array(AAC_CHANNELS * 48_000);
  const passStart = passes === 2 ? 0.5 : 0;
  let masterMeters: ReturnType<MixStream['readMeters']>;
  let tapMeters: TapMeterReading[];
  try {
    for await (const chunk of pass.stream) {
      masterWriter?.write(chunk.frames);
      chunk.taps?.forEach((tap, t) => tapWriters[t]?.write(applyGain(tap, tapGains[t] ?? 1, scratch)));
      progress({ stage: 'mixing', fraction: passStart + ((chunk.startFrame + chunk.frameCount) / Math.max(1, pass.stream.totalFrames)) * (0.95 - passStart) });
    }
    // Meters are released with the stream: read them first.
    masterMeters = pass.stream.readMeters();
    tapMeters = pass.stream.readTapMeters() ?? [];
  } finally {
    pass.stream.close();
  }

  progress({ stage: 'bundling', fraction: 0.96 });
  const zip = createZipBundle({ mtime: now });
  const files: StemFileReport[] = [];
  let index = 0;
  if (masterWriter && masterMeters) {
    index += 1;
    const fileName = stemFileName(index, 'Master');
    const loudness = { integrated: masterMeters.integrated, range: masterMeters.range, maxTruePeak: masterMeters.truePeak };
    zip.add(fileName, masterWriter.finish({ loudness }).parts);
    files.push({
      fileName,
      name: 'Master',
      trackId: null,
      role: 'master',
      integratedLufs: finiteOrNull(masterMeters.integrated),
      loudnessRangeLu: finiteOrNull(masterMeters.range),
      truePeakDbtp: finiteOrNull(masterMeters.truePeak),
      samplePeakDbfs: finiteOrNull(masterMeters.samplePeak),
      gainDb: masterGainDb,
    });
  }
  pass.tapIds.forEach((trackId, t) => {
    const meter = tapMeters[t];
    const writer = tapWriters[t]!;
    // The direct input only matters when something was routed to no lane.
    if (trackId === null && !(meter && Number.isFinite(meter.samplePeak))) return;
    const gainDb = tapGainsDb.get(trackId) ?? 0;
    // The tap meter measured the stem before the normalize gain.
    const shift = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value + gainDb : (value ?? NaN));
    index += 1;
    const name = tapNames[t]!;
    const fileName = stemFileName(index, name);
    zip.add(fileName, writer.finish({ loudness: { integrated: shift(meter?.integrated), range: meter?.range ?? NaN, maxTruePeak: shift(meter?.truePeak) } }).parts);
    files.push({
      fileName,
      name,
      trackId,
      role: trackId === null ? 'direct' : 'lane',
      integratedLufs: finiteOrNull(shift(meter?.integrated)),
      loudnessRangeLu: finiteOrNull(meter?.range ?? NaN),
      truePeakDbtp: finiteOrNull(shift(meter?.truePeak)),
      samplePeakDbfs: finiteOrNull(shift(meter?.samplePeak)),
      gainDb,
    });
  });
  const report: StemsReport = {
    files,
    sampleRate: AAC_SAMPLE_RATE,
    format,
    durationSec,
    timecodeStart: input.timecode.start,
    timecodeRate: input.timecode.rate,
    timeReference,
    masterTargetLufs: target?.targetLufs ?? null,
    normalized: normalize,
  };
  for (const extra of input.extraFiles ?? []) zip.add(extra.name, extra.data);
  zip.add('manifest.json', `${JSON.stringify({ generator: 'Clip Stacker', project: input.projectName, ...report }, null, 2)}\n`);
  progress({ stage: 'bundling', fraction: 1 });
  return { bundle: zip.finish(), report };
}
