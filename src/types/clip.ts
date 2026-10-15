import type { Keyframe } from '../utils/keyframes';

export type ClipKind = 'video' | 'audio';

/**
 * How an overlay (PiP / channel-bug) layer is keyed against the layers below it.
 * - `opaque`         — ignore any source alpha; the overlay is a solid rectangle (legacy default).
 * - `source-alpha`   — use the straight alpha already in the source (PNG/WebP still, WebM+alpha).
 * - `premultiplied`  — same, for sources whose RGB is already multiplied by alpha.
 * - `chroma`         — derive alpha by keying out `chromaKey.color` (green screen / black plate).
 * - `luma`           — derive alpha from luminance (black becomes transparent).
 */
export type OverlayBlendMode =
  | 'opaque'
  | 'source-alpha'
  | 'premultiplied'
  | 'chroma'
  | 'luma';

/** Chroma / luma key parameters for `overlayBlend: 'chroma' | 'luma'`. */
export interface ChromaKeySettings {
  /** Key colour, as `#RRGGBB` or an FFmpeg colour name. */
  color: string;
  /** 0–1 — how close a pixel must be to `color` to become transparent. */
  similarity: number;
  /** 0–1 — softness of the edge between kept and keyed pixels. */
  blend: number;
}

/**
 * Animatable scalar properties on clips: PiP layout, Ken Burns UV, and the
 * picture transform (`src/utils/clipTransform.ts`).
 *
 * `x` / `y` / `width` / `height` stay the rect letterboxing and PiP use. The
 * transform props move the picture *within* that rect and are keyframe-only —
 * an omitted lane means identity, so older projects do not move:
 * `rotation` (degrees, clockwise, default 0), `scaleX` / `scaleY` (default 1),
 * `anchorX` / `anchorY` (pivot, 0–1 of the rect, default 0.5).
 */
export type ClipAnimatableProp =
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'opacity'
  | 'uvScaleX'
  | 'uvScaleY'
  | 'uvOffsetX'
  | 'uvOffsetY'
  | 'rotation'
  | 'scaleX'
  | 'scaleY'
  | 'anchorX'
  | 'anchorY';

export type ClipKeyframes = Partial<Record<ClipAnimatableProp, Keyframe[]>>;

/**
 * Per-clip parameter automation lanes (Cubase / Ableton style).
 * Keyframe times are local clip time in seconds (same as layout keyframes).
 * Constant `clip.playbackRate` is the speed baseline; `automation.playbackRate`
 * keyframes ramp speed over output-local clip time (see `timeRemap.ts`).
 */
export type ClipAutomationProp = 'volume' | 'pan' | 'playbackRate';

export type ClipAutomation = Partial<Record<ClipAutomationProp, Keyframe[]>>;

export interface SyncMarker {
  id: string;
  time: number;
  text: string;
  linkedId?: string;
}

/**
 * Per-frame camera-shake corrections from the `video_stabilize` WASM module.
 *
 * Matrices are inverse warps in normalized UV space, centred on the frame
 * (see `native/video_stabilize/video_stabilize.h`), so preview, GPU export and
 * the canvas renderer can all consume them without knowing the analysis
 * resolution. Deliberately NOT serialized with the project — see
 * `SerializedClip.stabilize`.
 */
/** A clip's preview proxy: which profile, keyed by which source hash, at what size. */
export interface ClipProxy {
  /** `PROXY_PROFILE.id` the proxy was encoded with. */
  profile: string;
  /** Source content hash (`fingerprintMedia`) — half of the store key. */
  hash: string;
  width: number;
  height: number;
}

export interface ClipStabilization {
  /** Rate the analysis sampled the source at (frames per second). */
  fps: number;
  /** `frameCount * 6` floats — [a, b, tx, c, d, ty] per frame. */
  matrices: Float32Array;
  frameCount: number;
  /** Auto-crop baked into the matrices (>= 1). */
  zoom: number;
  /** Peak correction as a fraction of frame width. */
  maxCorrection: number;
  /** Moving-average half-width used, in analysis frames. */
  smoothRadius: number;
}

export interface Clip {
  id: string;
  file: File;
  objectUrl: string;
  title: string;
  kind: ClipKind;
  duration: number;
  /** Native video width in pixels (video clips only). */
  videoWidth?: number;
  /** Native video height in pixels (video clips only). */
  videoHeight?: number;
  /**
   * Whether the source file has an audio stream.
   * `false` for video-only / silent media. Omitted when unknown (treated as
   * having audio until FFmpeg proves otherwise).
   */
  hasAudio?: boolean;
  trimStart: number;
  trimEnd: number; // NaN means "use full duration"
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  inputName?: string;
  /** Group ID for A/B comparison */
  groupId?: string;
  /** Which variant slot this clip occupies within its group */
  groupVariant?: 'A' | 'B';
  /** URL of the remotely stored extracted WAV for this clip */
  remoteAudioUrl?: string;
  /**
   * URL of this clip's source media in the remote media library, if it has
   * already been uploaded there (either by a prior remote save, or because
   * the clip was added from the library). When set, remote saves reuse this
   * URL instead of re-uploading the file.
   */
  remoteSourceUrl?: string;
  // ---------------------------------------------------------------------------
  // RIFE frame interpolation metadata
  // ---------------------------------------------------------------------------
  /** Whether this clip has been processed with RIFE frame interpolation */
  rifeProcessed?: boolean;
  /** The frame-rate multiplier used (e.g. 2 = 2×, 4 = 4×) */
  rifeMultiplier?: number;
  /** Original FPS of the clip before RIFE processing */
  originalFps?: number;
  /** FPS of the clip after RIFE processing */
  processedFps?: number;
  /** RIFE processing mode applied to this clip */
  rifeMode?: 'interpolation' | 'boomerang';
  // ---------------------------------------------------------------------------
  // Picture-in-Picture / compositing layout (only used when layerIndex > 0)
  // ---------------------------------------------------------------------------
  /** Stacking order: 0 = base layer (sequential), 1+ = overlay on top of base. */
  layerIndex?: number;
  // ---------------------------------------------------------------------------
  // Derived track placement (see `utils/trackStacking.ts`)
  //
  // These are stamped onto the flattened timeline view by `toLegacyTimelineView`
  // from the clip's `TrackItem` and its holding `Track`. They are *derived*, not
  // authored: `serializeProject` never writes them, and editing them on a pool
  // clip has no effect. The track model in `editorStore.tracks` is the source of
  // truth.
  // ---------------------------------------------------------------------------
  /** Output-timeline start of this placement in seconds (`TrackItem.startTime`). */
  timelineStart?: number;
  /** True when the holding track is muted — its audio is dropped from the mix. */
  trackMuted?: boolean;
  /** True when the holding track is locked — trim / drag / delete are blocked. */
  trackLocked?: boolean;
  /** Overlay X position as a fraction of output width (0 = left edge). */
  x?: number;
  /** Overlay Y position as a fraction of output height (0 = top edge). */
  y?: number;
  /** Overlay width as a fraction of output width; 0 = preserve source width. */
  width?: number;
  /** Overlay height as a fraction of output height; 0 = preserve source height. */
  height?: number;
  /** Overlay opacity from 0.0 (transparent) to 1.0 (fully opaque). */
  opacity?: number;
  /**
   * How this overlay is keyed against the layers below it. Omitted on older
   * projects and on base-layer clips (treated as `source-alpha`, which is a
   * no-op for the opaque sources that PiP overlays have historically used).
   */
  overlayBlend?: OverlayBlendMode;
  /** Key parameters used when `overlayBlend` is `chroma` or `luma`. */
  chromaKey?: ChromaKeySettings;
  /** Per-clip audio volume multiplier (0 = muted, 1 = unchanged, 2 = double). */
  volume?: number;
  /**
   * Constant output playback speed (1 = normal). Stretches/compresses how long
   * the trimmed source occupies on the timeline. Optional for older projects.
   */
  playbackRate?: number;
  /**
   * Play the trimmed window backward. Output duration is unchanged: speed
   * and loops still apply, and each loop cycle replays the reversed window.
   * Omitted on older projects (forward).
   */
  reversed?: boolean;
  /**
   * Play the trimmed + speed-remapped output window this many times, back to
   * back, as one timeline item. Multiplies output duration. 1 = once (default).
   * Omitted in older projects (treated as 1).
   */
  loopCount?: number;
  /**
   * Parameter automation lanes (volume / pan / playbackRate).
   * Volume keyframes are absolute linear gain (0–2); empty lane uses `volume`.
   * `playbackRate` keyframes remap output→source time via ∫ rate dt.
   * Audio fades and bed ducking still multiply on top of the sampled level.
   */
  automation?: ClipAutomation;
  /**
   * Insert effects (EQ bands → compressor), constant over the clip. Run in
   * the media-engine C++ on both the export premix and the preview buffers.
   */
  audioEffects?: import('../utils/audioEffects').ClipAudioEffects;
  /** Optional per-property keyframe animation (local clip time in seconds). */
  keyframes?: ClipKeyframes;
  /** True when the source is a still image (Ken Burns / UV keyframes). */
  stillImage?: boolean;
  /**
   * Detected beat onset times in seconds (source media timeline).
   * Populated by WASM offline audio analysis; optional / read-only.
   */
  beatTimestamps?: number[];
  /** Rough BPM estimate from beatTimestamps (when available). */
  bpmEstimate?: number;
  /** 0–1 agreement between the detected inter-onset intervals and `bpmEstimate`. */
  bpmConfidence?: number;
  /**
   * Manual BPM (typed or tapped). Wins over `bpmEstimate` everywhere a tempo is
   * needed — see `getClipBpm`.
   */
  bpmOverride?: number;
  /** Timing cues (lyrics, transients) used for sync mapping. */
  syncMarkers?: SyncMarker[];
  /** 256-bin Rec.709 luma histogram from gpu-chores (import analysis). */
  lumaHistogram?: number[];
  lumaLevels?: { black: number; white: number; mean: number };
  /** Small library/scrubber poster (data URL). */
  posterUrl?: string;
  /** Last gpu-chores backend used for import analysis. */
  gpuChoreBackend?: 'webgpu' | 'wasm' | 'cpu';
  gpuChoreReason?: string;
  // ---------------------------------------------------------------------------
  // Video stabilization
  // ---------------------------------------------------------------------------
  /** User toggle — stabilize this clip in preview and export. Video clips only. */
  stabilize?: boolean;
  /** Computed corrections. Recomputed on load; never serialized. */
  stabilization?: ClipStabilization;
  /** Why analysis could not run for this clip (WASM disabled, undecodable, …). */
  stabilizeError?: string;
  // ---------------------------------------------------------------------------
  // Preview proxy (see `utils/proxyMedia.ts`)
  // ---------------------------------------------------------------------------
  /**
   * The preview proxy built for this clip's source. Only the record travels;
   * the bytes live in the working-media store under `proxyStoreKey(hash, profile)`.
   * Preview and stabilization read the proxy; export always reads `file`.
   */
  proxy?: ClipProxy;
}

export interface SerializedClip {
  id: string;
  title: string;
  kind: ClipKind;
  duration: number;
  videoWidth?: number;
  videoHeight?: number;
  /** Whether the source file has an audio stream (omitted when unknown). */
  hasAudio?: boolean;
  trimStart: number;
  trimEnd: number | null;
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  fileName: string;
  /** MIME type of the original source media file (if known) */
  fileType?: string;
  /** Data URL containing the source media bytes for local project portability */
  sourceMediaDataUrl?: string;
  /** Remote URL containing the source media bytes for remote project portability */
  sourceMediaUrl?: string;
  /** Group ID for A/B comparison */
  groupId?: string;
  /** Which variant slot this clip occupies within its group */
  groupVariant?: 'A' | 'B';
  /** URL of the remotely stored extracted WAV for this clip */
  remoteAudioUrl?: string;
  /** Whether this clip has been processed with RIFE frame interpolation */
  rifeProcessed?: boolean;
  /** The frame-rate multiplier used (e.g. 2 = 2×, 4 = 4×) */
  rifeMultiplier?: number;
  /** Original FPS of the clip before RIFE processing */
  originalFps?: number;
  /** FPS of the clip after RIFE processing */
  processedFps?: number;
  /** RIFE processing mode applied to this clip */
  rifeMode?: 'interpolation' | 'boomerang';
  /** PiP / compositing layout properties */
  layerIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  /** Overlay keying mode (omitted when the clip uses the default). */
  overlayBlend?: OverlayBlendMode;
  /** Chroma / luma key parameters (omitted unless keying is configured). */
  chromaKey?: ChromaKeySettings;
  volume?: number;
  playbackRate?: number;
  /** Play the trim window backward. Omit on older projects. */
  reversed?: boolean;
  /** Play the remapped trim window this many times. 1 = once. Omit in old projects. */
  loopCount?: number;
  automation?: ClipAutomation;
  /** Insert effects; omitted when the clip has none (old projects load dry). */
  audioEffects?: import('../utils/audioEffects').ClipAudioEffects;
  keyframes?: ClipKeyframes;
  stillImage?: boolean;
  /** Beat onset times in seconds (source media), from audio analysis. */
  beatTimestamps?: number[];
  /** Rough BPM estimate from beatTimestamps. */
  bpmEstimate?: number;
  /** 0–1 confidence in `bpmEstimate`. */
  bpmConfidence?: number;
  /** Manual BPM override (typed or tapped). */
  bpmOverride?: number;
  syncMarkers?: SyncMarker[];
  lumaHistogram?: number[];
  lumaLevels?: { black: number; white: number; mean: number };
  /**
   * Stabilization toggle. Only the toggle round-trips: the matrices are a few
   * tens of KB per clip and are fully derived from the source media, so a load
   * recomputes them instead of bloating every project file.
   */
  stabilize?: boolean;
  /** Preview proxy record — no bytes, no data URL. */
  proxy?: ClipProxy;
}

/** A group of up to two variants (A = original, B = edited) for A/B comparison. */
export interface ClipGroup {
  id: string;
  /** Clips keyed by slot. */
  variants: Record<'A' | 'B', Clip | null>;
  /** Which variant is currently active on the timeline. */
  activeVariant: 'A' | 'B';
}

export interface SerializedClipGroup {
  id: string;
  activeVariant: 'A' | 'B';
}
