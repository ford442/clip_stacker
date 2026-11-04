/**
 * Lane buses and the master bus: per-lane insert chains, sidechain ducking,
 * master FX and the export loudness target.
 *
 * Settings only. The DSP is the media engine's C++ bus graph
 * (`native/media_engine/src/fx/bus.cpp`), run by the export premix
 * (`src/wasm/mediaEngine.ts`) and, live, by the preview's AudioWorklet
 * (`src/wasm/audioFx.ts`) — one implementation, so preview and export hear
 * the same samples. There is deliberately no Web Audio fallback
 * (`DynamicsCompressorNode`'s curve is implementation-defined): without the
 * engine, bus FX are bypassed and the UI says so.
 *
 * Coercion follows the captions policy: malformed effects are dropped and
 * fields clamped, never thrown on, so a hand-edited project still loads.
 */

import {
  COMPRESSOR_LIMITS,
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ_BAND,
  EQ_LIMITS,
  LIMITER_LIMITS,
  type AudioEqBand,
  type AudioEqBandType,
} from './audioEffects';

/** Effect id. Local rather than `createClipId` so `types/track.ts` can import this module without a cycle. */
function createEffectId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export type BusEffectKind = 'eq' | 'compressor' | 'gate' | 'deesser' | 'limiter';

interface BusEffectBase {
  /** Stable id: React keys, reorder, and the chain editor's selection. */
  id: string;
  /** False = bypassed (kept so the settings survive a toggle). */
  enabled: boolean;
}

/** A multi-band EQ block; each enabled band is one biquad, in order. */
export interface BusEqEffect extends BusEffectBase {
  kind: 'eq';
  bands: AudioEqBand[];
}

export interface BusCompressorEffect extends BusEffectBase {
  kind: 'compressor';
  thresholdDb: number;
  ratio: number;
  /** Seconds. */
  attack: number;
  /** Seconds. */
  release: number;
  kneeDb: number;
  makeupDb: number;
}

/** Gate / downward expander: below the threshold the lane drops by `rangeDb`. */
export interface BusGateEffect extends BusEffectBase {
  kind: 'gate';
  thresholdDb: number;
  /** Attenuation while closed (dB, >= 0). */
  rangeDb: number;
  /** Opening time (s). */
  attack: number;
  /** Stays open this long after the signal falls under the threshold (s). */
  hold: number;
  /** Closing time (s). */
  release: number;
}

/** Dynamic high-shelf de-esser keyed by the band above `frequency`. */
export interface BusDeEsserEffect extends BusEffectBase {
  kind: 'deesser';
  frequency: number;
  thresholdDb: number;
  ratio: number;
  /** Most cut (dB). */
  rangeDb: number;
}

/** True-peak look-ahead limiter. */
export interface BusLimiterEffect extends BusEffectBase {
  kind: 'limiter';
  /** Ceiling (dBTP). */
  ceilingDb: number;
  /** Look-ahead (s); adds this much delay, compensated across lanes. */
  lookahead: number;
  release: number;
}

export type BusEffect =
  | BusEqEffect
  | BusCompressorEffect
  | BusGateEffect
  | BusDeEsserEffect
  | BusLimiterEffect;

/**
 * Sidechain duck: this lane drops by `depthDb` while `sourceTrackId`'s lane
 * is over `thresholdDb`, ramping in over `attack` and back over `release`
 * after `hold`. Times in seconds, like the clip effects.
 */
export interface LaneDuckSettings {
  sourceTrackId: string;
  depthDb: number;
  thresholdDb: number;
  attack: number;
  hold: number;
  release: number;
}

/**
 * A lane's ducking: absent = the legacy step (audio lanes only, a fixed
 * `BED_DUCK_LINEAR` while dialogue overlaps — how projects sounded before
 * buses), `'off'` = none, or a sidechain duck.
 */
export type LaneDuck = LaneDuckSettings | 'off';

/** Export loudness normalization (two-pass: measure, then gain + true-peak limit). */
export interface LoudnessTarget {
  /** Integrated programme loudness to land on (LUFS). */
  targetLufs: number;
  /** True-peak ceiling of the final limiter (dBTP). */
  truePeakDb: number;
}

export interface MasterBusSettings {
  /** Master insert chain, after the lanes are summed. */
  fx?: BusEffect[];
  /** Export-only: normalize the delivered file to this loudness. */
  loudness?: LoudnessTarget;
}

/** Effects per chain (each EQ band is one more engine stage). */
export const MAX_BUS_EFFECTS = 8;
/** Bands per EQ block: HPF, low shelf, peaking x 4, high shelf / LPF. */
export const MAX_BUS_EQ_BANDS = 8;

export const GATE_LIMITS = {
  thresholdDb: { min: -100, max: 0 },
  rangeDb: { min: 0, max: 100 },
  attack: { min: 0, max: 1 },
  hold: { min: 0, max: 5 },
  release: { min: 0, max: 5 },
} as const;

export const DEESSER_LIMITS = {
  frequency: { min: 1000, max: 16000 },
  thresholdDb: { min: -60, max: 0 },
  ratio: { min: 1, max: 20 },
  rangeDb: { min: 0, max: 24 },
} as const;

export const DUCK_LIMITS = {
  depthDb: { min: 0, max: 60 },
  thresholdDb: { min: -80, max: 0 },
  attack: { min: 0, max: 5 },
  hold: { min: 0, max: 5 },
  release: { min: 0, max: 10 },
} as const;

export const LOUDNESS_LIMITS = {
  targetLufs: { min: -40, max: -5 },
  truePeakDb: { min: -9, max: 0 },
} as const;

export const BUS_EFFECT_LABELS: Record<BusEffectKind, string> = {
  eq: 'EQ',
  compressor: 'Compressor',
  gate: 'Gate',
  deesser: 'De-esser',
  limiter: 'Limiter',
};

/** Delivery presets for the export loudness target. */
export const LOUDNESS_PRESETS: ReadonlyArray<{ id: string; label: string; targetLufs: number; detail: string }> = [
  { id: 'streaming', label: 'Streaming', targetLufs: -14, detail: 'YouTube, TikTok, Instagram, Spotify' },
  { id: 'podcast', label: 'Podcast', targetLufs: -16, detail: 'Apple Podcasts and most podcast hosts' },
  { id: 'broadcast', label: 'Broadcast', targetLufs: -23, detail: 'EBU R 128 (European TV and radio)' },
];

export const DEFAULT_TRUE_PEAK_DB = -1;

export const DEFAULT_LANE_DUCK: Omit<LaneDuckSettings, 'sourceTrackId'> = {
  depthDb: 9,
  thresholdDb: -40,
  attack: 0.05,
  hold: 0.2,
  release: 0.5,
};

/** A new effect of `kind` with usable defaults. */
export function createBusEffect(kind: BusEffectKind): BusEffect {
  const id = createEffectId();
  switch (kind) {
    case 'eq':
      return {
        id,
        kind,
        enabled: true,
        bands: [
          { type: 'highPass', frequency: 80, gainDb: 0, q: 0.7071, enabled: true },
          { ...DEFAULT_EQ_BAND },
        ],
      };
    case 'compressor': {
      const { enabled: _enabled, ...settings } = DEFAULT_COMPRESSOR;
      return { id, kind, enabled: true, ...settings };
    }
    case 'gate':
      return { id, kind, enabled: true, thresholdDb: -50, rangeDb: 40, attack: 0.001, hold: 0.05, release: 0.1 };
    case 'deesser':
      return { id, kind, enabled: true, frequency: 6000, thresholdDb: -30, ratio: 4, rangeDb: 6 };
    case 'limiter':
      return { id, kind, enabled: true, ceilingDb: -1, lookahead: 0.005, release: 0.1 };
  }
}

function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

const EQ_BAND_TYPE_SET = new Set<AudioEqBandType>(['peaking', 'lowShelf', 'highShelf', 'highPass', 'lowPass']);

function normalizeBand(raw: unknown): AudioEqBand | null {
  if (!raw || typeof raw !== 'object') return null;
  const band = raw as Partial<AudioEqBand>;
  if (!band.type || !EQ_BAND_TYPE_SET.has(band.type)) return null;
  return {
    type: band.type,
    frequency: clampNumber(band.frequency, EQ_LIMITS.frequency, DEFAULT_EQ_BAND.frequency),
    gainDb: clampNumber(band.gainDb, EQ_LIMITS.gainDb, 0),
    q: clampNumber(band.q, EQ_LIMITS.q, DEFAULT_EQ_BAND.q),
    enabled: band.enabled !== false,
  };
}

function normalizeEffect(raw: unknown): BusEffect | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === 'string' && e.id ? e.id : createEffectId();
  const enabled = e.enabled !== false;
  switch (e.kind) {
    case 'eq': {
      const bands = Array.isArray(e.bands)
        ? e.bands
            .map(normalizeBand)
            .filter((band): band is AudioEqBand => band !== null)
            .slice(0, MAX_BUS_EQ_BANDS)
        : [];
      return bands.length > 0 ? { id, kind: 'eq', enabled, bands } : null;
    }
    case 'compressor':
      return {
        id,
        kind: 'compressor',
        enabled,
        thresholdDb: clampNumber(e.thresholdDb, COMPRESSOR_LIMITS.thresholdDb, DEFAULT_COMPRESSOR.thresholdDb),
        ratio: clampNumber(e.ratio, COMPRESSOR_LIMITS.ratio, DEFAULT_COMPRESSOR.ratio),
        attack: clampNumber(e.attack, COMPRESSOR_LIMITS.attack, DEFAULT_COMPRESSOR.attack),
        release: clampNumber(e.release, COMPRESSOR_LIMITS.release, DEFAULT_COMPRESSOR.release),
        kneeDb: clampNumber(e.kneeDb, COMPRESSOR_LIMITS.kneeDb, DEFAULT_COMPRESSOR.kneeDb),
        makeupDb: clampNumber(e.makeupDb, COMPRESSOR_LIMITS.makeupDb, DEFAULT_COMPRESSOR.makeupDb),
      };
    case 'gate':
      return {
        id,
        kind: 'gate',
        enabled,
        thresholdDb: clampNumber(e.thresholdDb, GATE_LIMITS.thresholdDb, -50),
        rangeDb: clampNumber(e.rangeDb, GATE_LIMITS.rangeDb, 40),
        attack: clampNumber(e.attack, GATE_LIMITS.attack, 0.001),
        hold: clampNumber(e.hold, GATE_LIMITS.hold, 0.05),
        release: clampNumber(e.release, GATE_LIMITS.release, 0.1),
      };
    case 'deesser':
      return {
        id,
        kind: 'deesser',
        enabled,
        frequency: clampNumber(e.frequency, DEESSER_LIMITS.frequency, 6000),
        thresholdDb: clampNumber(e.thresholdDb, DEESSER_LIMITS.thresholdDb, -30),
        ratio: clampNumber(e.ratio, DEESSER_LIMITS.ratio, 4),
        rangeDb: clampNumber(e.rangeDb, DEESSER_LIMITS.rangeDb, 6),
      };
    case 'limiter':
      return {
        id,
        kind: 'limiter',
        enabled,
        ceilingDb: clampNumber(e.ceilingDb, LIMITER_LIMITS.ceilingDb, -1),
        lookahead: clampNumber(e.lookahead, LIMITER_LIMITS.lookahead, 0.005),
        release: clampNumber(e.release, LIMITER_LIMITS.release, 0.1),
      };
    default:
      return null;
  }
}

/**
 * Coerce a saved / edited chain: unknown kinds and empty EQs dropped, fields
 * clamped, ids made unique, capped at `MAX_BUS_EFFECTS`. Undefined when
 * nothing is left; bypassed effects are kept.
 */
export function normalizeBusEffects(raw: unknown): BusEffect[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: BusEffect[] = [];
  for (const item of raw) {
    const effect = normalizeEffect(item);
    if (!effect) continue;
    if (seen.has(effect.id)) effect.id = createEffectId();
    seen.add(effect.id);
    out.push(effect);
    if (out.length >= MAX_BUS_EFFECTS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Coerce a saved duck: `'off'`, a sidechain duck, or undefined (legacy). */
export function normalizeLaneDuck(raw: unknown): LaneDuck | undefined {
  if (raw === 'off') return 'off';
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Partial<LaneDuckSettings>;
  if (typeof d.sourceTrackId !== 'string' || !d.sourceTrackId) return undefined;
  return {
    sourceTrackId: d.sourceTrackId,
    depthDb: clampNumber(d.depthDb, DUCK_LIMITS.depthDb, DEFAULT_LANE_DUCK.depthDb),
    thresholdDb: clampNumber(d.thresholdDb, DUCK_LIMITS.thresholdDb, DEFAULT_LANE_DUCK.thresholdDb),
    attack: clampNumber(d.attack, DUCK_LIMITS.attack, DEFAULT_LANE_DUCK.attack),
    hold: clampNumber(d.hold, DUCK_LIMITS.hold, DEFAULT_LANE_DUCK.hold),
    release: clampNumber(d.release, DUCK_LIMITS.release, DEFAULT_LANE_DUCK.release),
  };
}

export function normalizeLoudnessTarget(raw: unknown): LoudnessTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const l = raw as Partial<LoudnessTarget>;
  const target = Number(l.targetLufs);
  if (!Number.isFinite(target)) return undefined;
  return {
    targetLufs: clampNumber(target, LOUDNESS_LIMITS.targetLufs, -14),
    truePeakDb: clampNumber(l.truePeakDb, LOUDNESS_LIMITS.truePeakDb, DEFAULT_TRUE_PEAK_DB),
  };
}

/** Coerce the master bus; undefined when it has neither effects nor a target. */
export function normalizeMasterBus(raw: unknown): MasterBusSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as { fx?: unknown; loudness?: unknown };
  const fx = normalizeBusEffects(m.fx);
  const loudness = normalizeLoudnessTarget(m.loudness);
  if (!fx && !loudness) return undefined;
  return { ...(fx ? { fx } : {}), ...(loudness ? { loudness } : {}) };
}

/** True when the effect would process audio (enabled; an EQ with an enabled band). */
export function busEffectActive(effect: BusEffect): boolean {
  if (!effect.enabled) return false;
  return effect.kind !== 'eq' || effect.bands.some((band) => band.enabled);
}

export function busEffectsActive(fx: BusEffect[] | undefined): boolean {
  return (fx ?? []).some(busEffectActive);
}

/** A sidechain duck that would move the gain. */
export function laneDuckActive(duck: LaneDuck | undefined): duck is LaneDuckSettings {
  return typeof duck === 'object' && duck !== null && duck.depthDb > 0;
}

export function masterBusActive(master: MasterBusSettings | undefined): boolean {
  return busEffectsActive(master?.fx) || Boolean(master?.loudness);
}

/** Active effects on a lane chain (the lane header's FX badge). */
export function activeBusEffectCount(fx: BusEffect[] | undefined): number {
  return (fx ?? []).filter(busEffectActive).length;
}

/** Short label for a loudness target (`-14 LUFS · -1 dBTP`). */
export function describeLoudnessTarget(target: LoudnessTarget): string {
  return `${target.targetLufs} LUFS · ${target.truePeakDb} dBTP`;
}
