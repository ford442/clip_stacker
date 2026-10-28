export type TransitionType = 'none' | (string & {});

/** RIFE-generated in-between frames for a morph cut transition. */
export interface MorphTransitionSegment {
  objectUrl: string;
  fileName: string;
  duration: number;
  status: 'pending' | 'generating' | 'ready' | 'failed';
  error?: string;
}

export interface SerializedMorphSegment {
  fileName: string;
  duration: number;
  status: MorphTransitionSegment['status'];
  error?: string;
  /** Embedded morph segment bytes for project portability. */
  sourceMediaDataUrl?: string;
}

/** Defines the transition between clip[index-1] and clip[index] in the timeline. */
export interface ClipTransition {
  /** The clip index at whose *start* this transition occurs (≥ 1). */
  afterClipIndex: number;
  type: TransitionType;
  /** Overlap duration in seconds (0 for hard cut). */
  duration: number;
  /** Per-transition shader uniforms (keys match registry param defs). */
  params?: Record<string, number>;
  /** WGSL expression for `type: 'custom'` — substituted into the transition shader template. */
  customShader?: string;
  /** Populated for `type: 'morph'` after RIFE generates the in-between segment. */
  morphSegment?: MorphTransitionSegment;
}

export interface SerializedTransition {
  afterClipIndex: number;
  type: TransitionType;
  duration: number;
  params?: Record<string, number>;
  customShader?: string;
  morphSegment?: SerializedMorphSegment;
}
