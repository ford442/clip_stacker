import type { Clip } from '../types';
import type { Keyframe } from '../timeline/keyframes';
import type { ClipAudioEffects } from './audioEffects';

/** One clip's audio placement on the output timeline. */
export interface AudioScheduleEntry {
  clipId: string;
  objectUrl: string;
  /** Output-timeline time when this clip's audio begins (seconds). */
  timelineStart: number;
  /** Trimmed duration on the output timeline (seconds), including all loop cycles. */
  duration: number;
  /** Duration of ONE play-through of the remapped window (seconds). `duration` = `cycleDuration * loopCount`. */
  cycleDuration: number;
  /** Number of times the cycle repeats back to back. 1 = no loop. */
  loopCount: number;
  /** Offset into the source media / AudioBuffer (seconds). */
  bufferOffset: number;
  volume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  /** Constant source playback speed (1 = normal). Ignored when `rateRemap` is set. */
  playbackRate: number;
  /**
   * Absolute linear-gain keyframes (clip-local seconds). Empty → use `volume`.
   * Fades and bed ducking still multiply on top of the sampled level.
   */
  volumeAutomation?: Keyframe[];
  /** Stereo pan keyframes (−1 L … +1 R). Empty → centered (0). */
  panAutomation?: Keyframe[];
  /**
   * Insert chain (EQ → compressor), present only when some block is enabled.
   * Applied by the media engine before gain/pan on export and in the preview's
   * processed buffer; never by Web Audio nodes.
   */
  audioEffects?: ClipAudioEffects;
  /**
   * When true, audio is pitch-preserved WSOLA-remapped offline to `duration`
   * and played at rate 1 from buffer offset 0 (trim already baked in).
   */
  rateRemap?: boolean;
  /** Clip snapshot fields needed to rebuild a remapped buffer. */
  rateRemapClip?: Pick<
    Clip,
    'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation' | 'reversed'
  >;
  /**
   * Constant-rate reverse: play a buffer that is the trim window backward,
   * still at `playbackRate`. Speed curves use `rateRemap` instead and flip
   * the source-offset map.
   */
  reverseAudio?: boolean;
  reverseClip?: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration'>;
  /**
   * Audio-bed / music track clip. When its timeline range overlaps a non-bed
   * (dialogue / base) entry, playback ducks its gain for intelligible speech
   * — unless its lane sets its own ducking (`laneDuck`).
   */
  isBed?: boolean;
  /**
   * The holding lane (`Track.id`): which lane bus the entry mixes into.
   * Absent when the schedule was built without tracks (everything then mixes
   * straight to the master sum).
   */
  trackId?: string;
  /**
   * The lane overrides the legacy bed step: `'sidechain'` (the bus graph
   * ducks it under another lane) or `'off'`. Absent = legacy behaviour.
   */
  laneDuck?: 'sidechain' | 'off';
}
