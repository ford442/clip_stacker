/**
 * Validation helpers for FFmpeg color expressions, as used by the `drawtext`
 * filter's `fontcolor` and `boxcolor` options.
 *
 * Accepted formats (see https://ffmpeg.org/ffmpeg-utils.html#Color):
 *   - A named color (e.g. "white", "SkyBlue")
 *   - "#RRGGBB" or "#RRGGBBAA"
 *   - "0xRRGGBB" or "0xRRGGBBAA"
 *   - Any of the above with an optional "@alpha" suffix, where alpha is a
 *     float in [0, 1] or a two-digit hex value (e.g. "black@0.5", "#ff0000@0x80")
 */

// FFmpeg's built-in named colors (ffmpeg/libavutil/color_table.c), lowercased.
export const FFMPEG_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
  "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
  "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
  "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
  "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
  "darksalmon", "darkseagreen", "darkslateblue", "darkslategray",
  "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite",
  "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred",
  "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen",
  "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue",
  "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow",
  "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
  "mediumslateblue", "mediumspringgreen", "mediumturquoise",
  "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
  "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise",
  "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum",
  "powderblue", "purple", "red", "rosybrown", "royalblue", "saddlebrown",
  "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver",
  "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet",
  "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
  // FFmpeg also defines a few special tokens
  "none", "random",
]);

const HEX6OR8 = /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
// Alpha suffix can be a float in [0, 1] or a hex byte (with or without 0x prefix).
const ALPHA_SUFFIX = /^(0?\.\d+|1(\.0+)?|0|[0-9a-fA-F]{1,2}|0x[0-9a-fA-F]{1,2})$/;

/**
 * Returns true if `value` is a color expression that FFmpeg's `drawtext`
 * filter (fontcolor/boxcolor) will accept.
 */
export function isValidFfmpegColor(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;

  const atIndex = trimmed.indexOf("@");
  const colorPart = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
  const alphaPart = atIndex === -1 ? null : trimmed.slice(atIndex + 1);

  if (alphaPart !== null && !ALPHA_SUFFIX.test(alphaPart)) return false;

  if (colorPart.startsWith("#")) {
    return HEX6OR8.test(colorPart.slice(1));
  }
  if (colorPart.toLowerCase().startsWith("0x")) {
    return HEX6OR8.test(colorPart.slice(2));
  }
  return FFMPEG_NAMED_COLORS.has(colorPart.toLowerCase());
}

/**
 * Returns `value` if it is a valid FFmpeg color, otherwise `fallback`.
 */
export function sanitizeFfmpegColor(value: unknown, fallback: string): string {
  if (typeof value === "string" && isValidFfmpegColor(value)) return value;
  return fallback;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Parse an `@alpha` suffix (float in [0,1], a hex byte, or `0x` hex byte). */
function parseAlphaSuffix(alpha: string): number {
  if (/^0x[0-9a-fA-F]{1,2}$/.test(alpha)) {
    return clamp01(parseInt(alpha.slice(2), 16) / 255);
  }
  // Two hex digits containing a letter are unambiguously a hex byte.
  if (/^[0-9a-fA-F]{2}$/.test(alpha) && /[a-fA-F]/.test(alpha)) {
    return clamp01(parseInt(alpha, 16) / 255);
  }
  const n = Number(alpha);
  if (!Number.isFinite(n)) return 1;
  // FFmpeg alpha is a float in [0,1]; values above 1 are treated as a 0–255 byte.
  return clamp01(n > 1 ? n / 255 : n);
}

/**
 * Convert an FFmpeg color expression into a CSS color string plus a separate
 * alpha factor, for rendering text overlays on a 2D canvas. The alpha is
 * returned separately so callers can apply it via `globalAlpha` (composing it
 * with any layer opacity). Assumes `value` is already a valid FFmpeg color
 * (run it through {@link sanitizeFfmpegColor} first).
 *
 * Examples: `0xff8800` → `{ color: '#ff8800', alpha: 1 }`,
 * `black@0.5` → `{ color: 'black', alpha: 0.5 }`.
 */
export function ffmpegColorToCss(value: string): {
  color: string;
  alpha: number;
} {
  const trimmed = (value ?? "").trim();
  const atIndex = trimmed.indexOf("@");
  const colorPart = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
  const alphaPart = atIndex === -1 ? null : trimmed.slice(atIndex + 1);

  let color = colorPart;
  if (color.toLowerCase().startsWith("0x")) {
    color = `#${color.slice(2)}`;
  }

  return {
    color: color || "white",
    alpha: alphaPart === null ? 1 : parseAlphaSuffix(alphaPart),
  };
}
