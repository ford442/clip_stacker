import type { Clip, ClipTransition, RenderPlan, TextOverlay } from '../types';
import { clipHasVolumeAdjustment } from '../audio/audioVolume';
import { clipAudioEffectsActive } from '../audio/audioEffects';
import { clipHasLoop, clipHasPlaybackRateAdjustment } from '../timeline/playbackRate';
import { clipIsReversed } from '../timeline/reverseClip';
import { clipHasRateAutomation } from '../timeline/timeRemap';
import {
  clipHasAnimatedPictureTransform,
  clipHasKeyframes,
  clipHasPictureTransform,
} from '../composition/animatedLayout';
import { isStabilizationActive } from '../media/stabilization';
import { isFinishingActive, type FinishingSettings } from '../finishing/finishing';
import { resolveLayerKey } from '../composition/overlayKey';
import { isSequenceClip } from '../timeline/sequenceResolve';

/** Mirrors ffmpegService clipNeedsEffects — shared for encoder path selection. */
export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === 'audio') return true;
  if (clip.rifeProcessed) return true;
  return (
    clip.videoFadeIn > 0 ||
    clip.videoFadeOut > 0 ||
    clip.audioFadeIn > 0 ||
    clip.audioFadeOut > 0 ||
    clipHasVolumeAdjustment(clip) ||
    clipHasPlaybackRateAdjustment(clip) ||
    clipHasRateAutomation(clip) ||
    clipHasLoop(clip) ||
    clipIsReversed(clip)
  );
}

export function hasActiveTransitions(transitions: ClipTransition[]): boolean {
  return transitions.some((transition) => transition.type !== 'none' && transition.duration > 0);
}

export function hasShaderTextOverlays(textOverlays: TextOverlay[]): boolean {
  return textOverlays.some((overlay) => overlay.fill === 'shader');
}

/**
 * Shader-only overlays with no boxes can be blitted onto the WebGPU canvas
 * and captured directly, skipping the extra 2D video copy.
 */
export function canCaptureWebGpuCanvasWithText(
  textOverlays: TextOverlay[],
): boolean {
  if (textOverlays.length === 0) return true;
  return textOverlays.every(
    (overlay) => overlay.fill === 'shader' && !overlay.box,
  );
}

/**
 * Transitions, PiP, clip keyframes, still images, and looped clips need
 * multi-source frame delivery (timeline compositor) — the plain sequential
 * WebCodecs path (`encodeVideoFrames`) walks each clip's trim window once
 * and has no loop-wrap or speed awareness, so a looped clip or any clip
 * whose playback rate is not 1× must route through the compositor's
 * `buildPreviewCompositionPlan` (source time is the integral of the rate,
 * wrapped per loop). That is the same clock the timeline preview uses, so
 * export does not keep 1× frames inside a resized clip. Text overlay
 * keyframes are resolved in the overlay post-pass via
 * `buildPreviewCompositionPlan`.
 */
export function needsMultiLayerComposition(
  clips: Clip[],
  transitions: ClipTransition[],
): boolean {
  if (hasActiveTransitions(transitions)) return true;
  // A nested sequence is drawn by recursing the composition plan.
  if (clips.some(isSequenceClip)) return true;
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) return true;
  if (clips.some(clipHasKeyframes)) return true;
  if (clips.some((clip) => clip.stillImage)) return true;
  if (clips.some(clipHasLoop)) return true;
  if (clips.some(clipHasRateAutomation)) return true;
  if (clips.some(clipHasPlaybackRateAdjustment)) return true;
  if (clips.some(clipIsReversed)) return true;
  return false;
}

/** Solid text overlays are rasterized in a post-pass over decoder output. */
export function needsOverlayPass(
  textOverlays: TextOverlay[],
  _finishing?: FinishingSettings,
): boolean {
  if (textOverlays.length === 0) return false;
  return !hasShaderTextOverlays(textOverlays);
}

/** Timeline compositor export (preview parity) for multi-layer or shader text. */
export function shouldUseTimelineGpuExport(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  _finishing?: FinishingSettings,
): boolean {
  if (needsMultiLayerComposition(clips, transitions)) return true;
  // Shader fills use WebGPU readback on the timeline compositor path.
  if (hasShaderTextOverlays(textOverlays)) return true;
  return false;
}

/** Whether the browser GPU video encoder can handle this render job. */
export function canUseGpuVideoEncoder(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  options: {
    forceFFmpeg?: boolean;
    useCanvas?: boolean;
    webGpuAvailable?: boolean | undefined;
    /** @deprecated Prefer `finishing`. */
    colorGrade?: import('../finishing/lut').ColorGradeSettings;
    finishing?: FinishingSettings | undefined;
  } = {},
): boolean {
  const finishing = options.finishing;
  const legacyGrade = options.colorGrade;
  const effectiveFinishing =
    finishing ??
    (legacyGrade
      ? {
          lut: {
            enabled: legacyGrade.lutId !== 'none' && legacyGrade.intensity > 0,
            lutId: legacyGrade.lutId,
            intensity: legacyGrade.intensity,
          },
        }
      : undefined);

  if (options.forceFFmpeg || options.useCanvas) return false;
  if (shouldUseTimelineGpuExport(clips, transitions, textOverlays, effectiveFinishing)) {
    return options.webGpuAvailable === true;
  }
  if (isFinishingActive(effectiveFinishing)) {
    return options.webGpuAvailable === true;
  }
  if (clips.some((clip) => clip.rifeProcessed)) return false;
  return true;
}

/**
 * Render-plan fields for clip picture transforms, for the encoder that ran
 * (or is expected to). Empty when no clip is transformed.
 *
 * The compositors (WebGPU and Canvas2D) sample through the composed layer
 * warp, so they match the preview. FFmpeg only gets `scale` + `rotate`, and
 * says what that loses instead of exporting a different picture silently.
 * The MediaRecorder canvas encoder is never chosen for a transformed clip
 * (see `hybridMergeClips`), so it maps to nothing here.
 */
export function pictureTransformPlanFields(
  clips: Clip[],
  encoder: RenderPlan['encoderIntent'],
): Pick<RenderPlan, 'pictureTransform' | 'pictureTransformGaps'> {
  const transformed = clips.filter(clipHasPictureTransform);
  if (transformed.length === 0 || encoder === 'canvas' || !encoder) return {};
  if (encoder !== 'ffmpeg') return { pictureTransform: 'gpu' };

  const gaps: string[] = [];
  if (transformed.some((clip) => isStabilizationActive(clip))) {
    gaps.push(
      'Stabilization on rotated / scaled clips (FFmpeg has no libvidstab, so the optical-flow warp is dropped)',
    );
  }
  if (transformed.some(clipHasAnimatedPictureTransform)) {
    gaps.push('Animated rotation / scale (FFmpeg holds the first keyframe)');
  }
  return {
    pictureTransform: 'ffmpeg',
    ...(gaps.length > 0 ? { pictureTransformGaps: gaps } : {}),
  };
}

/** What the remote concat needs to know beyond the clip list. */
export interface RemoteConcatContext {
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  finishing: FinishingSettings;
  captionCount: number;
  hasMasterAudio: boolean;
  /**
   * `timelineNeedsAudioPremix(...)` for this timeline: automation, clip
   * inserts, lane / master bus FX, ducks, loudness, the limiter, audio lanes.
   */
  needsAudioPremix: boolean;
}

/**
 * Why the remote concat (`handleGpuStitch`) cannot run this timeline; empty
 * when it can.
 *
 * An **allow-list**: the remote side only trims each base clip with its own
 * audio and stitches them end to end at one resolution — no compositor, no
 * mixer. So it accepts exactly a plain base-lane video clip (no fades,
 * volume, speed, loop, reverse, stabilization, transform, keyframes, key,
 * still image or muted lane) on a timeline whose audio needs no premix, and
 * refuses everything else rather than enumerating what it would drop. A new
 * clip feature is refused until it is added here on purpose.
 */
export function remoteConcatBlockers(timelineClips: Clip[], context: RemoteConcatContext): string[] {
  const blockers = new Set<string>();
  const add = (label: string) => blockers.add(label);

  for (const clip of timelineClips) {
    if (isSequenceClip(clip)) add('nested sequences');
    if (clip.kind !== 'video') add('audio clips / audio lanes');
    if ((clip.layerIndex ?? 0) > 0) add('PiP/overlay lanes');
    if (clip.trackMuted) add('lane mute');
    if (clip.stillImage) add('still images');
    if (clip.videoFadeIn > 0 || clip.videoFadeOut > 0 || clip.audioFadeIn > 0 || clip.audioFadeOut > 0) {
      add('fades');
    }
    if (clipHasVolumeAdjustment(clip)) add('clip volume');
    if (clip.automation && Object.values(clip.automation).some((lane) => (lane?.length ?? 0) > 0)) {
      add('volume / pan / speed automation');
    }
    if (clipAudioEffectsActive(clip.audioEffects)) add('clip audio inserts');
    if (clipHasPlaybackRateAdjustment(clip) || clipHasRateAutomation(clip)) add('speed changes');
    if (clipIsReversed(clip)) add('reversed clips');
    if (clipHasLoop(clip)) add('loops');
    if (clip.stabilize || isStabilizationActive(clip)) add('stabilization');
    if (clipHasPictureTransform(clip)) add('picture transforms');
    if (clipHasKeyframes(clip)) add('clip keyframes');
    if (resolveLayerKey(clip) !== null) add('chroma/luma keys');
    if (clip.opacity != null && clip.opacity !== 1) add('clip opacity');
  }
  if (hasActiveTransitions(context.transitions)) add('transitions');
  if (context.textOverlays.length > 0) add('text overlays');
  if (context.captionCount > 0) add('captions');
  if (isFinishingActive(context.finishing)) add('finishing');
  if (context.hasMasterAudio) add('master audio');
  if (context.needsAudioPremix) add('the audio mix (automation, inserts, bus FX, loudness or audio lanes)');
  return [...blockers];
}
