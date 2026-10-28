/**
 * The packed row layouts `src/wasm/mediaEngine.ts` uploads to the media
 * engine, mirrored from `native/media_engine/include/audio_mix.h` (strides,
 * flags, `MIX_FX_KIND`, `MIX_EASING_*`). Pure: no module, no heap. Change a
 * stride here and in the header together.
 */

import { sortKeyframes, type Keyframe } from '../utils/keyframes';
import {
  clipAudioEffectsActive,
  masterLimiterActive,
  MAX_EQ_BANDS,
  type AudioEqBandType,
  type ClipAudioEffects,
  type MasterLimiterSettings,
} from '../utils/audioEffects';
import { busEffectActive, type BusEffect, type LaneDuckSettings } from '../utils/audioBus';

export const MEDIA_ENGINE_CHANNELS = 2;
/** f64 fields per packed mix entry (`MIX_ENTRY_STRIDE` in audio_mix.h). */
export const MIX_ENTRY_STRIDE = 12;
/** i32 fields per source slice (`MIX_SLICE_STRIDE`). */
export const MIX_SLICE_STRIDE = 6;
/** f64 fields per packed keyframe (`MIX_KEY_STRIDE`). */
export const MIX_KEY_STRIDE = 7;
/** Source frames uploaded beyond what a chunk reads (`MIX_SOURCE_MARGIN_FRAMES`). */
export const MIX_SOURCE_MARGIN_FRAMES = 64;
/** `MIX_FLAG_LINEAR_RESAMPLE`: phase-1 linear interpolation (debug / fallback). */
export const MIX_FLAG_LINEAR_RESAMPLE = 1;
/** `MIX_FLAG_EFFECTS`: entries are `MIX_ENTRY_FX_STRIDE` wide (fx session only). */
export const MIX_FLAG_EFFECTS = 2;
/** f64 fields per fx mix entry (`MIX_ENTRY_FX_STRIDE`): legacy twelve + first / count / state / bus. */
export const MIX_ENTRY_FX_STRIDE = 16;
/** f64 fields per packed effect block (`MIX_FX_STRIDE`). */
export const MIX_FX_STRIDE = 13;
/** i32 fields per lane bus (`MIX_BUS_STRIDE`): first effect row, row count. */
export const MIX_BUS_STRIDE = 2;
/** `MIX_BUS_FLAG_METER`: run the BS.1770 meter (and gain-reduction readouts). */
export const MIX_BUS_FLAG_METER = 1;
/** Lane buses per graph (`MIX_BUS_MAX_LANES`); lanes past it mix direct. */
export const MIX_BUS_MAX_LANES = 32;
/** `MIX_METER_*`: the meter readout layout (then one gain reduction per lane). */
export const MIX_METER = {
  momentary: 0,
  shortTerm: 1,
  integrated: 2,
  range: 3,
  truePeak: 4,
  samplePeak: 5,
  masterGainReduction: 6,
  laneGainReduction: 7,
} as const;
/** `MIX_FX_*` field offsets within a row. */
const F = {
  kind: 0,
  enabled: 1,
  freq: 2,
  gainDb: 3,
  q: 4,
  thresholdDb: 5,
  ratio: 6,
  attack: 7,
  release: 8,
  kneeDb: 9,
  hold: 10,
  rangeDb: 11,
  key: 12,
} as const;
/** `MIX_FX_KIND` codes. */
const MIX_FX_KIND: Record<AudioEqBandType | 'compressor' | 'limiter' | 'gate' | 'deesser' | 'ducker', number> = {
  peaking: 1,
  lowShelf: 2,
  highShelf: 3,
  highPass: 4,
  compressor: 5,
  limiter: 6,
  lowPass: 7,
  gate: 8,
  deesser: 9,
  ducker: 10,
};

/** One zeroed, enabled row of `kind`; `fields` fills the rest by name. */
function fxRow(kind: keyof typeof MIX_FX_KIND, fields: Partial<Record<keyof typeof F, number>>): number[] {
  const row = new Array<number>(MIX_FX_STRIDE).fill(0);
  row[F.kind] = MIX_FX_KIND[kind];
  row[F.enabled] = 1;
  for (const [name, value] of Object.entries(fields)) row[F[name as keyof typeof F]] = value as number;
  return row;
}

/** `MIX_EASING_*` code; anything unrecognised is a bezier, like `applyEasing`. */
function easingCode(easing: Keyframe['easing']): number {
  switch (easing?.type ?? 'linear') {
    case 'linear':
      return 0;
    case 'bellCurveSmooth':
      return 2;
    case 'bellCurveSharp':
      return 3;
    default:
      return 1;
  }
}

/** Append `keys` (sorted like `sampleKeyframes`) as packed rows; returns the row count. */
export function packKeyframes(out: number[], keys: Keyframe[] | undefined): number {
  if (!keys?.length) return 0;
  for (const key of sortKeyframes(keys)) {
    const easing = key.easing;
    out.push(
      key.t,
      key.value,
      easingCode(easing),
      easing?.x1 ?? 0,
      easing?.y1 ?? 0,
      easing?.x2 ?? 1,
      easing?.y2 ?? 1,
    );
  }
  return keys.length;
}

/**
 * Pack a clip's insert chain as `MIX_FX_STRIDE` rows: enabled EQ bands (at
 * most `MAX_EQ_BANDS`) then the compressor. Bypassed blocks are left out, so
 * an all-bypassed chain packs to nothing and mixes bit-exact.
 */
export function packAudioEffectRows(effects: ClipAudioEffects | undefined): number[] {
  const rows: number[] = [];
  if (!clipAudioEffectsActive(effects)) return rows;
  for (const band of (effects!.eq ?? []).filter((b) => b.enabled).slice(0, MAX_EQ_BANDS)) {
    rows.push(...fxRow(band.type, { freq: band.frequency, gainDb: band.gainDb, q: band.q }));
  }
  const c = effects!.compressor;
  if (c?.enabled) {
    rows.push(
      ...fxRow('compressor', {
        gainDb: c.makeupDb,
        thresholdDb: c.thresholdDb,
        ratio: c.ratio,
        attack: c.attack,
        release: c.release,
        kneeDb: c.kneeDb,
      }),
    );
  }
  return rows;
}

/** The bus limiter as one `MIX_FX_STRIDE` row (empty when off). */
export function packLimiterRow(limiter: MasterLimiterSettings | null | undefined): number[] {
  if (!masterLimiterActive(limiter)) return [];
  const l = limiter!;
  return fxRow('limiter', { thresholdDb: l.ceilingDb, attack: l.lookahead, release: l.release });
}

/** A true-peak limiter row at `ceilingDb` (the loudness target's final stage). */
export function packTruePeakLimiterRow(ceilingDb: number): number[] {
  return fxRow('limiter', { thresholdDb: ceilingDb, attack: 0.005, release: 0.1 });
}

/**
 * A bus chain as `MIX_FX_STRIDE` rows, in order: one row per enabled EQ band,
 * then one per dynamics effect. Bypassed effects (and bands) are left out.
 */
export function packBusEffectRows(fx: BusEffect[] | undefined): number[] {
  const rows: number[] = [];
  for (const effect of fx ?? []) {
    if (!busEffectActive(effect)) continue;
    switch (effect.kind) {
      case 'eq':
        for (const band of effect.bands) {
          if (band.enabled) rows.push(...fxRow(band.type, { freq: band.frequency, gainDb: band.gainDb, q: band.q }));
        }
        break;
      case 'compressor':
        rows.push(
          ...fxRow('compressor', {
            gainDb: effect.makeupDb,
            thresholdDb: effect.thresholdDb,
            ratio: effect.ratio,
            attack: effect.attack,
            release: effect.release,
            kneeDb: effect.kneeDb,
          }),
        );
        break;
      case 'gate':
        rows.push(
          ...fxRow('gate', {
            thresholdDb: effect.thresholdDb,
            rangeDb: effect.rangeDb,
            attack: effect.attack,
            hold: effect.hold,
            release: effect.release,
          }),
        );
        break;
      case 'deesser':
        rows.push(
          ...fxRow('deesser', {
            freq: effect.frequency,
            thresholdDb: effect.thresholdDb,
            ratio: effect.ratio,
            rangeDb: effect.rangeDb,
          }),
        );
        break;
      case 'limiter':
        rows.push(
          ...fxRow('limiter', { thresholdDb: effect.ceilingDb, attack: effect.lookahead, release: effect.release }),
        );
        break;
    }
  }
  return rows;
}

/** A sidechain duck keyed by lane bus `keyIndex` (must be packed before the ducked lane). */
export function packDuckRow(duck: LaneDuckSettings, keyIndex: number): number[] {
  return fxRow('ducker', {
    key: keyIndex,
    rangeDb: duck.depthDb,
    thresholdDb: duck.thresholdDb,
    attack: duck.attack,
    hold: duck.hold,
    release: duck.release,
  });
}

/** A usable playback rate: finite and positive, else 1. */
export function sanitizedRate(rate: number | undefined): number {
  return Number.isFinite(rate) && (rate ?? 0) > 0 ? rate! : 1;
}
