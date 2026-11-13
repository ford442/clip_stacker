import type { ClipAutomation, ClipKeyframes, SourceColorSpaceOverride } from '../../types';
import type { CaptionsPanelProps } from '../CaptionsPanel';
import type { ClipAudioEffects } from '../../audio/audioEffects';
import type { CleanupOptions, VideoOutputFormat } from '../../types';

// The Inspector's clip form state lives in ../../types (the action hooks use it too).
import type { ClipValues } from '../../types';
export type { ClipValues };

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
    cleanup?: CleanupOptions,
  ) => void;
  /** Toggle camera-shake stabilization for the selected video clip. */
  onStabilizeChange?: (enabled: boolean) => void;
  /** Interpret the selected clip's source as another colour space (undefined = the file's tags). */
  onColorSpaceOverrideChange?: (override: SourceColorSpaceOverride | undefined) => void;
  /** Play the selected clip's trim window backward. */
  onReverseChange?: (enabled: boolean) => void;
  /** Caption-track callbacks, forwarded to the Captions tab. */
  captions: CaptionsPanelProps;
}

export type InspectorTab = 'clip' | 'export' | 'captions';
