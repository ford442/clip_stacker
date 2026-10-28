import { describe, expect, it } from 'vitest';
import {
  audioEffectsSignature,
  clipAudioEffectsActive,
  DEFAULT_MASTER_LIMITER,
  MAX_EQ_BANDS,
  normalizeClipAudioEffects,
  normalizeMasterLimiter,
  type AudioEqBand,
} from './audioEffects';

const band = (overrides: Partial<AudioEqBand> = {}): AudioEqBand => ({
  type: 'peaking',
  frequency: 1000,
  gainDb: 6,
  q: 1,
  enabled: true,
  ...overrides,
});

describe('audioEffects', () => {
  it('normalizes: clamps fields, drops malformed bands, caps the band count', () => {
    const effects = normalizeClipAudioEffects({
      eq: [
        band({ frequency: 5, gainDb: 99, q: 0 }),
        { type: 'notch', frequency: 100 },
        null,
        band({ frequency: Number.NaN }),
        band(),
        band(),
        band(),
      ],
      compressor: { thresholdDb: -200, ratio: 50, attack: -1, release: 'x', kneeDb: 3, makeupDb: 2 },
    });
    expect(effects!.eq).toHaveLength(MAX_EQ_BANDS);
    expect(effects!.eq![0]).toEqual({ type: 'peaking', frequency: 20, gainDb: 24, q: 0.1, enabled: true });
    expect(effects!.eq![1]!.frequency).toBe(1000); // NaN falls back to the default
    expect(effects!.compressor).toEqual({
      enabled: true,
      thresholdDb: -60,
      ratio: 20,
      attack: 0,
      release: 0.1,
      kneeDb: 3,
      makeupDb: 2,
    });
  });

  it('returns undefined for empty or junk input, and keeps bypassed blocks', () => {
    expect(normalizeClipAudioEffects(undefined)).toBeUndefined();
    expect(normalizeClipAudioEffects('eq')).toBeUndefined();
    expect(normalizeClipAudioEffects({ eq: [] })).toBeUndefined();
    const bypassed = normalizeClipAudioEffects({ eq: [band({ enabled: false })] });
    expect(bypassed!.eq![0]!.enabled).toBe(false);
    expect(clipAudioEffectsActive(bypassed)).toBe(false);
  });

  it('is active only when some block is enabled', () => {
    expect(clipAudioEffectsActive({ eq: [band()] })).toBe(true);
    expect(
      clipAudioEffectsActive({
        compressor: {
          enabled: false,
          thresholdDb: -20,
          ratio: 4,
          attack: 0.01,
          release: 0.1,
          kneeDb: 6,
          makeupDb: 0,
        },
      }),
    ).toBe(false);
  });

  it('signature tracks audible changes only', () => {
    const a = { eq: [band(), band({ enabled: false, gainDb: -3 })] };
    expect(audioEffectsSignature(a)).toBe(audioEffectsSignature({ eq: [band(), band({ enabled: false })] }));
    expect(audioEffectsSignature(a)).not.toBe(audioEffectsSignature({ eq: [band({ gainDb: 5.5 })] }));
    expect(audioEffectsSignature({ eq: [band({ enabled: false })] })).toBe('');
  });

  it('master limiter defaults off at -1 dBFS and clamps', () => {
    expect(normalizeMasterLimiter(undefined)).toEqual(DEFAULT_MASTER_LIMITER);
    expect(DEFAULT_MASTER_LIMITER.enabled).toBe(false);
    expect(DEFAULT_MASTER_LIMITER.ceilingDb).toBe(-1);
    expect(normalizeMasterLimiter({ enabled: true, ceilingDb: 3, lookahead: 1, release: 0 })).toEqual({
      enabled: true,
      ceilingDb: 0,
      lookahead: 0.02,
      release: 0.001,
    });
  });
});
