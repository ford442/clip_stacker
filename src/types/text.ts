import type { Keyframe } from '../utils/keyframes';

/** Animatable properties on text overlays. */
export type TextAnimatableProp = 'x' | 'y' | 'opacity';

export type TextOverlayKeyframes = Partial<Record<TextAnimatableProp, Keyframe[]>>;

/**
 * The purely visual properties shared by text overlays and captions: typeface,
 * size, colours, box and position. Split out of {@link TextOverlay} so a
 * {@link CaptionEntry} can carry a partial style override without dragging in
 * the overlay-only fields (`text`, `scrolling`, keyframes, shader fills).
 */
export interface TextOverlayStyle {
  /** Font size in pixels */
  fontsize: number;
  /** Font color — any FFmpeg color value: name ('white'), hex ('#ffffff'), or '0xRRGGBB' */
  fontcolor: string;
  /**
   * Bundled font id to use for this overlay (e.g. 'roboto', 'robotoBold', 'serif', 'mono').
   * If omitted or unknown at load time, falls back to the default (Roboto Regular).
   */
  font?: string;
  /**
   * X position as a fraction of output width (ignored for scrolling text).
   * For text overlays this is the *left* edge; for captions it is the
   * horizontal centre — see {@link CaptionEntry}.
   */
  x: number;
  /**
   * Y position as a fraction of output height. For text overlays this is the
   * *top* edge; for captions it is the baseline of the bottom line.
   */
  y: number;
  /** Whether to draw a filled background box behind the text */
  box: boolean;
  /** Box color — supports alpha, e.g. 'black@0.5' or '0x000000@0.5' */
  boxColor: string;
}

/**
 * A time-coded caption (subtitle) cue on the output timeline.
 *
 * Captions are a separate, importable/exportable track rather than a pile of
 * individually timed {@link TextOverlay}s: they round-trip through `.srt` /
 * `.ass` files (`src/utils/subtitles.ts`) and can be exported burned-in, as a
 * soft `mov_text` track, or as a sidecar `.srt` (`src/ffmpeg/captions.ts`).
 *
 * Times are seconds on the **output** timeline (after trims, speed and
 * transitions), matching text-overlay keyframe times.
 */
export interface CaptionEntry {
  /** Unique identifier */
  id: string;
  /** Cue in-point, in output-timeline seconds. */
  startSec: number;
  /** Cue out-point, in output-timeline seconds. Always `> startSec`. */
  endSec: number;
  /** Cue text. May contain newlines for multi-line cues. */
  text: string;
  /**
   * Per-cue overrides of the project-wide caption style. Unlike a text
   * overlay, `x` is the horizontal **centre** and `y` the **bottom** of the
   * cue box (both fractions of the output size), which is how subtitles are
   * conventionally anchored. Omitted fields inherit `DEFAULT_CAPTION_STYLE`.
   */
  style?: Partial<TextOverlayStyle>;
}

/** How captions are attached to the exported MP4 (`src/ffmpeg/captions.ts`). */
export type CaptionExportMode = 'none' | 'burn' | 'soft';

/** What auto-captioning transcribes: the whole output timeline or one clip. */
export type AutoCaptionScope = 'timeline' | 'clip';

/**
 * A text overlay (caption, ticker, title) rendered via FFmpeg's drawtext filter.
 * All overlays are independent of clips and applied to the final composed video.
 */
export interface TextOverlay extends TextOverlayStyle {
  /** Unique identifier */
  id: string;
  /** Text content to display */
  text: string;
  /** When true the text scrolls right-to-left (news-ticker style) */
  scrolling: boolean;
  /**
   * Horizontal scroll speed as a percentage of the output width crossed per
   * second (only used when scrolling is true). Resolution-independent — a
   * value of 20 takes ~5 seconds to cross the screen at any output size.
   */
  scrollSpeed: number;
  /** Optional keyframe animation (time = seconds on the output timeline). */
  keyframes?: TextOverlayKeyframes;

  /**
   * Fill mode for the text glyphs.
   * - 'solid': use flat fontcolor (current behavior, works on all paths including FFmpeg)
   * - 'shader': procedural WGSL fill sampled inside the glyph mask (GPU paths only)
   * Defaults to 'solid' when omitted.
   */
  fill?: 'solid' | 'shader';
  /**
   * Identifier of a registered shader fill when fill === 'shader'.
   * Unknown ids fall back to solid on load with a warning.
   */
  shaderId?: string;
  /** Per-shader numeric parameters (uniforms). Keys are shader-defined. */
  shaderParams?: Record<string, number>;
  /** Per-shader color parameters (hex/named FFmpeg colors). Keys are shader-defined. */
  shaderColors?: Record<string, string>;
}
