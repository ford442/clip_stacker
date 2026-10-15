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
/** f64 fields per fx mix entry (`MIX_ENTRY_FX_STRIDE`): legacy twelve + first / count / state. */
export const MIX_ENTRY_FX_STRIDE = 15;
/** f64 fields per packed effect block (`MIX_FX_STRIDE`). */
export const MIX_FX_STRIDE = 10;
/** `MIX_FX_KIND` codes. */
const MIX_FX_KIND: Record<AudioEqBandType | 'compressor' | 'limiter', number> = {
  peaking: 1,
  lowShelf: 2,
  highShelf: 3,
  highPass: 4,
  compressor: 5,
  limiter: 6,
};

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
    rows.push(MIX_FX_KIND[band.type], 1, band.frequency, band.gainDb, band.q, 0, 0, 0, 0, 0);
  }
  const c = effects!.compressor;
  if (c?.enabled) {
    rows.push(MIX_FX_KIND.compressor, 1, 0, c.makeupDb, 0, c.thresholdDb, c.ratio, c.attack, c.release, c.kneeDb);
  }
  return rows;
}

/** The bus limiter as one `MIX_FX_STRIDE` row (empty when off). */
export function packLimiterRow(limiter: MasterLimiterSettings | null | undefined): number[] {
  if (!masterLimiterActive(limiter)) return [];
  const l = limiter!;
  return [MIX_FX_KIND.limiter, 1, 0, 0, 0, l.ceilingDb, 0, l.lookahead, l.release, 0];
}

/** A usable playback rate: finite and positive, else 1. */
export function sanitizedRate(rate: number | undefined): number {
  return Number.isFinite(rate) && (rate ?? 0) > 0 ? rate! : 1;
}
