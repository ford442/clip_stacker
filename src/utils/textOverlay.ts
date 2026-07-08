/**
 * Helpers for text overlays rendered via FFmpeg's `drawtext` filter.
 *
 * `scrollSpeed` is expressed as a percentage of the output video's width
 * crossed per second, rather than a raw px/s value. This keeps the
 * crossing time predictable regardless of output resolution: a value of
 * 20 always takes ~5 seconds to cross the screen, whether rendering at
 * 720p or 4K.
 */

import type { TextOverlay } from '../types';
import { isValidFfmpegColor } from './color';

/** Virtual font filename written to the FFmpeg VFS before rendering. */
export const DRAWTEXT_FONT_FILE = 'roboto.ttf';

/** Default scroll speed: ~5 seconds to cross the screen. */
export const DEFAULT_SCROLL_SPEED = 20;
export const MIN_SCROLL_SPEED = 1;
export const MAX_SCROLL_SPEED = 200;

/** -----------------------------------------------------------------------
 * Bundled font registry
 * --------------------------------------------------------------------- */

/**
 * Describes a font that is bundled under /fonts/ and can be selected
 * for a TextOverlay. The same typeface is used for both preview (Canvas 2D)
 * and export (FFmpeg drawtext) so glyph metrics match.
 */
export interface BundledFont {
  /** Stable id stored in TextOverlay.font (e.g. 'roboto') */
  id: string;
  /** Human label shown in the UI (e.g. 'Roboto Regular') */
  label: string;
  /** CSS font-family name used with @font-face / ctx.font */
  familyName: string;
  /** Filename under public/fonts/ */
  fileName: string;
  /** Filename written into the FFmpeg VFS for this font */
  virtualName: string;
}

/** The default font id used when none is specified or the id is unknown. */
export const DEFAULT_FONT_ID = 'roboto';

/**
 * Small, license-safe set of bundled typefaces.
 * Paths are relative to the site root (served from public/fonts/).
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    id: 'roboto',
    label: 'Roboto Regular',
    familyName: 'Roboto',
    fileName: 'Roboto-Regular.ttf',
    virtualName: 'roboto.ttf',
  },
  {
    id: 'robotoBold',
    label: 'Roboto Bold',
    familyName: 'Roboto Bold',
    fileName: 'Roboto-Bold.ttf',
    virtualName: 'robotoBold.ttf',
  },
  {
    id: 'serif',
    label: 'Serif',
    familyName: 'DejaVu Serif',
    fileName: 'DejaVuSerif.ttf',
    virtualName: 'serif.ttf',
  },
  {
    id: 'mono',
    label: 'Monospace',
    familyName: 'DejaVu Sans Mono',
    fileName: 'DejaVuSansMono.ttf',
    virtualName: 'mono.ttf',
  },
] as const;

/** Lookup table for quick access by id. */
const FONT_BY_ID = new Map<string, BundledFont>(
  BUNDLED_FONTS.map((f) => [f.id, f] as const),
);

/** Return the BundledFont for a given id, or the default if unknown/missing. */
export function getBundledFont(id: string | undefined | null): BundledFont {
  if (!id) return FONT_BY_ID.get(DEFAULT_FONT_ID)!;
  return FONT_BY_ID.get(id) ?? FONT_BY_ID.get(DEFAULT_FONT_ID)!;
}

/** Return the public URL for a bundled font's TTF file. */
export function getFontPublicUrl(font: BundledFont): string {
  return `/fonts/${font.fileName}`;
}

/** Return the virtual filename to use with FFmpeg drawtext:fontfile=. */
export function getFontVirtualName(font: BundledFont): string {
  return font.virtualName;
}

/**
 * Escape user text for FFmpeg `drawtext`'s `text=` option inside a
 * single-quoted filter value. Handles `\`, `'`, `:`, `,`, `%`, and newlines.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

/** Clamp a scroll speed to a sane, non-zero range. */
export function clampScrollSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCROLL_SPEED;
  return Math.min(MAX_SCROLL_SPEED, Math.max(MIN_SCROLL_SPEED, value));
}

/**
 * Approximate time (in seconds) for the ticker to cross the full screen
 * width, ignoring the text's own width (which adds a small additional
 * amount of travel).
 */
export function estimateScrollCrossingSeconds(scrollSpeed: number): number {
  return 100 / clampScrollSpeed(scrollSpeed);
}

/**
 * Build the `x` expression for a scrolling drawtext overlay: starts just
 * off the right edge of the frame and moves left at `scrollSpeed`% of the
 * frame width `w` per second.
 */
export function buildScrollXExpression(scrollSpeed: number): string {
  const fraction = clampScrollSpeed(scrollSpeed) / 100;
  return `w+tw-(t*w*${fraction.toFixed(4)})`;
}

/**
 * Numeric counterpart of {@link buildScrollXExpression} for live preview:
 * the left edge of scrolling text at output time `t`, in pixels. Mirrors
 * FFmpeg's `w+tw-(t*w*fraction)` so the ticker starts fully off the right
 * edge (`textWidth` accounts for its own width) and crosses at the same rate
 * as the export. Pass `textWidth = 0` for a width-agnostic approximation.
 */
export function resolveScrollingX(
  scrollSpeed: number,
  time: number,
  frameWidth: number,
  textWidth = 0,
): number {
  const fraction = clampScrollSpeed(scrollSpeed) / 100;
  return frameWidth + textWidth - time * frameWidth * fraction;
}

/**
 * Resolve the virtual font filename for a TextOverlay suitable for
 * FFmpeg drawtext:fontfile=. Falls back to the default Roboto when
 * the overlay omits the font field or specifies an unknown id.
 */
export function resolveFontFileForOverlay(overlay: TextOverlay): string {
  const font = getBundledFont(overlay.font);
  return getFontVirtualName(font);
}

/**
 * Build a single `drawtext=...` filter expression for one TextOverlay.
 * User text is escaped before being embedded in the filter graph.
 * The fontfile is chosen from the overlay's `font` id (or default).
 */
export function buildDrawtextFilter(
  overlay: TextOverlay,
  fontFile?: string,
): string {
  if (!isValidFfmpegColor(overlay.fontcolor)) {
    throw new Error(
      `Text overlay "${overlay.text.slice(0, 20)}" has an invalid font color: "${overlay.fontcolor}". ` +
        `Use a named color (e.g. "white"), "#RRGGBB", or "0xRRGGBB".`,
    );
  }
  if (overlay.box && !isValidFfmpegColor(overlay.boxColor)) {
    throw new Error(
      `Text overlay "${overlay.text.slice(0, 20)}" has an invalid box color: "${overlay.boxColor}". ` +
        `Use a named color (e.g. "black@0.5"), "#RRGGBB", or "0xRRGGBB", optionally with "@alpha".`,
    );
  }

  const x = overlay.scrolling
    ? buildScrollXExpression(overlay.scrollSpeed)
    : String(overlay.x);

  const resolvedFontFile = fontFile ?? resolveFontFileForOverlay(overlay);

  const parts: string[] = [
    `fontfile=${resolvedFontFile}`,
    `text='${escapeDrawtext(overlay.text)}'`,
    `x=${x}`,
    `y=${overlay.y}`,
    `fontsize=${overlay.fontsize}`,
    `fontcolor=${overlay.fontcolor}`,
  ];

  if (overlay.box) {
    parts.push(`box=1`, `boxcolor=${overlay.boxColor}`);
  }

  return `drawtext=${parts.join(':')}`;
}
