/**
 * Clip insert effects (parametric EQ + compressor) and the master limiter.
 *
 * Settings only: the DSP is C++ in `native/media_engine` and runs through
 * `src/wasm/mediaEngine.ts` on both the export premix and the preview's
 * processed buffers (`src/audio/processedAudioCache.ts`), so the two paths
 * hear the same samples. There is deliberately no Web Audio equivalent —
 * with the media engine off (`?no_media_engine`) inserts are bypassed
 * everywhere rather than approximated with `BiquadFilterNode`s.
 *
 * Curves are constant per clip (not automated).
 */

export type AudioEqBandType = 'peaking' | 'lowShelf' | 'highShelf' | 'highPass';

export interface AudioEqBand {
  type: AudioEqBandType;
  /** Centre / corner frequency (Hz). */
  frequency: number;
  /** Boost or cut (dB). Ignored by `highPass`. */
  gainDb: number;
  q: number;
  /** False = bypassed (kept so the settings survive a toggle). */
  enabled: boolean;
}

export interface AudioCompressorSettings {
  enabled: boolean;
  thresholdDb: number;
  /** n:1 above the threshold. */
  ratio: number;
  /** Seconds. */
  attack: number;
  /** Seconds. */
  release: number;
  /** Soft-knee width (dB); 0 = hard knee. */
  kneeDb: number;
  /** Make-up gain after compression (dB). */
  makeupDb: number;
}

export interface ClipAudioEffects {
  /** Evaluated in order, before the compressor. At most `MAX_EQ_BANDS`. */
  eq?: AudioEqBand[];
  compressor?: AudioCompressorSettings;
}

/** Look-ahead brickwall limiter on the export mix bus. */
export interface MasterLimiterSettings {
  enabled: boolean;
  /** Ceiling (dBFS): no exported sample exceeds it. */
  ceilingDb: number;
  /** Look-ahead (seconds); also the bus delay the media engine compensates. */
  lookahead: number;
  /** Seconds. */
  release: number;
}

/** `MIX_FX_MAX_EQ_BANDS` in audio_mix.h. */
export const MAX_EQ_BANDS = 4;

export const EQ_BAND_TYPES: ReadonlyArray<{ value: AudioEqBandType; label: string }> = [
  { value: 'peaking', label: 'Peaking' },
  { value: 'lowShelf', label: 'Low shelf' },
  { value: 'highShelf', label: 'High shelf' },
  { value: 'highPass', label: 'High-pass' },
];

/** Ranges mirror the clamps in native/media_engine (eq.cpp / dynamics.cpp). */
export const EQ_LIMITS = {
  frequency: { min: 20, max: 20_000 },
  gainDb: { min: -24, max: 24 },
  q: { min: 0.1, max: 30 },
} as const;

export const COMPRESSOR_LIMITS = {
  thresholdDb: { min: -60, max: 0 },
  ratio: { min: 1, max: 20 },
  attack: { min: 0, max: 1 },
  release: { min: 0, max: 5 },
  kneeDb: { min: 0, max: 24 },
  makeupDb: { min: 0, max: 24 },
} as const;

export const LIMITER_LIMITS = {
  ceilingDb: { min: -24, max: 0 },
  lookahead: { min: 0, max: 0.02 },
  release: { min: 0.001, max: 5 },
} as const;

export const DEFAULT_EQ_BAND: AudioEqBand = {
  type: 'peaking',
  frequency: 1000,
  gainDb: 0,
  q: 1,
  enabled: true,
};

export const DEFAULT_COMPRESSOR: AudioCompressorSettings = {
  enabled: true,
  thresholdDb: -20,
  ratio: 4,
  attack: 0.01,
  release: 0.1,
  kneeDb: 6,
  makeupDb: 0,
};

/** Off by default: an enabled limiter routes every export through the fx mix. */
export const DEFAULT_MASTER_LIMITER: MasterLimiterSettings = {
  enabled: false,
  ceilingDb: -1,
  lookahead: 0.005,
  release: 0.1,
};

const BAND_TYPES = new Set<AudioEqBandType>(EQ_BAND_TYPES.map((t) => t.value));

function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

function normalizeBand(raw: unknown): AudioEqBand | null {
  if (!raw || typeof raw !== 'object') return null;
  const band = raw as Partial<AudioEqBand>;
  if (!band.type || !BAND_TYPES.has(band.type)) return null;
  return {
    type: band.type,
    frequency: clampNumber(band.frequency, EQ_LIMITS.frequency, DEFAULT_EQ_BAND.frequency),
    gainDb: clampNumber(band.gainDb, EQ_LIMITS.gainDb, 0),
    q: clampNumber(band.q, EQ_LIMITS.q, DEFAULT_EQ_BAND.q),
    enabled: band.enabled !== false,
  };
}

function normalizeCompressor(raw: unknown): AudioCompressorSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<AudioCompressorSettings>;
  return {
    enabled: c.enabled !== false,
    thresholdDb: clampNumber(c.thresholdDb, COMPRESSOR_LIMITS.thresholdDb, DEFAULT_COMPRESSOR.thresholdDb),
    ratio: clampNumber(c.ratio, COMPRESSOR_LIMITS.ratio, DEFAULT_COMPRESSOR.ratio),
    attack: clampNumber(c.attack, COMPRESSOR_LIMITS.attack, DEFAULT_COMPRESSOR.attack),
    release: clampNumber(c.release, COMPRESSOR_LIMITS.release, DEFAULT_COMPRESSOR.release),
    kneeDb: clampNumber(c.kneeDb, COMPRESSOR_LIMITS.kneeDb, DEFAULT_COMPRESSOR.kneeDb),
    makeupDb: clampNumber(c.makeupDb, COMPRESSOR_LIMITS.makeupDb, DEFAULT_COMPRESSOR.makeupDb),
  };
}

/**
 * Sanitize / deep-copy for serialize, load and store writes. Drops malformed
 * bands, caps the band count, clamps every field. Undefined when nothing is
 * left (no bands, no compressor) — bypassed blocks are kept.
 */
export function normalizeClipAudioEffects(raw: unknown): ClipAudioEffects | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const effects = raw as { eq?: unknown; compressor?: unknown };
  const eq = Array.isArray(effects.eq)
    ? effects.eq
        .map(normalizeBand)
        .filter((band): band is AudioEqBand => band !== null)
        .slice(0, MAX_EQ_BANDS)
    : [];
  const compressor = normalizeCompressor(effects.compressor);
  if (eq.length === 0 && !compressor) return undefined;
  return {
    ...(eq.length > 0 ? { eq } : {}),
    ...(compressor ? { compressor } : {}),
  };
}

/** True when some block would actually process audio (not all bypassed). */
export function clipAudioEffectsActive(effects: ClipAudioEffects | undefined): boolean {
  if (!effects) return false;
  if (effects.compressor?.enabled) return true;
  return (effects.eq ?? []).some((band) => band.enabled);
}

export function normalizeMasterLimiter(raw: unknown): MasterLimiterSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MASTER_LIMITER };
  const l = raw as Partial<MasterLimiterSettings>;
  return {
    enabled: l.enabled === true,
    ceilingDb: clampNumber(l.ceilingDb, LIMITER_LIMITS.ceilingDb, DEFAULT_MASTER_LIMITER.ceilingDb),
    lookahead: clampNumber(l.lookahead, LIMITER_LIMITS.lookahead, DEFAULT_MASTER_LIMITER.lookahead),
    release: clampNumber(l.release, LIMITER_LIMITS.release, DEFAULT_MASTER_LIMITER.release),
  };
}

export function masterLimiterActive(limiter: MasterLimiterSettings | null | undefined): boolean {
  return Boolean(limiter?.enabled);
}

/** Stable key for caches: changes whenever the processed audio would. */
export function audioEffectsSignature(effects: ClipAudioEffects | undefined): string {
  if (!clipAudioEffectsActive(effects)) return '';
  const bands = (effects!.eq ?? [])
    .filter((band) => band.enabled)
    .map((band) => `${band.type}:${band.frequency}:${band.gainDb}:${band.q}`)
    .join(',');
  const c = effects!.compressor;
  const comp = c?.enabled
    ? `${c.thresholdDb}:${c.ratio}:${c.attack}:${c.release}:${c.kneeDb}:${c.makeupDb}`
    : '';
  return `${bands}|${comp}`;
}
