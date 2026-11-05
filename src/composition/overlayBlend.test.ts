import { describe, expect, it } from 'vitest';
import {
  buildOverlayAlphaFilters,
  buildOverlayFilter,
  overlayAlphaMode,
  resolveChromaKey,
  resolveOverlayBlend,
  toFfmpegColor,
} from './overlayBlend';

describe('resolveOverlayBlend', () => {
  it('defaults to source alpha', () => {
    expect(resolveOverlayBlend({})).toBe('source-alpha');
    expect(resolveOverlayBlend({ overlayBlend: 'chroma' })).toBe('chroma');
  });
});

describe('resolveChromaKey', () => {
  it('fills missing fields from the defaults and clamps to 0–1', () => {
    expect(resolveChromaKey({})).toEqual({ color: '#00FF00', similarity: 0.3, blend: 0.1 });
    expect(
      resolveChromaKey({ chromaKey: { color: '#123456', similarity: 5, blend: -1 } }),
    ).toEqual({ color: '#123456', similarity: 1, blend: 0 });
  });
});

describe('toFfmpegColor', () => {
  it('normalizes hex colours and passes names through', () => {
    expect(toFfmpegColor('#00FF00')).toBe('0x00FF00');
    expect(toFfmpegColor('00ff00')).toBe('0x00ff00');
    expect(toFfmpegColor('green')).toBe('green');
  });
});

describe('buildOverlayAlphaFilters', () => {
  it('never flattens an overlay to yuv420p', () => {
    for (const overlayBlend of ['opaque', 'source-alpha', 'premultiplied', 'chroma', 'luma'] as const) {
      const chain = buildOverlayAlphaFilters({ overlayBlend }).join(',');
      expect(chain).not.toContain('yuv420p');
      expect(chain).toContain('format=rgba');
    }
  });

  it('keeps source alpha by default', () => {
    expect(buildOverlayAlphaFilters({})).toEqual(['format=rgba']);
  });

  it('discards source alpha in opaque mode', () => {
    expect(buildOverlayAlphaFilters({ overlayBlend: 'opaque' })).toEqual([
      'format=yuv444p',
      'format=rgba',
    ]);
  });

  it('emits a chroma key with the configured colour and tolerances', () => {
    expect(
      buildOverlayAlphaFilters({
        overlayBlend: 'chroma',
        chromaKey: { color: '#0000FF', similarity: 0.2, blend: 0.4 },
      }),
    ).toEqual(['format=rgba', 'chromakey=0x0000FF:0.2:0.4']);
  });

  it('emits a luma key on an alpha-capable pixel format', () => {
    expect(buildOverlayAlphaFilters({ overlayBlend: 'luma' })).toEqual([
      'format=yuva420p',
      'lumakey=threshold=0:tolerance=0.3:softness=0.1',
      'format=rgba',
    ]);
  });

  it('multiplies the resulting alpha by the clip opacity', () => {
    expect(buildOverlayAlphaFilters({ opacity: 0.25 })).toEqual([
      'format=rgba',
      'colorchannelmixer=aa=0.2500',
    ]);
    expect(buildOverlayAlphaFilters({ opacity: 1 })).toEqual(['format=rgba']);
  });
});

describe('buildOverlayFilter', () => {
  it('composites with straight alpha unless the source is premultiplied', () => {
    expect(overlayAlphaMode({})).toBe('straight');
    expect(overlayAlphaMode({ overlayBlend: 'premultiplied' })).toBe('premultiplied');
    expect(buildOverlayFilter({}, 12, 34)).toBe(
      'overlay=12:34:eof_action=pass:format=auto:alpha=straight',
    );
  });
});
