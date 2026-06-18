interface Props {
  isOpen: boolean;
  savedAt: Date;
  clipCount: number;
  textOverlayCount: number;
  embeddedClipCount: number;
  referenceOnlyClipCount: number;
  unrecoverableLocalClipCount: number;
  isRecovering?: boolean;
  onRecover: () => void;
  onDiscard: () => void;
}

function formatSavedAt(date: Date): string {
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function RecoveryModal({
  isOpen,
  savedAt,
  clipCount,
  textOverlayCount,
  embeddedClipCount,
  referenceOnlyClipCount,
  unrecoverableLocalClipCount,
  isRecovering = false,
  onRecover,
  onDiscard,
}: Props) {
  if (!isOpen) return null;

  const recoverableMediaCount = embeddedClipCount + referenceOnlyClipCount;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isRecovering) onDiscard();
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="recovery-title">Recover unsaved work?</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onDiscard}
            disabled={isRecovering}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p>
            clip_stacker found an autosaved session from{' '}
            <strong>{formatSavedAt(savedAt)}</strong>.
          </p>
          <ul>
            <li>
              <strong>{clipCount}</strong> clip{clipCount === 1 ? '' : 's'}
            </li>
            {textOverlayCount > 0 && (
              <li>
                <strong>{textOverlayCount}</strong> text overlay
                {textOverlayCount === 1 ? '' : 's'}
              </li>
            )}
            {recoverableMediaCount > 0 && (
              <li>
                Media recovery available for <strong>{recoverableMediaCount}</strong>{' '}
                clip{recoverableMediaCount === 1 ? '' : 's'}
                {embeddedClipCount > 0 ? ` (${embeddedClipCount} embedded locally)` : ''}
                {referenceOnlyClipCount > 0
                  ? ` (${referenceOnlyClipCount} via remote URL)`
                  : ''}
              </li>
            )}
          </ul>
          {unrecoverableLocalClipCount > 0 && (
            <p className="recovery-warning">
              ⚠ {unrecoverableLocalClipCount} local clip
              {unrecoverableLocalClipCount === 1 ? '' : 's'} could not be embedded due to
              browser storage limits. Those clips will be skipped unless you re-import the
              original files after recovery.
            </p>
          )}
          <p>
            Recover to restore your timeline edits, or start fresh and discard the autosave.
          </p>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            onClick={onDiscard}
            className="btn-secondary"
            disabled={isRecovering}
          >
            Start fresh
          </button>
          <button
            type="button"
            onClick={onRecover}
            className="btn-primary"
            disabled={isRecovering}
          >
            {isRecovering ? 'Recovering…' : 'Recover session'}
          </button>
        </div>
      </div>
    </div>
  );
}
