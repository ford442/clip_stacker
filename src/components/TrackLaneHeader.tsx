import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../types';
import { editorActions, useEditorTrack } from '../store';
import {
  canRemoveTrack,
  DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
} from '../utils/trackModel';
import { editorStore } from '../store/editorStore';

/**
 * Lane chrome for one timeline track (#168 Phase A).
 *
 * Track state belongs on the lane header, not in another Inspector tab, so this
 * owns the lane's name, its **M**(ute) / **L**(ock) toggles, the remove button
 * and the drag-to-resize handle. Everything routes through `editorActions`,
 * which delegates to the pure helpers in `utils/trackModel.ts` — this component
 * never mutates a `Track` itself.
 */

const KIND_LABEL: Record<Track['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
  text: 'Titles',
};

interface Props {
  trackId: string;
  /** Hidden for the base video lane, which cannot be removed. */
  showRemove?: boolean;
}

function TrackLaneHeaderImpl({ trackId, showRemove = true }: Props) {
  const track = useEditorTrack(trackId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const label = track?.label ?? (track ? KIND_LABEL[track.kind] : '');

  const onPointerMove = useCallback((event: PointerEvent) => {
    const state = resizeRef.current;
    if (!state) return;
    editorActions.setTrackHeight(trackId, state.startHeight + (event.clientY - state.startY));
  }, [trackId]);

  const onPointerUp = useCallback(() => {
    resizeRef.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  if (!track) return null;

  const removable = showRemove && canRemoveTrack(editorStore.getState().tracks, trackId);

  const commitRename = () => {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== label) editorActions.renameTrack(trackId, draft);
  };

  return (
    <div
      className={`timeline-track-label timeline-lane-header${
        track.locked ? ' timeline-lane-header--locked' : ''
      }${track.muted ? ' timeline-lane-header--muted' : ''}`}
      data-lane-kind={track.kind}
    >
      {renaming ? (
        <input
          className="timeline-lane-rename"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          aria-label={`Rename ${label}`}
        />
      ) : (
        <button
          type="button"
          className="timeline-lane-name"
          title={`${label} — double-click to rename`}
          onDoubleClick={() => {
            setDraft(label);
            setRenaming(true);
          }}
        >
          {label}
        </button>
      )}

      <span className="timeline-lane-toggles" role="group" aria-label={`${label} track controls`}>
        <button
          type="button"
          className={`timeline-lane-toggle${track.muted ? ' is-active' : ''}`}
          aria-pressed={track.muted ?? false}
          onClick={() => editorActions.toggleTrackMuted(trackId)}
          title={
            track.muted
              ? `${label} is muted — its audio is dropped from preview and export`
              : `Mute ${label} (silences this lane in preview and export)`
          }
        >
          M
        </button>
        <button
          type="button"
          className={`timeline-lane-toggle${track.locked ? ' is-active' : ''}`}
          aria-pressed={track.locked ?? false}
          onClick={() => editorActions.toggleTrackLocked(trackId)}
          title={
            track.locked
              ? `${label} is locked — trim, drag and delete are blocked`
              : `Lock ${label} (blocks trim, drag and delete on its clips)`
          }
        >
          L
        </button>
        {removable && (
          <button
            type="button"
            className="timeline-lane-toggle timeline-lane-remove"
            onClick={() => editorActions.removeTrack(trackId)}
            title={`Remove ${label}`}
            aria-label={`Remove ${label}`}
          >
            ×
          </button>
        )}
      </span>

      <span
        className="timeline-lane-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${label}`}
        title="Drag to change lane height"
        onPointerDown={(e) => {
          e.preventDefault();
          resizeRef.current = {
            startY: e.clientY,
            startHeight: track.height ?? DEFAULT_TRACK_HEIGHT,
          };
        }}
        onKeyDown={(e) => {
          const current = track.height ?? DEFAULT_TRACK_HEIGHT;
          if (e.key === 'ArrowUp') editorActions.setTrackHeight(trackId, current - 8);
          if (e.key === 'ArrowDown') editorActions.setTrackHeight(trackId, current + 8);
        }}
        tabIndex={0}
        aria-valuenow={track.height ?? DEFAULT_TRACK_HEIGHT}
        aria-valuemin={MIN_TRACK_HEIGHT}
        aria-valuemax={MAX_TRACK_HEIGHT}
      />
    </div>
  );
}

export const TrackLaneHeader = memo(TrackLaneHeaderImpl);
