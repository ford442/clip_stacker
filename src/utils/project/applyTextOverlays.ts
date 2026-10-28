import type { TextAnimatableProp, TextOverlay, TextOverlayKeyframes } from '../../types';
import { PROJECT_SCHEMA_VERSION } from '../../types';
import { sanitizeFfmpegColor } from '../color';
import type { Keyframe, KeyframeEasing } from '../keyframes';
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

type UnknownRecord = Record<string, unknown>;

const TEXT_ANIMATABLE_PROPS: readonly TextAnimatableProp[] = ['x', 'y', 'opacity'];
const EASING_TYPES: ReadonlySet<unknown> = new Set<KeyframeEasing['type']>([
  'linear',
  'bezier',
  'bellCurveSmooth',
  'bellCurveSharp',
]);
const EASING_CONTROL_POINTS = ['x1', 'y1', 'x2', 'y2'] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEasingType(value: unknown): value is KeyframeEasing['type'] {
  return EASING_TYPES.has(value);
}

function readEasing(value: unknown): KeyframeEasing | undefined {
  if (!isRecord(value) || !isEasingType(value.type)) return undefined;
  const easing: KeyframeEasing = { type: value.type };
  for (const key of EASING_CONTROL_POINTS) {
    const point = value[key];
    if (typeof point === 'number' && Number.isFinite(point)) easing[key] = point;
  }
  return easing;
}

/** Keep keyframes with a finite numeric `t` and `value`; drop anything else. */
function readKeyframeTrack(value: unknown): Keyframe[] {
  if (!Array.isArray(value)) return [];
  const track: Keyframe[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { t, value: keyValue } = entry;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (typeof keyValue !== 'number' || !Number.isFinite(keyValue)) continue;
    const easing = readEasing(entry.easing);
    track.push({ t, value: keyValue, ...(easing ? { easing } : {}) });
  }
  return track;
}

/**
 * Validate saved overlay keyframes. A non-object is ignored; an object keeps
 * only the animatable lanes that are arrays, each filtered to well-formed keys.
 */
function readTextOverlayKeyframes(value: unknown): TextOverlayKeyframes | undefined {
  if (!isRecord(value)) return undefined;
  const keyframes: TextOverlayKeyframes = {};
  for (const prop of TEXT_ANIMATABLE_PROPS) {
    if (Array.isArray(value[prop])) keyframes[prop] = readKeyframeTrack(value[prop]);
  }
  return keyframes;
}

function readShaderParams(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  // Non-finite / non-number params were already ignored at render time
  // (`resolveShaderParams`); dropping them here keeps the type honest.
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

/**
 * Turn the untrusted `textOverlays` array of a saved project into overlays.
 * Missing or malformed fields fall back to defaults; entries that are not
 * objects are dropped.
 */
export function deserializeTextOverlays(
  rawOverlays: unknown,
  usesPixelLayout: boolean,
  layoutReferenceResolution: string | undefined,
): { textOverlays: TextOverlay[]; invalidColorWarnings: string[] } {
  const invalidColorWarnings: string[] = [];
  const layoutReference = parseLayoutReferenceResolution(layoutReferenceResolution);

  const textOverlays: TextOverlay[] = Array.isArray(rawOverlays)
    ? rawOverlays.flatMap((o: unknown, index): TextOverlay[] => {
        if (!isRecord(o)) return [];
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
        const rawFill = o.fill;
        const fill: 'solid' | 'shader' | undefined =
          rawFill === 'shader' ? 'shader' : rawFill === 'solid' ? 'solid' : undefined;
        const rawShaderId = typeof o.shaderId === 'string' ? o.shaderId.trim() : undefined;
        const shaderId = rawShaderId && isKnownTextShader(rawShaderId) ? rawShaderId : undefined;
        if (rawShaderId && !isKnownTextShader(rawShaderId)) {
          invalidColorWarnings.push(
            `Text overlay ${label}: unknown shader "${rawShaderId}" — falling back to solid color.`,
          );
        }
        const shaderParams = readShaderParams(o.shaderParams);
        const shaderColorsRaw = isRecord(o.shaderColors) ? o.shaderColors : undefined;
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
        const keyframes = readTextOverlayKeyframes(o.keyframes);
        const overlay: TextOverlay = {
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
          ...(keyframes
            ? {
                keyframes: usesPixelLayout
                  ? migrateTextOverlayKeyframesToNormalized(keyframes, layoutReference)
                  : keyframes,
              }
            : {}),
        };
        if (!usesPixelLayout) return [overlay];
        return [{ ...overlay, ...migratePixelTextOverlay(overlay, layoutReference) }];
      })
    : [];

  return { textOverlays, invalidColorWarnings };
}

export function usesPixelLayoutForProject(schemaVersion: number | undefined): boolean {
  return (schemaVersion ?? 1) < PROJECT_SCHEMA_VERSION;
}
