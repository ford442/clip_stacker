/**
 * Shared shape for audio-reactive WebGPU uniforms.
 *
 * WGSL snippet (include in preview / transition shaders):
 *
 * ```wgsl
 * // Replaces padding at the end of Uniforms, or bind as a separate buffer:
 * struct AudioReactive {
 *   bass: f32,
 *   mid: f32,
 *   treble: f32,
 *   beat: f32,
 * }
 * ```
 *
 * PreviewEngine writes these into the main uniform buffer slots 13–16
 * (formerly pads) via setAudioReactive().
 */

export interface AudioReactiveState {
  bass: number;
  mid: number;
  treble: number;
  beat: number;
}

export const ZERO_AUDIO_REACTIVE: AudioReactiveState = {
  bass: 0,
  mid: 0,
  treble: 0,
  beat: 0,
};

/** Float indices in PreviewEngine.uniformData for audio fields. */
export const AUDIO_UNIFORM_OFFSET = {
  bass: 13,
  mid: 14,
  treble: 15,
  beat: 16,
} as const;

/** Total floats in the preview uniform buffer (must match WGSL + PreviewEngine). */
export const PREVIEW_UNIFORM_FLOATS = 20;

/**
 * WGSL fragment helper — optional warm bass lift (matches canvas glow intent).
 * Shaders can copy this body or import via build-time include later.
 */
export const AUDIO_REACTIVE_WGSL_SNIPPET = `
// audioReactive — modulate rgb by bass/beat (no-op when all zeros)
fn applyAudioReactive(color: vec3<f32>, bass: f32, beat: f32) -> vec3<f32> {
  let pulse = clamp(bass * 0.15 + beat * 0.1, 0.0, 0.25);
  let warm = vec3<f32>(1.0, 0.85, 0.65);
  return mix(color, color * warm, pulse);
}
`.trim();
