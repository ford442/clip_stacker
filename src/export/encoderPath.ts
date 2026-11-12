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
 *  3. FFmpeg — everything else, and the runtime fallback; except that a
 *     nested sequence or a Display P3 / HDR10 output is refused instead of
 *     falling there (Force FFmpeg still writes a Rec.709 wide output).
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
import { isSequenceClip } from '../timeline/sequenceResolve';

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
  if (clips.some(isSequenceClip)) blockers.push('nested sequences');
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
 * A nested sequence is a recursion of the composition plan: only the GPU
 * compositor draws it. FFmpeg would read the sequence clip's empty
 * placeholder file, so a render that would land there is refused rather
 * than bounced through an intermediate file. Undefined when the timeline
 * has no sequence clips.
 */
export function nestedSequenceFfmpegRefusal(clips: Array<Pick<Clip, 'source'>>, why: string): string | undefined {
  if (!clips.some(isSequenceClip)) return undefined;
  return (
    `This timeline has nested sequences, which only the GPU compositor (WebGPU + WebCodecs) can render — ${why}. ` +
    'Turn Force FFmpeg off and render in a browser with WebGPU.'
  );
}

const WIDE_OUTPUT_LABEL: Partial<Record<OutputColor, string>> = {
  'display-p3': 'Display P3',
  hdr10: 'HDR10',
};

/**
 * Display P3 and HDR10 are written only by the GPU compositor + WebCodecs
 * (the managed passes, the P3 canvas and the I420P10 pack are WebGPU). A
 * render that would *fall* to FFmpeg — not one the user forced there — is
 * refused rather than written as a Rec.709 file. Undefined for Rec.709 SDR.
 */
export function wideOutputFfmpegRefusal(outputColor: OutputColor | undefined, why: string): string | undefined {
  const label = outputColor ? WIDE_OUTPUT_LABEL[outputColor] : undefined;
  if (!label) return undefined;
  return (
    `${label} output is written only by the GPU encoder (WebGPU + WebCodecs) — ${why}. ` +
    'Choose Rec.709 SDR output, or turn on Force FFmpeg to write a Rec.709 file.'
  );
}

/** True when the GPU encoder is the candidate (everything but the WebCodecs probe). */
export function isGpuEncodeCandidate(input: EncoderPathInput): boolean {
  if (input.forceFFmpeg || !(input.willReencode || mustReencode(input))) return false;
  return canUseGpuVideoEncoder(input.clips, input.transitions, input.textOverlays, {
    forceFFmpeg: false,
    useCanvas: false,
    webGpuAvailable: input.webGpuAvailable,
    finishing: input.finishing,
  });
}

/** A sequence clip has no file to stream-copy; a wide output has to be converted. */
function mustReencode(input: Pick<EncoderPathInput, 'clips' | 'outputColor'>): boolean {
  return input.clips.some(isSequenceClip) || wideOutputFfmpegRefusal(input.outputColor, '') !== undefined;
}

/** The FFmpeg decision for a render that could not take the GPU encoder, refused when it must be. */
function ffmpegFallback(input: EncoderPathInput, reasons: string[], why: string): EncoderPathDecision {
  const refusal =
    nestedSequenceFfmpegRefusal(input.clips, why) ?? wideOutputFfmpegRefusal(input.outputColor, why);
  return refusal ? { path: 'ffmpeg', reasons, refusal } : { path: 'ffmpeg', reasons };
}

export function selectEncoderPath(input: EncoderPathInput): EncoderPathDecision {
  const reasons: string[] = [];
  const wideOutput = wideOutputFfmpegRefusal(input.outputColor, '') !== undefined;

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
    const nested = nestedSequenceFfmpegRefusal(input.clips, 'Force FFmpeg is on');
    return nested ? { path: 'ffmpeg', reasons, refusal: nested } : { path: 'ffmpeg', reasons };
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
    return ffmpegFallback(
      input,
      reasons,
      needsCompositor ? 'WebGPU is not available' : 'RIFE-processed clips are encoded by FFmpeg',
    );
  }
  if (wideOutput && input.webGpuAvailable !== true) {
    // A plain timeline is eligible without WebGPU (the sequential encoder can
    // fall back to a 2D canvas), but a wide output cannot.
    reasons.push(
      input.webGpuAvailable === undefined
        ? 'Display P3 / HDR10 needs the GPU compositor and WebGPU has not been confirmed'
        : 'Display P3 / HDR10 needs the GPU compositor and WebGPU is unavailable',
    );
    return ffmpegFallback(input, reasons, 'WebGPU is not available');
  }
  if (!input.willReencode && !mustReencode(input)) {
    reasons.push('Nothing to re-encode — FFmpeg stream-copies (lossless concat)');
    return { path: 'ffmpeg', reasons };
  }
  if (!input.willReencode && wideOutput) {
    reasons.push('Display P3 / HDR10 always re-encodes — a stream copy would keep the source colour');
  }
  const webCodecs = input.webCodecsAvailable ?? input.webGpuAvailable === true;
  if (!webCodecs && wideOutput && input.webCodecsAvailable === false) {
    // The probe is H.264 at this size; it does not speak for the HEVC / AV1
    // 10-bit (or tagged P3) encoder, which `resolveEncoderCodec` resolves —
    // and refuses with the precise reason — when the render starts.
    reasons.push('The H.264 probe failed here; the wide-colour encoder is resolved when the render starts');
  } else if (!webCodecs) {
    reasons.push(
      input.webCodecsAvailable === undefined
        ? 'WebCodecs has not been confirmed (no WebGPU probe)'
        : 'WebCodecs cannot encode this output size here',
    );
    return ffmpegFallback(input, reasons, 'WebCodecs cannot encode this output here');
  }

  reasons.push('GPU encode (WebCodecs)');
  if (input.outputColor === 'hdr10' && (input.textOverlays.length > 0 || input.burnCaptions)) {
    reasons.push(
      'HDR10 titles / captions are composited in the working space at the graphics white, before the PQ output transform',
    );
  }
  return { path: 'webcodecs', reasons };
}
