import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { audioFxStore, useAudioFxMeters, useLaneGainReduction } from '../../store/audioFxStore';
import { editorActions, useEditorMasterBus, useEditorTrack, useEditorTracks } from '../../store';
import { laneDuckActive } from '../../utils/audioBus';
import { BusFxChainEditor } from './BusFxChainEditor';
import { LaneDuckPicker } from './LaneDuckPicker';
import { GainReductionMeter } from './GainReductionMeter';
import { AudioFxStatusNote } from './AudioFxStatusNote';

const KIND_LABEL = { video: 'Video', audio: 'Audio', text: 'Titles' } as const;

/** Overlay dialog shell: Escape and a backdrop click close it; rendered on `document.body`. */
function DialogFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // The gain-reduction readouts need the meter running while the dialog is open.
  useEffect(() => audioFxStore.getState().requestMeter(), []);
  return createPortal(
    <div
      className="bus-fx-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="bus-fx-popup">
        <div className="bus-fx-popup-header">
          <h3>{title}</h3>
          <button type="button" className="btn-secondary kf-btn" ref={closeRef} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A lane bus: its insert chain, its ducking, and its live gain reduction. */
export function LaneFxDialog({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const track = useEditorTrack(trackId);
  const tracks = useEditorTracks();
  const gainReduction = useLaneGainReduction(trackId);
  if (!track) return null;
  const label = track.label ?? KIND_LABEL[track.kind];
  const locked = Boolean(track.locked);
  const candidates = tracks
    .filter((t) => t.id !== trackId && t.kind !== 'text')
    .map((t) => ({ id: t.id, label: t.label ?? KIND_LABEL[t.kind] }));
  return (
    <DialogFrame title={`${label}: lane bus`} onClose={onClose}>
      {locked && <p className="inspector-warning">{label} is locked. Unlock it (L) to edit its effects.</p>}
      <AudioFxStatusNote />
      <GainReductionMeter db={gainReduction} label={label} />
      <section className="bus-fx-section">
        <h4>Insert chain</h4>
        <p className="inspector-hint">
          Runs on everything on this lane, summed, after each clip&apos;s own volume, fades, pan and inserts.
        </p>
        <BusFxChainEditor
          fx={track.audioFx}
          label={label}
          disabled={locked}
          onChange={(next, coalesce) => editorActions.setTrackAudioFx(trackId, next, coalesce ? `busfx:${trackId}` : undefined)}
        />
      </section>
      <section className="bus-fx-section">
        <h4>Ducking</h4>
        <LaneDuckPicker
          label={label}
          isAudioLane={track.kind === 'audio'}
          duck={track.duck}
          candidates={candidates}
          disabled={locked}
          onChange={(next, coalesce) => editorActions.setTrackDuck(trackId, next, coalesce ? `busduck:${trackId}` : undefined)}
        />
      </section>
    </DialogFrame>
  );
}

/** The master bus: FX after the lanes are summed, before the export loudness stage. */
export function MasterBusDialog({ onClose }: { onClose: () => void }) {
  const masterBus = useEditorMasterBus();
  const meters = useAudioFxMeters();
  const ducks = useEditorTracks().filter((t) => laneDuckActive(t.duck)).length;
  return (
    <DialogFrame title="Master bus" onClose={onClose}>
      <AudioFxStatusNote />
      <GainReductionMeter db={meters?.masterGainReduction ?? 0} label="Master" />
      <section className="bus-fx-section">
        <h4>Master chain</h4>
        <p className="inspector-hint">
          Runs on the sum of every lane{ducks > 0 ? ' (after the lane ducks)' : ''}. The export loudness target
          (Export → Loudness) comes after it.
        </p>
        <BusFxChainEditor
          fx={masterBus?.fx}
          label="Master"
          onChange={(fx, coalesce) =>
            editorActions.setMasterBus({ ...(masterBus ?? {}), fx }, coalesce ? 'busfx:master' : undefined)
          }
        />
      </section>
    </DialogFrame>
  );
}
