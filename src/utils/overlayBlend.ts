/**
 * Overlay keying / alpha handling shared by the FFmpeg compositing path and
 * the preview compositors.
 *
 * The GPU and Canvas2D compositors already sample the source alpha channel, so
 * a PNG/WebP channel bug composites correctly there for free. The FFmpeg
 * fallback used to flatten every overlay to `yuv420p` before `overlay=`, which
 * turned a non-square logo into a hard rectangle — these helpers keep an alpha
 * plane alive all the way into the `overlay` filter instead.
 */

import type { ChromaKeySettings, Clip, OverlayBlendMode } from '../types';

/** Keying mode used when a clip does not specify one. */
export const DEFAULT_OVERLAY_BLEND: OverlayBlendMode = 'source-alpha';

/** Key defaults for a typical green-screen plate. */
export const DEFAULT_CHROMA_KEY: ChromaKeySettings = {
  color: '#00FF00',
  similarity: 0.3,
  blend: 0.1,
};

/** Keying mode for a clip, falling back to the source-alpha default. */
export function resolveOverlayBlend(
  clip: Pick<Clip, 'overlayBlend'>,
): OverlayBlendMode {
  return clip.overlayBlend ?? DEFAULT_OVERLAY_BLEND;
}

/** Key parameters for a clip, with any missing field filled from the defaults. */
export function resolveChromaKey(
  clip: Pick<Clip, 'chromaKey'>,
): ChromaKeySettings {
  const key = clip.chromaKey;
  return {
    color: key?.color || DEFAULT_CHROMA_KEY.color,
    similarity: clamp01(key?.similarity ?? DEFAULT_CHROMA_KEY.similarity),
    blend: clamp01(key?.blend ?? DEFAULT_CHROMA_KEY.blend),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** `#RRGGBB` / `RRGGBB` → `0xRRGGBB`; colour names pass through unchanged. */
export function toFfmpegColor(color: string): string {
  const trimmed = (color ?? '').trim();
  if (!trimmed) return DEFAULT_CHROMA_KEY.color.replace('#', '0x');
  if (trimmed.startsWith('#')) return `0x${trimmed.slice(1)}`;
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(trimmed)) return `0x${trimmed}`;
  return trimmed;
}

/**
 * Filters that give an overlay stream its alpha plane, in chain order.
 * Never emits `yuv420p` — that is the format that throws the mask away.
 */
export function buildOverlayAlphaFilters(
  clip: Pick<Clip, 'overlayBlend' | 'chromaKey' | 'opacity'>,
): string[] {
  const mode = resolveOverlayBlend(clip);
  const filters: string[] = [];

  switch (mode) {
    case 'opaque':
      // Round-trip through an alpha-less format to discard any source mask,
      // then back to rgba so `overlay` still gets a well-defined alpha plane.
      filters.push('format=yuv444p', 'format=rgba');
      break;
    case 'chroma': {
      const key = resolveChromaKey(clip);
      filters.push(
        'format=rgba',
        `chromakey=${toFfmpegColor(key.color)}:${key.similarity}:${key.blend}`,
      );
      break;
    }
    case 'luma': {
      const key = resolveChromaKey(clip);
      // lumakey operates on yuva pixel formats; similarity/blend map onto its
      // tolerance/softness so the inspector controls drive both key modes.
      filters.push(
        'format=yuva420p',
        `lumakey=threshold=0:tolerance=${key.similarity}:softness=${key.blend}`,
        'format=rgba',
      );
      break;
    }
    case 'premultiplied':
    case 'source-alpha':
    default:
      filters.push('format=rgba');
      break;
  }

  // Opacity multiplies whatever alpha the mode produced.
  const opacity = clip.opacity ?? 1;
  if (opacity < 1) {
    filters.push(`colorchannelmixer=aa=${Math.max(0, opacity).toFixed(4)}`);
  }

  return filters;
}

/** `alpha=` mode for the `overlay` filter itself. */
export function overlayAlphaMode(
  clip: Pick<Clip, 'overlayBlend'>,
): 'straight' | 'premultiplied' {
  return resolveOverlayBlend(clip) === 'premultiplied'
    ? 'premultiplied'
    : 'straight';
}

/** Full `overlay=` filter for a PiP layer, keeping the alpha plane intact. */
export function buildOverlayFilter(
  clip: Pick<Clip, 'overlayBlend'>,
  x: number,
  y: number,
): string {
  return `overlay=${x}:${y}:eof_action=pass:format=auto:alpha=${overlayAlphaMode(clip)}`;
}
