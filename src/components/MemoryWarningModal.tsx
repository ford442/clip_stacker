import { formatBytes, estimateRenderMemoryUsage } from "../utils/memory";
import type { Clip } from "../types";

interface Props {
  isOpen: boolean;
  clips: Clip[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function MemoryWarningModal({
  isOpen,
  clips,
  onConfirm,
  onCancel,
}: Props) {
  if (!isOpen) return null;

  const estimatedMemory = estimateRenderMemoryUsage(clips);
  const estimatedStr = formatBytes(estimatedMemory);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-warning-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="memory-warning-title">⚠️ High Memory Warning</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p>
            This render may use approximately <strong>{estimatedStr}</strong> of
            memory, which could be very close to your browser's limits.
          </p>
          <p>
            If your browser runs out of memory, the render will fail and you may
            lose work.
          </p>
          <p>
            <strong>To reduce memory usage:</strong>
          </p>
          <ul>
            <li>Use fewer clips</li>
            <li>Use shorter clip durations</li>
            <li>Reduce output resolution or quality settings</li>
            <li>Close other browser tabs to free up memory</li>
          </ul>
          <p>Do you want to continue with the render anyway?</p>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="btn-primary">
            Continue Rendering
          </button>
        </div>
      </div>
    </div>
  );
}
