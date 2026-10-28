import type { ReactNode } from 'react';
import type { SegmentSession } from '../../store/segmentStore';

interface SegmentSessionViewProps {
  session: SegmentSession;
  onCancel: () => void;
  onDiscard: () => void;
  /** Colab round trip: the processed file the user brings back. */
  onImport: (file: File) => void;
  /** The primary action for a ready result: "Replace with result", "Add to timeline"… */
  action?: ReactNode;
  downloadName: string;
}

/** Progress, result and follow-up actions for the segment in flight. */
export function SegmentSessionView({ session, onCancel, onDiscard, onImport, action, downloadName }: SegmentSessionViewProps) {
  const { phase, message, progress, result, awaitingImport } = session;
  return (
    <div className="segment-session" data-phase={phase}>
      <p
        className={phase === 'error' ? 'storage-error' : 'inspector-hint'}
        role={phase === 'error' ? 'alert' : 'status'}
      >
        {message}
      </p>
      {phase === 'working' && (
        <div className="segment-session-working">
          {progress !== undefined && <progress max={1} value={progress} aria-label="Job progress" />}
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      {result && phase !== 'working' && (
        <div className="segment-session-result">
          <a className="button-like" href={result.url} download={downloadName}>
            Download segment
          </a>
          {awaitingImport && (
            <label className="button-like">
              Import processed result…
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImport(file);
                  e.target.value = '';
                }}
              />
            </label>
          )}
          {!awaitingImport && action}
          <button type="button" className="btn-secondary" onClick={onDiscard}>
            Discard
          </button>
        </div>
      )}
      {phase === 'error' && (
        <button type="button" className="btn-secondary" onClick={onDiscard}>
          Dismiss
        </button>
      )}
    </div>
  );
}
