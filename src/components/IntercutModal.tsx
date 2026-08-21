import { useEffect, useMemo, useState } from 'react';
import type { Clip } from '../types';
import { EASING_PRESETS, type KeyframeEasing } from '../utils/keyframes';
import {
  estimateIntercut,
  type IntercutAudioPolicy,
  type IntercutGeneratorConfig,
} from '../ffmpeg/intercutGenerator';
import {
  hzToSecondsPerCut,
  secondsPerCutToHz,
  type IntercutConsumeMode,
  type IntercutFinalClip,
  type IntercutSourceClock,
} from '../utils/intercut';
import { defaultIntercutPair } from '../utils/intercutPair';
import {
  useEditorClipGroups,
  useEditorClips,
  useSelectedClipId,
} from '../store';

type FrequencyUnit = 'hz' | 'sec';
type EasingName = 'linear' | keyof typeof EASING_PRESETS;

const EASING_OPTIONS: { id: EasingName; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in (ramp up)' },
  { id: 'easeOut', label: 'Ease out (ramp down)' },
  { id: 'easeInOut', label: 'Ease in-out (S-curve)' },
  { id: 'bellCurveSmooth', label: 'Bell curve: Smooth (sine ramp up & down)' },
  { id: 'bellCurveSharp', label: 'Bell curve: Sharp (exponential peak)' },
];

function easingFromName(name: EasingName): KeyframeEasing | undefined {
  if (name === 'linear') return { type: 'linear' };
  return EASING_PRESETS[name];
}

function sourceClipLabel(clip: Clip): string {
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const duration = Math.max(0, trimEnd - clip.trimStart);
  const size =
    clip.videoWidth && clip.videoHeight
      ? ` · ${clip.videoWidth}×${clip.videoHeight}`
      : '';
  return `${clip.title} (${duration.toFixed(1)}s${size})`;
}

function SourceSelect({
  letter,
  label,
  value,
  onChange,
  disabled,
  clips,
  emptyLabel,
  className,
}: {
  letter: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  clips: Clip[];
  emptyLabel: string;
  className?: string;
}) {
  return (
    <label className={`intercut-field intercut-source-field${className ? ` ${className}` : ''}`}>
      <span className="intercut-source-heading">
        <span className="intercut-source-letter" aria-hidden="true">
          {letter}
        </span>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
      >
        <option value="">{emptyLabel}</option>
        {clips.map((c) => (
          <option key={c.id} value={c.id}>
            {sourceClipLabel(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (config: IntercutGeneratorConfig) => Promise<boolean>;
  generating: boolean;
}

export function IntercutModal({ isOpen, onClose, onGenerate, generating }: Props) {
  const clips = useEditorClips();
  const clipGroups = useEditorClipGroups();
  const selectedClipId = useSelectedClipId();
  const videoClips = useMemo(
    () => clips.filter((c) => c.kind === 'video'),
    [clips],
  );

  const [clipAId, setClipAId] = useState<string>('');
  const [clipBId, setClipBId] = useState<string>('');
  const [clipCId, setClipCId] = useState<string>('');
  const [totalDurationSec, setTotalDurationSec] = useState(5);
  const [startFrequencyHz, setStartFrequencyHz] = useState(0.5);
  const [endFrequencyHz, setEndFrequencyHz] = useState(12);
  const [frequencyUnit, setFrequencyUnit] = useState<FrequencyUnit>('hz');
  const [easingName, setEasingName] = useState<EasingName>('easeIn');
  const [audioPolicy, setAudioPolicy] = useState<IntercutAudioPolicy>('both');
  const [snapCutsToBeats, setSnapCutsToBeats] = useState(false);
  const [forceFinalClip, setForceFinalClip] = useState<IntercutFinalClip>('B');
  const [tailDurationSec, setTailDurationSec] = useState(0);
  const [consumeMode, setConsumeMode] = useState<IntercutConsumeMode>('targetDuration');
  const [sourceClock, setSourceClock] = useState<IntercutSourceClock>('freezeHidden');

  useEffect(() => {
    if (!isOpen) return;
    const pair = defaultIntercutPair(clips, clipGroups, selectedClipId);
    setClipAId(pair.clipAId ?? '');
    setClipBId(pair.clipBId ?? '');
    setClipCId(pair.clipCId ?? '');
  }, [isOpen, clips, clipGroups, selectedClipId]);

  useEffect(() => {
    if (!clipCId && forceFinalClip === 'C') {
      setForceFinalClip('B');
    }
  }, [clipCId, forceFinalClip]);

  const clipA = videoClips.find((c) => c.id === clipAId) ?? null;
  const clipB = videoClips.find((c) => c.id === clipBId) ?? null;
  const clipC = videoClips.find((c) => c.id === clipCId) ?? null;
  const sourceIds = [clipA?.id, clipB?.id, clipC?.id].filter((id): id is string => !!id);
  const hasDuplicateSources = new Set(sourceIds).size !== sourceIds.length;

  const estimate = useMemo(() => {
    if (!clipA || !clipB || clipA.id === clipB.id) return null;
    if (clipC && (clipC.id === clipA.id || clipC.id === clipB.id)) return null;
    return estimateIntercut({
      clipA,
      clipB,
      clipC: clipC ?? undefined,
      automation: {
        totalDurationSec,
        startFrequencyHz,
        endFrequencyHz,
        easing: easingFromName(easingName),
      },
      audioPolicy,
      snapCutsToBeats,
      forceFinalClip,
      tailDurationSec,
      consumeMode,
      sourceClock,
    });
  }, [
    clipA,
    clipB,
    clipC,
    totalDurationSec,
    startFrequencyHz,
    endFrequencyHz,
    easingName,
    audioPolicy,
    snapCutsToBeats,
    forceFinalClip,
    tailDurationSec,
    consumeMode,
    sourceClock,
  ]);

  const beatRef: Clip | null = clipA?.beatTimestamps?.length
    ? clipA
    : clipB?.beatTimestamps?.length
      ? clipB
      : clipC?.beatTimestamps?.length
        ? clipC
        : null;
  const beatCount = beatRef?.beatTimestamps?.length ?? 0;

  const isBellCurve = easingName === 'bellCurveSmooth' || easingName === 'bellCurveSharp';

  if (!isOpen) return null;

  const startDisplay =
    frequencyUnit === 'hz' ? startFrequencyHz : hzToSecondsPerCut(startFrequencyHz);
  const endDisplay =
    frequencyUnit === 'hz' ? endFrequencyHz : hzToSecondsPerCut(endFrequencyHz);

  const setStartFromDisplay = (value: number) => {
    setStartFrequencyHz(frequencyUnit === 'hz' ? value : secondsPerCutToHz(value));
  };
  const setEndFromDisplay = (value: number) => {
    setEndFrequencyHz(frequencyUnit === 'hz' ? value : secondsPerCutToHz(value));
  };

  const canGenerate =
    !!clipA &&
    !!clipB &&
    !hasDuplicateSources &&
    (consumeMode === 'entireSources' || totalDurationSec > 0) &&
    !generating &&
    !estimate?.shortageMessage;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="intercut-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !generating) onClose();
      }}
    >
      <div className="modal-content intercut-modal">
        <div className="modal-header">
          <h2 id="intercut-title">Create Intercut Clip</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
            disabled={generating}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="inspector-hint">
            Alternate two or three clips at a changing cut rate. Result is a new
            MP4 in the library (no timeline slicing).
          </p>

          <fieldset className="intercut-fieldset">
            <legend>Sources</legend>
            <div className="intercut-sources">
              <SourceSelect
                letter="A"
                label="Clip A"
                value={clipAId}
                onChange={setClipAId}
                disabled={generating}
                clips={videoClips}
                emptyLabel="Select clip…"
              />
              <SourceSelect
                letter="B"
                label="Clip B"
                value={clipBId}
                onChange={setClipBId}
                disabled={generating}
                clips={videoClips}
                emptyLabel="Select clip…"
              />
              <SourceSelect
                letter="C"
                label="Clip C (optional)"
                value={clipCId}
                onChange={setClipCId}
                disabled={generating}
                clips={videoClips}
                emptyLabel="None — two-clip A/B"
                className="intercut-source-c"
              />
            </div>
            <p className="inspector-hint">
              Cycle is A → B{clipC ? ' → C' : ''}. Leave C empty for a two-clip
              intercut.
            </p>
          </fieldset>

          <fieldset className="intercut-fieldset">
            <legend>Playback</legend>
            <div className="intercut-row">
              <div>
                <p className="intercut-sublabel">Source clocks</p>
                <div className="intercut-unit-toggle" role="group" aria-label="Source clock mode">
                  <button
                    type="button"
                    className={sourceClock === 'freezeHidden' ? 'active' : ''}
                    onClick={() => setSourceClock('freezeHidden')}
                    disabled={generating}
                    title="Hidden clips freeze; keeps all frames of the selected sources"
                  >
                    Freeze hidden
                  </button>
                  <button
                    type="button"
                    className={sourceClock === 'parallel' ? 'active' : ''}
                    onClick={() => setSourceClock('parallel')}
                    disabled={generating}
                    title="Both clips advance with output time; offscreen frames skipped"
                  >
                    Parallel
                  </button>
                </div>
              </div>
              <div>
                <p className="intercut-sublabel">Material</p>
                <div className="intercut-unit-toggle" role="group" aria-label="Material budget">
                  <button
                    type="button"
                    className={consumeMode === 'targetDuration' ? 'active' : ''}
                    onClick={() => setConsumeMode('targetDuration')}
                    disabled={generating}
                  >
                    Set duration
                  </button>
                  <button
                    type="button"
                    className={consumeMode === 'entireSources' ? 'active' : ''}
                    onClick={() => setConsumeMode('entireSources')}
                    disabled={generating}
                  >
                    {sourceClock === 'parallel' ? 'Full span' : clipC ? 'All three' : 'All of both'}
                  </button>
                </div>
              </div>
            </div>
            <p className="inspector-hint">
              {sourceClock === 'parallel'
                ? 'Playheads track output time. Cut to B at 1.2s → see B at 1.2s (offscreen frames skipped).'
                : 'Only the visible source advances; the others freeze and resume (keeps all frames).'}
            </p>
            <p className="inspector-hint">
              {consumeMode === 'entireSources'
                ? sourceClock === 'parallel'
                  ? 'Cut until wall time reaches the longest clip.'
                  : clipC
                    ? 'Cut until every trimmed second of A, B, and C is used (≈ A + B + C).'
                    : 'Cut until every trimmed second of A and B is used (≈ A + B).'
                : 'Stop after the swap duration below (or when a source runs out).'}
            </p>
            {consumeMode === 'targetDuration' && (
              <label className="intercut-field">
                Swap duration (seconds)
                <input
                  type="number"
                  min={0.2}
                  step={0.1}
                  value={totalDurationSec}
                  onChange={(e) => setTotalDurationSec(Number(e.target.value))}
                  disabled={generating}
                />
              </label>
            )}
          </fieldset>

          <fieldset className="intercut-fieldset">
            <legend>Cut frequency</legend>
            <div className="intercut-unit-toggle" role="group" aria-label="Frequency unit">
              <button
                type="button"
                className={frequencyUnit === 'hz' ? 'active' : ''}
                onClick={() => setFrequencyUnit('hz')}
                disabled={generating}
              >
                Hz
              </button>
              <button
                type="button"
                className={frequencyUnit === 'sec' ? 'active' : ''}
                onClick={() => setFrequencyUnit('sec')}
                disabled={generating}
              >
                Seconds per cut
              </button>
            </div>
            <div className="intercut-row">
              <label className="intercut-field">
                {isBellCurve ? 'Base (start & end)' : 'Start'}{' '}
                {frequencyUnit === 'hz' ? '(Hz)' : '(sec/cut)'}
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={Number(startDisplay.toFixed(3))}
                  onChange={(e) => setStartFromDisplay(Number(e.target.value))}
                  disabled={generating}
                />
              </label>
              <label className="intercut-field">
                {isBellCurve ? 'Peak (midpoint)' : 'End'}{' '}
                {frequencyUnit === 'hz' ? '(Hz)' : '(sec/cut)'}
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={Number(endDisplay.toFixed(3))}
                  onChange={(e) => setEndFromDisplay(Number(e.target.value))}
                  disabled={generating}
                />
              </label>
            </div>
            <label className="intercut-field">
              Easing
              <select
                value={easingName}
                onChange={(e) => setEasingName(e.target.value as EasingName)}
                disabled={generating}
                aria-label="Easing"
              >
                {EASING_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="inspector-hint">
              {isBellCurve
                ? 'Bell curve ramps frequency from the base rate up to a peak strobe at the midpoint, then decelerates back down to the base rate.'
                : 'Easing shapes how frequency moves from start rate to end rate. Ease in stays near the start rate then ramps hard. Ease out leaves quickly and settles into the end rate. For a strobe that calms down, set start rate high and end rate low.'}
            </p>
          </fieldset>

          {consumeMode === 'targetDuration' && (
            <fieldset className="intercut-fieldset">
              <legend>Landing</legend>
              <div className="intercut-row">
                <label className="intercut-field">
                  Land on
                  <select
                    value={forceFinalClip}
                    onChange={(e) => setForceFinalClip(e.target.value as IntercutFinalClip)}
                    disabled={generating}
                    aria-label="Land on"
                  >
                    <option value="B">Clip B (resolve on B)</option>
                    <option value="A">Clip A (resolve on A)</option>
                    {clipC ? <option value="C">Clip C (resolve on C)</option> : null}
                    <option value="auto">Natural (cycle A → B{clipC ? ' → C' : ''})</option>
                  </select>
                </label>
                <label className="intercut-field">
                  Tail after last cut (seconds)
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={tailDurationSec}
                    onChange={(e) => setTailDurationSec(Math.max(0, Number(e.target.value)))}
                    disabled={generating}
                  />
                </label>
              </div>
              <p className="inspector-hint">
                Extra hold on the landing clip after the swapping phase. Output
                length is swap duration + tail (if sources still have material).
              </p>
            </fieldset>
          )}

          <fieldset className="intercut-fieldset">
            <legend>Audio</legend>
            <label className="intercut-field">
              Mix
              <select
                value={audioPolicy}
                onChange={(e) => setAudioPolicy(e.target.value as IntercutAudioPolicy)}
                disabled={generating}
                aria-label="Audio"
              >
                <option value="both">Intercut with picture</option>
                <option value="aOnly">Keep audio from A only</option>
                <option value="silent">Silent</option>
              </select>
            </label>
            <label className="inspector-checkbox-label">
              <input
                type="checkbox"
                checked={snapCutsToBeats}
                onChange={(e) => setSnapCutsToBeats(e.target.checked)}
                disabled={generating || beatCount < 2}
              />
              Snap cuts to beats
              {beatCount < 2
                ? ' (needs beatTimestamps on a source clip)'
                : beatRef?.bpmEstimate
                  ? ` (${beatRef.bpmEstimate.toFixed(0)} BPM)`
                  : ` (${beatCount} beats)`}
            </label>
          </fieldset>

          {estimate && (
            <p className="intercut-estimate">
              {estimate.sliceCount} slice{estimate.sliceCount === 1 ? '' : 's'} ·{' '}
              {estimate.outputDurationSec.toFixed(2)}s ·{' '}
              re-encode
              {estimate.needsNormalization ? ' · sources will be normalized' : ''}
            </p>
          )}
          {estimate?.shortageMessage && (
            <p className="inspector-warning">{estimate.shortageMessage}</p>
          )}
          {hasDuplicateSources && (
            <p className="inspector-warning">Pick different clips for each source.</p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={generating}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!canGenerate}
            onClick={() => {
              if (!clipA || !clipB) return;
              void onGenerate({
                clipA,
                clipB,
                clipC: clipC ?? undefined,
                automation: {
                  totalDurationSec:
                    consumeMode === 'entireSources' ? 0 : totalDurationSec,
                  startFrequencyHz,
                  endFrequencyHz,
                  easing: easingFromName(easingName),
                },
                audioPolicy,
                snapCutsToBeats,
                forceFinalClip,
                tailDurationSec: consumeMode === 'entireSources' ? 0 : tailDurationSec,
                consumeMode,
                sourceClock,
              });
            }}
          >
            {generating ? 'Generating…' : 'Create intercut'}
          </button>
        </div>
      </div>
    </div>
  );
}
