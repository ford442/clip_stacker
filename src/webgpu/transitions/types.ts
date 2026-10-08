import type { Affine2x3 } from '../../utils/clipTransform';

/** Schema for a per-transition uniform exposed in the editor. */
export interface TransitionParamDef {
  key: string;
  label: string;
  type: 'float';
  default: number;
  min: number;
  max: number;
  step?: number;
}

/** WGSL transition definition — body is injected into the shared transition shader template. */
export interface TransitionDef {
  id: string;
  label: string;
  description: string;
  /** FFmpeg xfade transition name when WebGPU is unavailable. */
  xfadeName: string;
  /**
   * WGSL function body. Must assign `result` (vec4<f32>) using:
   *   - sampleFrom(uv), sampleTo(uv)
   *   - u.progress (0→1), u.resolution (vec2), u.custom (vec4)
   */
  wgslBody: string;
  params?: TransitionParamDef[];
}

export interface TransitionRenderParams {
  progress: number;
  /** Letterbox UV for the outgoing clip. */
  fromUvScale: [number, number];
  fromUvOffset: [number, number];
  /** Letterbox UV for the incoming clip. */
  toUvScale: [number, number];
  toUvOffset: [number, number];
  /** Destination rectangle on the canvas in normalized 0–1 coordinates. */
  destRect?: { x: number; y: number; w: number; h: number };
  /** Per-transition custom uniforms (keys match registry param defs). */
  custom?: Record<string, number>;
  /**
   * Layer warp for the outgoing clip (`[a, b, tx, c, d, ty]`): stabilization
   * composed with its picture transform — see `utils/clipTransform.ts`.
   */
  fromWarpMatrix?: Affine2x3;
  /** Layer warp for the incoming clip. */
  toWarpMatrix?: Affine2x3;
  /** Outgoing clip has a picture transform: mask samples outside the picture. */
  fromWarpMasked?: boolean;
  /** Incoming clip has a picture transform: mask samples outside the picture. */
  toWarpMasked?: boolean;
  clear?: boolean;
}
