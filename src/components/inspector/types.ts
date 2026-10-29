import type { ClipAutomation, ClipKeyframes } from '../../types';
import type { CaptionsPanelProps } from '../CaptionsPanel';
import type { ClipAudioEffects } from '../../utils/audioEffects';
import type { VideoOutputFormat } from '../../types';

export interface ClipValues {
  title: string;
  trimStart: string;
  trimEnd: string;
  videoFadeIn: string;
  videoFadeOut: string;
  audioFadeIn: string;
  audioFadeOut: string;
  // PiP / compositing layout
  layerIndex: string;
  x: string;
  y: string;
  width: string;
  height: string;
  opacity: string;
  /** OverlayBlendMode, or '' for the default (source alpha). */
  overlayBlend: string;
  chromaColor: string;
  chromaSimilarity: string;
  chromaBlend: string;
  volume: string;
  playbackRate: string;
  loopCount: string;
}

export interface InspectorProps {
  onChange: (values: ClipValues) => void;
  onKeyframesChange?: (keyframes: ClipKeyframes | undefined) => void;
  onAutomationChange?: (automation: ClipAutomation | undefined) => void;
  /** Replace a clip's insert chain (EQ bands + compressor). Takes the id: commits are debounced. */
  onAudioEffectsChange?: (clipId: string, effects: ClipAudioEffects | undefined) => void;
  onApplyKenBurns?: () => void;
  onExtractAudio?: () => void;
  onRife?: (
    mode: 'interpolation' | 'boomerang',
    multiplier: 2 | 4,
    outputFormat?: VideoOutputFormat,
  ) => void;
  /** Toggle camera-shake stabilization for the selected video clip. */
  onStabilizeChange?: (enabled: boolean) => void;
  /** Play the selected clip's trim window backward. */
  onReverseChange?: (enabled: boolean) => void;
  /** Caption-track callbacks, forwarded to the Captions tab. */
  captions: CaptionsPanelProps;
}

export type InspectorTab = 'clip' | 'export' | 'captions';
