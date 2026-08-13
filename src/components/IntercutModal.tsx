import { useEffect, useMemo, useState } from 'react';
import type { Clip } from '../types';
import { EASING_PRESETS, type KeyframeEasing } from '../utils/keyframes';
import {
  estimateIntercut,
  type IntercutAudioPolicy,
  type IntercutGeneratorConfig,
} from '../ffmpeg/intercutGenerator';
import { hzToSecondsPerCut, secondsPerCutToHz } from '../utils/intercut';
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
  { id: 'easeIn', label: 'Ease in' },
  { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Ease in-out' },
];

function easingFromName(name: EasingName): KeyframeEasing | undefined {
  if (name === 'linear') return { type: 'linear' };
  return EASING_PRESETS[name];
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
  const [totalDurationSec, setTotalDurationSec] = useState(5);
  const [startFrequencyHz, setStartFrequencyHz] = useState(0.5);
  const [endFrequencyHz, setEndFrequencyHz] = useState(12);
  const [frequencyUnit, setFrequencyUnit] = useState<FrequencyUnit>('hz');
  const [easingName, setEasingName] = useState<EasingName>('easeIn');
  const [audioPolicy, setAudioPolicy] = useState<IntercutAudioPolicy>('both');
  const [snapCutsToBeats, setSnapCutsToBeats] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const pair = defaultIntercutPair(clips, clipGroups, selectedClipId);
    setClipAId(pair.clipAId ?? '');
    setClipBId(pair.clipBId ?? '');
  }, [isOpen, clips, clipGroups, selectedClipId]);

  const clipA = videoClips.find((c) => c.id === clipAId) ?? null;
  const clipB = videoClips.find((c) => c.id === clipBId) ?? null;

  const estimate = useMemo(() => {
    if (!clipA || !clipB || clipA.id === clipB.id) return null;
    return estimateIntercut({
      clipA,
      clipB,
      automation: {
        totalDurationSec,
        startFrequencyHz,
        endFrequencyHz,
        easing: easingFromName(easingName),
      },
      audioPolicy,
      snapCutsToBeats,
    });
  }, [
    clipA,
    clipB,
    totalDurationSec,
    startFrequencyHz,
    endFrequencyHz,
    easingName,
    audioPolicy,
    snapCutsToBeats,
  ]);

  const beatRef: Clip | null = clipA?.beatTimestamps?.length
    ? clipA
    : clipB?.beatTimestamps?.length
      ? clipB
      : null;
  const beatCount = beatRef?.beatTimestamps?.length ?? 0;

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
    clipA.id !== clipB.id &&
    totalDurationSec > 0 &&
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
            Alternate two clips at a rising cut rate (slow swaps → strobe). The
            result is a new MP4 in the library — no timeline slicing.
          </p>

          <label className="intercut-field">
            Clip A
            <select
              value={clipAId}
              onChange={(e) => setClipAId(e.target.value)}
              disabled={generating}
            >
              <option value="">Select clip…</option>
              {videoClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>

          <label className="intercut-field">
            Clip B
            <select
              value={clipBId}
              onChange={(e) => setClipBId(e.target.value)}
              disabled={generating}
            >
              <option value="">Select clip…</option>
              {videoClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>

          <label className="intercut-field">
            Total duration (seconds)
            <input
              type="number"
              min={0.2}
              step={0.1}
              value={totalDurationSec}
              onChange={(e) => setTotalDurationSec(Number(e.target.value))}
              disabled={generating}
            />
          </label>

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
            <label className="intercut-field">
              Start {frequencyUnit === 'hz' ? '(Hz)' : '(sec/cut)'}
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
              End {frequencyUnit === 'hz' ? '(Hz)' : '(sec/cut)'}
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={Number(endDisplay.toFixed(3))}
                onChange={(e) => setEndFromDisplay(Number(e.target.value))}
                disabled={generating}
              />
            </label>
          </fieldset>

          <label className="intercut-field">
            Easing
            <select
              value={easingName}
              onChange={(e) => setEasingName(e.target.value as EasingName)}
              disabled={generating}
            >
              {EASING_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="intercut-field">
            Audio
            <select
              value={audioPolicy}
              onChange={(e) => setAudioPolicy(e.target.value as IntercutAudioPolicy)}
              disabled={generating}
            >
              <option value="both">Intercut both</option>
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
              ? ' (needs beatTimestamps on A or B)'
              : beatRef?.bpmEstimate
                ? ` (${beatRef.bpmEstimate.toFixed(0)} BPM)`
                : ` (${beatCount} beats)`}
          </label>

          {estimate && (
            <p className="intercut-estimate">
              {estimate.sliceCount} slice{estimate.sliceCount === 1 ? '' : 's'} ·{' '}
              {estimate.outputDurationSec.toFixed(2)}s ·{' '}
              {estimate.usedStreamCopy
                ? 'stream copy (slices ≥ 0.5s)'
                : 're-encode (strobe / short slices)'}
              {estimate.needsNormalization ? ' · sources will be normalized' : ''}
            </p>
          )}
          {estimate?.shortageMessage && (
            <p className="inspector-warning">{estimate.shortageMessage}</p>
          )}
          {clipA && clipB && clipA.id === clipB.id && (
            <p className="inspector-warning">Pick two different clips.</p>
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
                automation: {
                  totalDurationSec,
                  startFrequencyHz,
                  endFrequencyHz,
                  easing: easingFromName(easingName),
                },
                audioPolicy,
                snapCutsToBeats,
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
