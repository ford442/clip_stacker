import type { Clip, ClipAnimatableProp, ClipAutomation, ClipKeyframes } from '../../types';
import type { CanvasSize } from '../../utils/overlayCoords';
import type { PipCorner } from '../../utils/pipPreset';
import { InspectorClipAudioSpeedSection } from './InspectorClipAudioSpeedSection';
import { InspectorClipTrimSection } from './InspectorClipTrimSection';
import { InspectorClipVideoToolsSection } from './InspectorClipVideoToolsSection';
import type { ClipValues } from './types';

export interface InspectorClipTabProps {
  clip: Clip;
  values: ClipValues;
  clipLocalTime: number;
  layoutCanvas: CanvasSize;
  trimStart: number;
  trimEnd: number;
  trimDuration: number;
  trimStartPct: number;
  trimEndPct: number;
  clipPreviewDuration: number;
  currentThumbs: string[] | undefined;
  currentWave: Float32Array | undefined;
  volumeValue: number;
  volumePercent: number;
  playbackRateValue: number;
  trimmedSourceDuration: number;
  outputSpeedDuration: number;
  loopCountValue: number;
  loopedOutputDuration: number;
  fitBeatCount: string;
  setFitBeatCount: (value: string) => void;
  isOverlay: boolean;
  overlayOffCanvas: boolean;
  hasAdvancedLayout: boolean;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  pipCorner: PipCorner;
  setPipCorner: (corner: PipCorner) => void;
  activeKeyframeProp: ClipAnimatableProp;
  setActiveKeyframeProp: (prop: ClipAnimatableProp) => void;
  rifeMultiplier: 2 | 4;
  setRifeMultiplier: (value: 2 | 4) => void;
  rifeProcessing: boolean;
  stabilizeStatus: string | null;
  update: (field: keyof ClipValues, value: string) => void;
  nudge: (field: 'trimStart' | 'trimEnd', delta: number) => void;
  updateTrimStart: (nextStart: number) => void;
  updateTrimEnd: (nextEnd: number) => void;
  setPlaybackRate: (rate: number) => void;
  setLoopCount: (count: number) => void;
  applyPipPreset: (corner: PipCorner) => void;
  applyLogoPreset: (corner: PipCorner) => void;
  useAsBaseLayer: () => void;
  onAutomationChange?: (automation: ClipAutomation | undefined) => void;
  onExtractAudio?: () => void;
  onStabilizeChange?: (enabled: boolean) => void;
  onRife?: (mode: 'interpolation' | 'boomerang', multiplier: 2 | 4) => void;
  onKeyframesChange?: (keyframes: ClipKeyframes | undefined) => void;
  onApplyKenBurns?: () => void;
}

export function InspectorClipTab(props: InspectorClipTabProps) {
  const { clip } = props;
  return (
    <div className="inspector-fields">
      <InspectorClipTrimSection
        clip={clip}
        values={props.values}
        trimStart={props.trimStart}
        trimEnd={props.trimEnd}
        trimDuration={props.trimDuration}
        trimStartPct={props.trimStartPct}
        trimEndPct={props.trimEndPct}
        clipPreviewDuration={props.clipPreviewDuration}
        currentThumbs={props.currentThumbs}
        currentWave={props.currentWave}
        update={props.update}
        nudge={props.nudge}
        updateTrimStart={props.updateTrimStart}
        updateTrimEnd={props.updateTrimEnd}
      />
      <InspectorClipAudioSpeedSection
        clip={clip}
        clipLocalTime={props.clipLocalTime}
        currentWave={props.currentWave}
        volumeValue={props.volumeValue}
        volumePercent={props.volumePercent}
        playbackRateValue={props.playbackRateValue}
        trimmedSourceDuration={props.trimmedSourceDuration}
        outputSpeedDuration={props.outputSpeedDuration}
        loopCountValue={props.loopCountValue}
        loopedOutputDuration={props.loopedOutputDuration}
        fitBeatCount={props.fitBeatCount}
        setFitBeatCount={props.setFitBeatCount}
        setPlaybackRate={props.setPlaybackRate}
        setLoopCount={props.setLoopCount}
        updateVolume={(value) => props.update('volume', value)}
        onAutomationChange={props.onAutomationChange}
        onExtractAudio={props.onExtractAudio}
      />
      <InspectorClipVideoToolsSection
        clip={clip}
        values={props.values}
        clipLocalTime={props.clipLocalTime}
        layoutCanvas={props.layoutCanvas}
        isOverlay={props.isOverlay}
        overlayOffCanvas={props.overlayOffCanvas}
        hasAdvancedLayout={props.hasAdvancedLayout}
        advancedOpen={props.advancedOpen}
        setAdvancedOpen={props.setAdvancedOpen}
        pipCorner={props.pipCorner}
        setPipCorner={props.setPipCorner}
        activeKeyframeProp={props.activeKeyframeProp}
        setActiveKeyframeProp={props.setActiveKeyframeProp}
        rifeMultiplier={props.rifeMultiplier}
        setRifeMultiplier={props.setRifeMultiplier}
        rifeProcessing={props.rifeProcessing}
        stabilizeStatus={props.stabilizeStatus}
        update={props.update}
        applyPipPreset={props.applyPipPreset}
        applyLogoPreset={props.applyLogoPreset}
        useAsBaseLayer={props.useAsBaseLayer}
        onStabilizeChange={props.onStabilizeChange}
        onRife={props.onRife}
        onKeyframesChange={props.onKeyframesChange}
        onApplyKenBurns={props.onApplyKenBurns}
      />
    </div>
  );
}
