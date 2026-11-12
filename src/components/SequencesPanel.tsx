import { memo, useMemo, useState } from 'react';
import {
  editorActions,
  useEditorSequences,
  useEditorTextOverlays,
  useEditorTimelineClips,
  useSelectedClipId,
  useSequencePath,
} from '../store';
import { renderJobStore } from '../store/renderJobStore';
import { sequenceWouldCycle } from '../timeline/sequenceResolve';
import { sequenceBodyDuration } from '../timeline/sequenceModel';

function report(refused: string | null, done: string): void {
  renderJobStore.getState().setStatus(refused ?? done);
}

/**
 * Library section for nested sequences (compound clips): nest clips and
 * titles of the open timeline into a new sequence, create an empty one, and
 * per sequence open / place / rename / delete. Double-clicking a sequence
 * clip on the timeline opens it too.
 */
function SequencesPanelImpl() {
  const sequences = useEditorSequences();
  const path = useSequencePath();
  const timelineClips = useEditorTimelineClips();
  const textOverlays = useEditorTextOverlays();
  const selectedClipId = useSelectedClipId();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedTitles, setPickedTitles] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const activeId = path[path.length - 1] ?? null;
  const candidates = useMemo(
    () => timelineClips.filter((clip) => clip.kind === 'video' || clip.kind === 'audio'),
    [timelineClips],
  );
  // Until something is ticked, the selected clip is the default pick.
  const chosen = picked.filter((id) => candidates.some((clip) => clip.id === id));
  const effectivePick =
    chosen.length > 0 || pickedTitles.length > 0
      ? chosen
      : selectedClipId && candidates.some((clip) => clip.id === selectedClipId)
        ? [selectedClipId]
        : [];
  const chosenTitles = pickedTitles.filter((id) => textOverlays.some((overlay) => overlay.id === id));

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((other) => other !== id) : [...list, id];

  const handleNest = () => {
    const refused = editorActions.nestClips({ clipIds: effectivePick, textOverlayIds: chosenTitles });
    report(refused, 'Nested into a new sequence — double-click it on the timeline to edit inside.');
    if (!refused) {
      setPicked([]);
      setPickedTitles([]);
    }
  };

  const commitRename = () => {
    if (!renaming) return;
    const refused = editorActions.renameSequence(renaming.id, renaming.name);
    if (refused) report(refused, '');
    setRenaming(null);
  };

  return (
    <div className="sequences-panel">
      <button
        type="button"
        className="btn-secondary sequences-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        title="Nested sequences: group clips and titles into one clip you can edit inside"
      >
        ▣ Sequences{sequences.length > 0 ? ` (${sequences.length})` : ''}
      </button>

      {open && (
        <div className="sequences-body">
          <fieldset className="sequences-pick">
            <legend>Nest clips</legend>
            {candidates.length === 0 && <p className="muted sequences-hint">No clips on this timeline yet.</p>}
            {candidates.map((clip) => (
              <label key={clip.id} className="sequences-pick-item">
                <input
                  type="checkbox"
                  checked={effectivePick.includes(clip.id)}
                  onChange={() => setPicked(toggle(effectivePick, clip.id))}
                />
                {clip.title}
                <span className="muted">
                  {(clip.layerIndex ?? 0) > 0 ? ` · L${clip.layerIndex}` : clip.kind === 'audio' ? ' · audio' : ''}
                </span>
              </label>
            ))}
            {textOverlays.map((overlay) => (
              <label key={overlay.id} className="sequences-pick-item">
                <input
                  type="checkbox"
                  checked={chosenTitles.includes(overlay.id)}
                  onChange={() => setPickedTitles(toggle(chosenTitles, overlay.id))}
                />
                T · {overlay.text.slice(0, 28) || 'Title'}
              </label>
            ))}
          </fieldset>
          <div className="sequences-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={effectivePick.length === 0}
              onClick={handleNest}
              title="Main-lane clips must be next to each other; overlays and titles may be anywhere"
            >
              Nest selected
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                editorActions.createSequence();
                report(null, 'New empty sequence opened — add clips, then Exit to parent and Place it.');
              }}
            >
              New sequence
            </button>
          </div>

          {sequences.length > 0 && (
            <ul className="sequences-list">
              {sequences.map((seq) => {
                const isOpen = path.includes(seq.id);
                const cycles = seq.id === activeId || sequenceWouldCycle(sequences, activeId, seq.id);
                return (
                  <li key={seq.id} className="sequences-item">
                    {renaming?.id === seq.id ? (
                      <input
                        className="sequences-rename"
                        aria-label="Sequence name"
                        value={renaming.name}
                        autoFocus
                        onChange={(e) => setRenaming({ id: seq.id, name: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="sequences-name" title={`${seq.clips.length} clip(s)`}>
                        {seq.name}
                        <span className="muted"> · {sequenceBodyDuration(seq).toFixed(1)}s</span>
                      </span>
                    )}
                    <span className="sequences-item-btns">
                      <button
                        type="button"
                        disabled={isOpen}
                        onClick={() => report(editorActions.enterSequence(seq.id), `Editing ${seq.name}.`)}
                        title="Open this sequence for editing"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        disabled={cycles}
                        onClick={() => report(editorActions.placeSequence(seq.id), `Placed ${seq.name} at the end of the main lane.`)}
                        title={cycles ? 'A sequence cannot contain itself' : 'Add it to the end of the open timeline'}
                      >
                        Place
                      </button>
                      <button type="button" onClick={() => setRenaming({ id: seq.id, name: seq.name })}>
                        Rename
                      </button>
                      <button
                        type="button"
                        className="project-delete-btn"
                        disabled={isOpen}
                        onClick={() => report(editorActions.deleteSequence(seq.id), `Deleted ${seq.name}.`)}
                        title="Delete (only when no timeline uses it)"
                        aria-label={`Delete ${seq.name}`}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export const SequencesPanel = memo(SequencesPanelImpl);
