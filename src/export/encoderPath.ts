/**
 * The one routing decision for a render: which local encoder runs, and why.
 *
 * Both the pre-render estimate (`calculateRenderPlan` → `encoderIntent`) and
 * the router (`hybridMergeClips`) call {@link selectEncoderPath}; they only
 * differ in what they know. The router passes its runtime probes
 * (`webCodecsAvailable`, `mediaRecorderAvailable`); the estimate leaves them
 * undefined, which reads as "probably yes" (WebCodecs is assumed exactly when
 * WebGPU is, MediaRecorder always). So an estimate can only be wrong about
 * the machine, never about the timeline.
 *
 * Order, as the router tries them:
 *  1. Canvas (MediaRecorder) — only when requested and the timeline has
 *     nothing it cannot composite (it plays clips back; it has no keys, PiP,
 *     transitions, finishing, speed curves, loops or reverse).
 *  2. WebCodecs (GPU compositor / sequential decoder → VideoEncoder) — when
 *     not forced off, eligible (`canUseGpuVideoEncoder`), and **re-encoding**:
 *     a lossless concat stays an FFmpeg stream copy.
 *  3. FFmpeg — everything else, and the runtime fallback.
 *
 * Pure: no probes, no globals.
 */
import type { Clip, ClipTransition, TextOverlay } from '../types';
import { clipHasPictureTransform } from '../composition/animatedLayout';
import type { OutputColor } from '../finishing/colorManagement';
import { isFinishingActive, type FinishingSettings } from '../finishing/finishing';
import { resolveLayerKey } from '../composition/overlayKey';
import { clipHasLoop } from '../timeline/playbackRate';
import { canUseGpuVideoEncoder, hasActiveTransitions, shouldUseTimelineGpuExport } from './renderEligibility';
import { clipIsReversed } from '../timeline/reverseClip';
import { clipHasRateAutomation } from '../timeline/timeRemap';

export type SelectedEncoderPath = 'canvas' | 'webcodecs' | 'ffmpeg';

export interface EncoderPathInput {
  clips: Clip[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  finishing?: FinishingSettings;
  forceFFmpeg?: boolean;
  useCanvas?: boolean;
  /** `isWebGpuExportAvailable()`; undefined = not probed (treated as unavailable). */
  webGpuAvailable?: boolean;
  /** `isWebCodecsAvailable(w, h)`; undefined = not probed (assumed iff WebGPU is). */
  webCodecsAvailable?: boolean;
  /** `typeof MediaRecorder !== 'undefined'`; undefined = not probed (assumed). */
  mediaRecorderAvailable?: boolean;
  /** The render re-encodes: plan `willReencode`, resolution normalize or Force re-encode. */
  willReencode: boolean;
  /** Requested output colour (`ColorManagementSettings.outputColor`). */
  outputColor?: OutputColor;
  /** Caption cues drawn into the picture (burn-in mode with cues). */
  burnCaptions?: boolean;
}

export interface EncoderPathDecision {
  path: SelectedEncoderPath;
  /** Why this path, in the order the decision was made (for the plan / Copy Debug). */
  reasons: string[];
  /**
   * Set when the chosen path would write a wrong file, so the render must not
   * run at all (it is never silently "fixed" by a Rec.709 fallback).
   */
  refusal?: string;
}

/** What the MediaRecorder canvas path cannot composite, as user-facing labels. */
export function canvasCompositingBlockers(
  clips: Clip[],
  transitions: ClipTransition[],
  finishing?: FinishingSettings,
): string[] {
  const blockers: string[] = [];
  if (clips.some((clip) => resolveLayerKey(clip) !== null)) blockers.push('chroma/luma keys');
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) blockers.push('PiP/overlay lanes');
  if (clips.some(clipHasPictureTransform)) blockers.push('picture transforms');
  if (hasActiveTransitions(transitions)) blockers.push('transitions');
  if (isFinishingActive(finishing)) blockers.push('finishing');
  // Canvas capture is one realtime <video> play: a constant rate is
  // video.playbackRate, but a curve, a loop or reverse is not.
  if (clips.some(clipHasRateAutomation)) blockers.push('speed curves');
  if (clips.some(clipHasLoop)) blockers.push('loops');
  if (clips.some(clipIsReversed)) blockers.push('reversed clips');
  return blockers;
}

/**
 * HDR10 is encoded from the PQ readback of the composed frame, which does not
 * contain the 2D text / caption pass yet (#347), so such a file would be
 * missing them. Refuse rather than drop them.
 */
export function hdr10TextRefusal(input: Pick<EncoderPathInput, 'outputColor' | 'textOverlays' | 'burnCaptions'>): string | undefined {
  if (input.outputColor !== 'hdr10') return undefined;
  const parts: string[] = [];
  if (input.textOverlays.length > 0) parts.push('text overlays');
  if (input.burnCaptions) parts.push('burned-in captions');
  if (parts.length === 0) return undefined;
  return (
    `HDR10 export cannot include ${parts.join(' or ')} yet — the HDR10 encoder reads the picture ` +
    'before titles and captions are drawn, so they would be missing from the file. Export as ' +
    'Rec.709 or Display P3, or remove them for the HDR10 export.'
  );
}

/** True when the GPU encoder is the candidate (everything but the WebCodecs probe). */
export function isGpuEncodeCandidate(input: EncoderPathInput): boolean {
  if (input.forceFFmpeg || !input.willReencode) return false;
  return canUseGpuVideoEncoder(input.clips, input.transitions, input.textOverlays, {
    forceFFmpeg: false,
    useCanvas: false,
    webGpuAvailable: input.webGpuAvailable,
    finishing: input.finishing,
  });
}

export function selectEncoderPath(input: EncoderPathInput): EncoderPathDecision {
  const reasons: string[] = [];

  if (input.useCanvas) {
    const blockers = canvasCompositingBlockers(input.clips, input.transitions, input.finishing);
    if (blockers.length > 0) {
      reasons.push(
        `Canvas renderer skipped — the timeline has ${blockers.join(', ')}, which it can't composite`,
      );
    } else if (input.mediaRecorderAvailable === false) {
      reasons.push('Canvas renderer skipped — MediaRecorder is not available in this browser');
    } else {
      reasons.push('Canvas renderer requested');
      return { path: 'canvas', reasons };
    }
  }

  if (input.forceFFmpeg) {
    reasons.push('Force FFmpeg is on');
    return { path: 'ffmpeg', reasons };
  }

  const eligible = canUseGpuVideoEncoder(input.clips, input.transitions, input.textOverlays, {
    forceFFmpeg: false,
    useCanvas: false,
    webGpuAvailable: input.webGpuAvailable,
    finishing: input.finishing,
  });
  if (!eligible) {
    const needsCompositor =
      shouldUseTimelineGpuExport(input.clips, input.transitions, input.textOverlays) ||
      isFinishingActive(input.finishing);
    reasons.push(
      needsCompositor
        ? input.webGpuAvailable === undefined
          ? 'The timeline needs the GPU compositor and WebGPU has not been confirmed'
          : 'The timeline needs the GPU compositor and WebGPU is unavailable'
        : 'RIFE-processed clips are encoded by FFmpeg',
    );
    return { path: 'ffmpeg', reasons };
  }
  if (!input.willReencode) {
    reasons.push('Nothing to re-encode — FFmpeg stream-copies (lossless concat)');
    return { path: 'ffmpeg', reasons };
  }
  const webCodecs = input.webCodecsAvailable ?? input.webGpuAvailable === true;
  if (!webCodecs) {
    reasons.push(
      input.webCodecsAvailable === undefined
        ? 'WebCodecs has not been confirmed (no WebGPU probe)'
        : 'WebCodecs cannot encode this output size here',
    );
    return { path: 'ffmpeg', reasons };
  }

  reasons.push('GPU encode (WebCodecs)');
  const refusal = hdr10TextRefusal(input);
  return refusal ? { path: 'webcodecs', reasons, refusal } : { path: 'webcodecs', reasons };
}
