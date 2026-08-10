import type { TextOverlay } from '../../types';
import { PROJECT_SCHEMA_VERSION } from '../../types';
import { sanitizeFfmpegColor } from '../color';
import {
  DEFAULT_TEXT_OVERLAY_X,
  DEFAULT_TEXT_OVERLAY_Y,
  migratePixelTextOverlay,
  migrateTextOverlayKeyframesToNormalized,
  parseLayoutReferenceResolution,
} from '../overlayCoords';
import {
  clampScrollSpeed,
  DEFAULT_FONT_ID,
  DEFAULT_SCROLL_SPEED,
  getBundledFont,
} from '../textOverlay';
import { isKnownTextShader } from '../../webgpu/text/registry';

export function deserializeTextOverlays(
  rawOverlays: unknown,
  usesPixelLayout: boolean,
  layoutReferenceResolution: string | undefined,
): { textOverlays: TextOverlay[]; invalidColorWarnings: string[] } {
  const invalidColorWarnings: string[] = [];
  const layoutReference = parseLayoutReferenceResolution(layoutReferenceResolution);

  const textOverlays: TextOverlay[] = Array.isArray(rawOverlays)
    ? rawOverlays.map((o, index) => {
        const label = o.text ? `"${String(o.text).slice(0, 20)}"` : `#${index + 1}`;
        const rawFontcolor = String(o.fontcolor ?? '#ffffff');
        const fontcolor = sanitizeFfmpegColor(rawFontcolor, '#ffffff');
        if (fontcolor !== rawFontcolor) {
          invalidColorWarnings.push(
            `Text overlay ${label}: invalid font color "${rawFontcolor}" reset to ${fontcolor}.`,
          );
        }
        const rawBoxColor = String(o.boxColor ?? 'black@0.5');
        const boxColor = sanitizeFfmpegColor(rawBoxColor, 'black@0.5');
        if (boxColor !== rawBoxColor) {
          invalidColorWarnings.push(
            `Text overlay ${label}: invalid box color "${rawBoxColor}" reset to ${boxColor}.`,
          );
        }
        // Font family: resolve with safe fallback to default (Roboto) for
        // overlays saved without the field or with an unrecognized id.
        const rawFont = typeof o.font === 'string' && o.font.trim() ? o.font.trim() : undefined;
        const resolved = getBundledFont(rawFont);
        // Fill / shader handling
        const rawFill = (o as any).fill;
        const fill: 'solid' | 'shader' | undefined =
          rawFill === 'shader' ? 'shader' : rawFill === 'solid' ? 'solid' : undefined;
        const rawShaderId = typeof (o as any).shaderId === 'string' ? (o as any).shaderId.trim() : undefined;
        const shaderId = rawShaderId && isKnownTextShader(rawShaderId) ? rawShaderId : undefined;
        if (rawShaderId && !isKnownTextShader(rawShaderId)) {
          invalidColorWarnings.push(
            `Text overlay ${label}: unknown shader "${rawShaderId}" — falling back to solid color.`,
          );
        }
        const shaderParams =
          (o as any).shaderParams && typeof (o as any).shaderParams === 'object'
            ? { ...(o as any).shaderParams }
            : undefined;
        const shaderColorsRaw =
          (o as any).shaderColors && typeof (o as any).shaderColors === 'object'
            ? (o as any).shaderColors as Record<string, unknown>
            : undefined;
        const shaderColors = shaderColorsRaw
          ? Object.fromEntries(
              Object.entries(shaderColorsRaw)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => {
                  const raw = String(v);
                  const sanitized = sanitizeFfmpegColor(raw, raw);
                  if (sanitized !== raw) {
                    invalidColorWarnings.push(
                      `Text overlay ${label}: invalid shader color "${raw}" for "${k}" reset to ${sanitized}.`,
                    );
                  }
                  return [k, sanitized];
                }),
            )
          : undefined;
        return {
          id: String(o.id ?? ''),
          text: String(o.text ?? ''),
          fontsize: Number(o.fontsize ?? 40),
          fontcolor,
          x: Number(o.x ?? DEFAULT_TEXT_OVERLAY_X),
          y: Number(o.y ?? DEFAULT_TEXT_OVERLAY_Y),
          scrolling: Boolean(o.scrolling),
          scrollSpeed: clampScrollSpeed(Number(o.scrollSpeed ?? DEFAULT_SCROLL_SPEED)),
          box: Boolean(o.box),
          boxColor,
          ...(resolved.id !== DEFAULT_FONT_ID ? { font: resolved.id } : {}),
          ...(fill ? { fill } : {}),
          ...(shaderId ? { shaderId } : {}),
          ...(shaderParams ? { shaderParams } : {}),
          ...(shaderColors && Object.keys(shaderColors).length ? { shaderColors } : {}),
          ...(o.keyframes
            ? {
                keyframes: usesPixelLayout
                  ? migrateTextOverlayKeyframesToNormalized(o.keyframes, layoutReference)
                  : o.keyframes,
              }
            : {}),
        };
      })
      .map((overlay) => {
        if (!usesPixelLayout) return overlay;
        const migrated = migratePixelTextOverlay(overlay, layoutReference);
        return { ...overlay, ...migrated };
      })
    : [];

  return { textOverlays, invalidColorWarnings };
}

export function usesPixelLayoutForProject(schemaVersion: number | undefined): boolean {
  return (schemaVersion ?? 1) < PROJECT_SCHEMA_VERSION;
}
