import { memo, useMemo, useState } from 'react';
import {
  editorActions,
  editorStore,
  useEditorClips,
  useEditorMasterAudio,
  useEditorTracks,
} from '../store';
import { settingsStore } from '../store/settingsStore';
import {
  autoCutFromReference,
  resolveClipAutoCutReference,
  resolveMasterAutoCutReference,
  type AutoCutReference,
} from '../utils/autoEdit';
import { beatsInTrimWindow } from '../utils/beatMarkers';

/**
 * "Auto-cut to music" (#168 Phase D).
 *
 * Wires `utils/autoEdit.ts` — which had no callers — to the Library panel: pick
 * a tempo reference (the master audio lane, or any clip with detected beats),
 * tick the B-roll to cut with, and the main video lane is rebuilt so every cut
 * lands on a beat. One `pushHistory` covers the whole rearrangement, so a single
 * undo restores the previous tracks, clips and transitions.
 */

const MASTER_REFERENCE_ID = 'master';

function setStatus(message: string): void {
  settingsStore.getState().setStatus(message);
}

function AutoCutPanelImpl() {
  const clips = useEditorClips();
  const tracks = useEditorTracks();
  const masterAudio = useEditorMasterAudio();
  const [open, setOpen] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [brollIds, setBrollIds] = useState<string[]>([]);

  const masterHasBeats = (masterAudio?.beatTimestamps?.length ?? 0) > 1;
  const beatClips = useMemo(
    () => clips.filter((clip) => beatsInTrimWindow(clip).length > 1),
    [clips],
  );
  const brollCandidates = useMemo(
    () => clips.filter((clip) => clip.kind === 'video'),
    [clips],
  );

  const referenceOptions = useMemo(
    () => [
      ...(masterHasBeats
        ? [{ id: MASTER_REFERENCE_ID, label: `Master audio — ${masterAudio!.fileName}` }]
        : []),
      ...beatClips.map((clip) => ({ id: clip.id, label: clip.title })),
    ],
    [masterHasBeats, masterAudio, beatClips],
  );

  const effectiveReferenceId =
    referenceOptions.find((o) => o.id === referenceId)?.id ?? referenceOptions[0]?.id ?? null;

  const selectedBroll = brollIds.filter((id) => brollCandidates.some((c) => c.id === id));

  const disabledReason =
    referenceOptions.length === 0
      ? 'No beats detected yet — load master audio or wait for clip beat analysis.'
      : selectedBroll.length === 0
        ? 'Pick at least one B-roll clip to cut with.'
        : null;

  const toggleBroll = (clipId: string) => {
    setBrollIds((prev) =>
      prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId],
    );
  };

  const handleAutoCut = () => {
    if (!effectiveReferenceId || selectedBroll.length === 0) return;
    const state = editorStore.getState();
    const reference: AutoCutReference | null =
      effectiveReferenceId === MASTER_REFERENCE_ID
        ? resolveMasterAutoCutReference(state.masterAudio)
        : resolveClipAutoCutReference(
            state.tracks,
            state.clips,
            state.transitions,
            effectiveReferenceId,
          );

    if (!reference) {
      setStatus('That reference has no usable beats — nothing to cut to.');
      return;
    }

    const result = autoCutFromReference(
      state.tracks,
      state.clips,
      state.transitions,
      reference,
      selectedBroll,
    );

    const cuts = result.tracks.find((t) => t.kind === 'video')?.items.length ?? 0;
    if (result.clips.length === state.clips.length) {
      setStatus(`Auto-cut made no changes — ${reference.label} has no cuttable beat intervals.`);
      return;
    }

    // One history entry for the whole rearrangement: undo restores the prior
    // tracks, clips and transitions together.
    editorActions.pushHistory();
    editorActions.setClips(result.clips);
    editorActions.setTracks(result.tracks);
    editorActions.setTransitions(result.transitions);
    setStatus(`Auto-cut ${cuts} segments to ${reference.label}. Undo to restore.`);
  };

  if (brollCandidates.length === 0) return null;

  return (
    <div className="autocut-panel">
      <button
        type="button"
        className="btn-secondary autocut-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        title="Rebuild the main video lane so every cut lands on a beat"
      >
        🎵 Auto-cut to music
      </button>

      {open && (
        <div className="autocut-body">
          <label className="autocut-field">
            Tempo reference
            <select
              value={effectiveReferenceId ?? ''}
              disabled={referenceOptions.length === 0}
              onChange={(e) => setReferenceId(e.target.value || null)}
            >
              {referenceOptions.length === 0 && <option value="">No beats detected</option>}
              {referenceOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="autocut-broll">
            <legend>B-roll</legend>
            {brollCandidates.map((clip) => (
              <label key={clip.id} className="autocut-broll-item">
                <input
                  type="checkbox"
                  checked={selectedBroll.includes(clip.id)}
                  onChange={() => toggleBroll(clip.id)}
                />
                {clip.title}
              </label>
            ))}
          </fieldset>

          <button
            type="button"
            className="btn-secondary"
            disabled={disabledReason != null}
            onClick={handleAutoCut}
          >
            Cut to beats
          </button>

          {disabledReason ? (
            <p className="muted autocut-hint" role="status">
              {disabledReason}
            </p>
          ) : (
            <p className="muted autocut-hint">
              Replaces the clips on {tracks.find((t) => t.kind === 'video')?.label ?? 'Video 1'}{' '}
              with beat-length B-roll segments. Undo restores the previous arrangement.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export const AutoCutPanel = memo(AutoCutPanelImpl);
