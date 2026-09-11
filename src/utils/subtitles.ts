/**
 * Time-coded caption (subtitle) parsing and serialization.
 *
 * Two interchange formats are supported:
 *
 * - **SubRip (`.srt`)** — the lingua franca. Parsed leniently (see
 *   {@link parseSrt}) because real-world files routinely violate the spec.
 * - **SubStation Alpha (`.ass` / `.ssa`)** — parsed for its `[Events]`
 *   dialogue rows only; inline override tags are stripped. Generated in full
 *   (with per-cue styles) for burned-in export, where it is the only format
 *   that can carry font, colour, box and position.
 *
 * Everything here is pure string ↔ {@link CaptionEntry} work: no FFmpeg, no
 * DOM. The FFmpeg side lives in `src/ffmpeg/captions.ts`.
 */

import type { CaptionEntry, TextOverlayStyle } from '../types';
import { ffmpegColorToCss, ffmpegColorToRgb01 } from './color';
import { getBundledFont } from './textOverlay';

/** Shortest cue we will emit when an import gives a zero/negative duration. */
export const MIN_CAPTION_DURATION_SEC = 0.1;

/**
 * Project-wide caption defaults: white text on a semi-transparent box, anchored
 * bottom-centre. Note the anchor difference from `TextOverlay` — `x` is the
 * horizontal centre and `y` the bottom of the cue, which is how subtitles are
 * conventionally positioned.
 */
export const DEFAULT_CAPTION_STYLE: TextOverlayStyle = {
  fontsize: 36,
  fontcolor: '#ffffff',
  font: 'roboto',
  x: 0.5,
  y: 0.92,
  box: true,
  boxColor: 'black@0.5',
};

/** Merge a per-cue style over the project style over the built-in defaults. */
export function resolveCaptionStyle(
  entry?: Pick<CaptionEntry, 'style'>,
  projectStyle?: Partial<TextOverlayStyle>,
): TextOverlayStyle {
  return {
    ...DEFAULT_CAPTION_STYLE,
    ...(projectStyle ?? {}),
    ...(entry?.style ?? {}),
  };
}

/** Stable-ish id generator for imported / newly added cues. */
export function createCaptionId(): string {
  return `cap-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// ─── Timestamps ──────────────────────────────────────────────────────────────

/**
 * `HH:MM:SS,mmm` (SubRip) or `H:MM:SS.cc` (SSA). Both separators are accepted
 * for both formats, and the hours field is optional, because plenty of
 * generators emit `MM:SS,mmm`.
 */
const TIMESTAMP_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/** A full SubRip cue-timing line: `start --> end` plus optional coordinates. */
const SRT_TIMING_LINE_RE = new RegExp(
  `^\\s*${TIMESTAMP_RE.source}\\s*-->\\s*${TIMESTAMP_RE.source}`,
);

/**
 * Parse a single `HH:MM:SS,mmm` timestamp to seconds.
 * Returns `null` when the string is not a timestamp at all.
 *
 * The fractional field is scaled by its own length, so SSA's two-digit
 * centiseconds (`.50` → 0.5s) and SubRip's three-digit milliseconds
 * (`,500` → 0.5s) both come out right.
 */
export function parseSubtitleTimestamp(value: string): number | null {
  const match = TIMESTAMP_RE.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const fractionSec = Number(fraction) / 10 ** fraction.length;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    fractionSec
  );
}

/** Format seconds as SubRip's `HH:MM:SS,mmm`. */
export function formatSrtTimestamp(seconds: number): string {
  const clamped = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  // Round to milliseconds first so 59.9999 becomes 1:00.000, not 59:100.
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Format seconds as SSA's `H:MM:SS.cc` (centisecond precision). */
export function formatAssTimestamp(seconds: number): string {
  const clamped = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalCs = Math.round(clamped * 100);
  const cs = totalCs % 100;
  const totalSec = (totalCs - cs) / 100;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Put a caption list into the canonical shape the rest of the app assumes:
 * finite non-negative times, `endSec > startSec`, sorted by start time.
 *
 * Overlapping cues are left alone — they are legal in ASS, common in
 * karaoke-style SRT, and both export paths handle them.
 */
export function normalizeCaptions(entries: CaptionEntry[]): CaptionEntry[] {
  return entries
    .map((entry) => {
      const startSec = Number.isFinite(entry.startSec)
        ? Math.max(0, entry.startSec)
        : 0;
      const rawEnd = Number.isFinite(entry.endSec) ? entry.endSec : startSec;
      return {
        ...entry,
        startSec,
        endSec: Math.max(startSec + MIN_CAPTION_DURATION_SEC, rawEnd),
      };
    })
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

/** The cues active at output-timeline time `t` (in list order). */
export function captionsAtTime(
  captions: CaptionEntry[],
  timeSec: number,
): CaptionEntry[] {
  return captions.filter((c) => timeSec >= c.startSec && timeSec < c.endSec);
}

// ─── SubRip (.srt) ───────────────────────────────────────────────────────────

/** Strip a UTF-8 BOM and normalize CRLF / lone-CR line endings to `\n`. */
function toLines(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Parse SubRip text into cues.
 *
 * Deliberately lenient, because generators disagree about nearly everything:
 *
 * - Sequence numbers are optional and ignored (they are re-derived on export).
 * - Blank lines between cues are optional — a cue's text simply runs until the
 *   next timing line, with a trailing sequence number peeled back off.
 * - CRLF, lone CR and a leading BOM are all accepted.
 * - Multi-line cue text is preserved verbatim, newlines included.
 * - Trailing SubRip coordinates (`X1:… Y2:…`) after the timing are discarded.
 *
 * Cues without a parsable timing line are skipped rather than throwing, so one
 * corrupt entry cannot lose the rest of the file.
 */
export function parseSrt(text: string): CaptionEntry[] {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const lines = toLines(text);
  const entries: CaptionEntry[] = [];

  /** Indices of every timing line, so we know where each cue's text ends. */
  const timingIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SRT_TIMING_LINE_RE.test(lines[i])) timingIndices.push(i);
  }

  for (let cue = 0; cue < timingIndices.length; cue++) {
    const timingIndex = timingIndices[cue];
    const match = SRT_TIMING_LINE_RE.exec(lines[timingIndex]);
    if (!match) continue;

    const startSec = parseSubtitleTimestamp(match[0].split('-->')[0]);
    const endSec = parseSubtitleTimestamp(match[0].split('-->')[1]);
    if (startSec === null || endSec === null) continue;

    // Text runs to the next timing line (or EOF). When cues are not separated
    // by a blank line, the next cue's sequence number sits on the last line of
    // this one's text, so drop a trailing bare-number line before trimming.
    const nextTimingIndex = timingIndices[cue + 1] ?? lines.length;
    const textLines = lines.slice(timingIndex + 1, nextTimingIndex);
    while (textLines.length > 0 && textLines[textLines.length - 1].trim() === '') {
      textLines.pop();
    }
    if (
      cue + 1 < timingIndices.length &&
      textLines.length > 0 &&
      /^\s*\d+\s*$/.test(textLines[textLines.length - 1])
    ) {
      textLines.pop();
      while (textLines.length > 0 && textLines[textLines.length - 1].trim() === '') {
        textLines.pop();
      }
    }

    const cueText = textLines.join('\n').trim();
    if (cueText === '') continue;

    entries.push({
      id: createCaptionId(),
      startSec,
      endSec,
      text: cueText,
    });
  }

  return normalizeCaptions(entries);
}

/**
 * Serialize cues as SubRip. Sequence numbers are re-derived from the sorted
 * order, so `parseSrt(serializeSrt(x))` returns `x`'s timings and text
 * regardless of how the input was numbered.
 */
export function serializeSrt(captions: CaptionEntry[]): string {
  return normalizeCaptions(captions)
    .map((entry, index) => {
      const timing = `${formatSrtTimestamp(entry.startSec)} --> ${formatSrtTimestamp(entry.endSec)}`;
      return `${index + 1}\n${timing}\n${entry.text}\n`;
    })
    .join('\n');
}

// ─── SubStation Alpha (.ass / .ssa) ──────────────────────────────────────────

/** `{\an8}`, `{\pos(10,20)}`, … — styling overrides we drop when importing. */
const ASS_OVERRIDE_TAG_RE = /\{[^}]*\}/g;

/**
 * Convert an ASS dialogue payload to plain text: drop override blocks, turn
 * `\N` (hard break) and `\n` (soft break) into newlines, and `\h` into a
 * regular space.
 */
function assTextToPlain(raw: string): string {
  return raw
    .replace(ASS_OVERRIDE_TAG_RE, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

/**
 * Parse the `[Events]` section of an ASS/SSA file into cues.
 *
 * Field order is taken from the section's `Format:` line rather than assumed,
 * since SSA v4 and ASS v4+ order them differently. The text field is always
 * last and may itself contain commas, so the row is split with a field limit.
 * Styling (font, colour, position) is not imported — inline override tags are
 * stripped and the project's caption style applies.
 */
export function parseAss(text: string): CaptionEntry[] {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const lines = toLines(text);
  const entries: CaptionEntry[] = [];

  let inEvents = false;
  let fields: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;

    if (trimmed.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(trimmed);
      fields = null;
      continue;
    }
    if (!inEvents) continue;

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const descriptor = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1);

    if (descriptor === 'format') {
      fields = value.split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    // `Comment:` rows are dialogue-shaped but intentionally not rendered.
    if (descriptor !== 'dialogue') continue;

    // Default to the ASS v4+ field order when the section omitted `Format:`.
    const format = fields ?? [
      'layer', 'start', 'end', 'style', 'name',
      'marginl', 'marginr', 'marginv', 'effect', 'text',
    ];
    const textIndex = format.indexOf('text');
    if (textIndex === -1) continue;

    // Split into exactly `format.length` fields: everything after the last
    // separator belongs to `Text`, commas and all.
    const parts = value.split(',');
    const head = parts.slice(0, format.length - 1).map((p) => p.trim());
    const tail = parts.slice(format.length - 1).join(',');
    const row = [...head, tail];

    const startSec = parseSubtitleTimestamp(row[format.indexOf('start')] ?? '');
    const endSec = parseSubtitleTimestamp(row[format.indexOf('end')] ?? '');
    if (startSec === null || endSec === null) continue;

    const cueText = assTextToPlain(row[textIndex] ?? '');
    if (cueText === '') continue;

    entries.push({ id: createCaptionId(), startSec, endSec, text: cueText });
  }

  return normalizeCaptions(entries);
}

// ─── ASS generation (burned-in export) ───────────────────────────────────────

/**
 * ASS colours are `&HAABBGGRR` — reversed channel order, and `AA` is
 * *transparency* (00 = opaque), the inverse of every other alpha in this app.
 *
 * Named FFmpeg colours outside `ffmpegColorToRgb01`'s small table fall back to
 * white, matching what the preview canvas does with the same value.
 */
export function ffmpegColorToAss(value: string): string {
  const [r, g, b] = ffmpegColorToRgb01(value);
  const { alpha } = ffmpegColorToCss(value);
  const byte = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `&H${byte(1 - alpha)}${byte(b)}${byte(g)}${byte(r)}`;
}

/**
 * Resolve a bundled font id to the family name libass will match against the
 * TTFs written into the FFmpeg VFS, plus whether to set the ASS bold flag.
 *
 * The bold Roboto is a separate file whose *internal* family is still
 * "Roboto" (the "Roboto Bold" name in `BUNDLED_FONTS` is a CSS `@font-face`
 * alias), so it is selected via the bold flag rather than by name.
 */
export function assFontForOverlayFont(fontId: string | undefined): {
  name: string;
  bold: boolean;
} {
  const font = getBundledFont(fontId);
  if (font.id === 'robotoBold') return { name: 'Roboto', bold: true };
  return { name: font.familyName, bold: false };
}

/** Escape cue text for an ASS `Dialogue:` row (newlines become hard breaks). */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n|\r|\n/g, '\\N');
}

/** One `Style:` row's worth of resolved caption styling. */
function assStyleRow(name: string, style: TextOverlayStyle): string {
  const font = assFontForOverlayFont(style.font);
  const primary = ffmpegColorToAss(style.fontcolor);
  const back = ffmpegColorToAss(style.boxColor);
  // BorderStyle 3 paints an opaque box behind the text (BackColour); 1 is the
  // usual outline + drop shadow. Outline width doubles as the box padding.
  const borderStyle = style.box ? 3 : 1;
  const outline = style.box ? 4 : 2;
  return [
    `Style: ${name}`,
    font.name,
    String(Math.round(style.fontsize)),
    primary,
    primary,
    '&H00000000',
    back,
    font.bold ? '-1' : '0',
    '0', '0', '0',
    '100', '100', '0', '0',
    String(borderStyle),
    String(outline),
    '0',
    // Alignment 2 = bottom-centre; per-cue \pos() overrides the margins.
    '2',
    '10', '10', '10', '1',
  ].join(',');
}

export interface AssDocumentOptions {
  /** Output width in pixels — sets `PlayResX` so `\pos()` is in real pixels. */
  width: number;
  /** Output height in pixels — sets `PlayResY`. */
  height: number;
  /** Project-wide style; per-cue `style` overrides win over it. */
  projectStyle?: Partial<TextOverlayStyle>;
}

/**
 * Build a complete ASS document for burning captions in with FFmpeg's
 * `ass` filter.
 *
 * Cues whose resolved style differs from the project style get their own
 * `Style:` row, so per-cue font/size/colour overrides survive the burn (the
 * `subtitles=…:force_style=` route can only style the whole file at once).
 *
 * Positions are emitted as `\pos()` in `PlayRes` pixels with alignment 2, so
 * `style.x` is the cue's horizontal centre and `style.y` its bottom — the
 * anchor documented on {@link CaptionEntry}.
 */
export function buildAssDocument(
  captions: CaptionEntry[],
  options: AssDocumentOptions,
): string {
  const { width, height, projectStyle } = options;
  const baseStyle = resolveCaptionStyle(undefined, projectStyle);

  const styleRows = [assStyleRow('Default', baseStyle)];
  const styleNameByKey = new Map<string, string>();

  const events = normalizeCaptions(captions).map((entry) => {
    const style = resolveCaptionStyle(entry, projectStyle);

    // One extra Style: row per distinct override, not per cue.
    let styleName = 'Default';
    const key = JSON.stringify(style);
    if (key !== JSON.stringify(baseStyle)) {
      const existing = styleNameByKey.get(key);
      if (existing) {
        styleName = existing;
      } else {
        styleName = `Cue${styleNameByKey.size + 1}`;
        styleNameByKey.set(key, styleName);
        styleRows.push(assStyleRow(styleName, style));
      }
    }

    const posX = Math.round(style.x * width);
    const posY = Math.round(style.y * height);
    const text = `{\\pos(${posX},${posY})}${escapeAssText(entry.text)}`;
    return `Dialogue: 0,${formatAssTimestamp(entry.startSec)},${formatAssTimestamp(entry.endSec)},${styleName},,0,0,0,,${text}`;
  });

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(width)}`,
    `PlayResY: ${Math.round(height)}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleRows,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

// ─── Format detection ────────────────────────────────────────────────────────

export type SubtitleFormat = 'srt' | 'ass';

/**
 * Pick a parser for `text`, preferring the filename's extension and falling
 * back to sniffing for an ASS section header.
 */
export function detectSubtitleFormat(
  text: string,
  fileName?: string,
): SubtitleFormat {
  if (fileName && /\.(ass|ssa)$/i.test(fileName)) return 'ass';
  if (fileName && /\.srt$/i.test(fileName)) return 'srt';
  return /^\s*\[script info\]/im.test(text) || /^\s*\[events\]/im.test(text)
    ? 'ass'
    : 'srt';
}

/** Parse `.srt` or `.ass` text, choosing the parser by extension/content. */
export function parseSubtitles(text: string, fileName?: string): CaptionEntry[] {
  return detectSubtitleFormat(text, fileName) === 'ass'
    ? parseAss(text)
    : parseSrt(text);
}
