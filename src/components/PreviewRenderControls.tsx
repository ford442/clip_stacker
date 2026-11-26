import { markedRange, previewCacheStore, usePreviewCacheStore } from '../store/previewCacheStore';
import { useRenderCacheStore } from '../store/renderCacheStore';
import { playbackStore } from '../store/playbackStore';

/** Mark In / Out at the playhead, and render the range into the RAM preview. */
export function PreviewRenderControls() {
  const enabled = useRenderCacheStore((s) => s.settings.previewCache);
  // A boolean, not the range: `markedRange` builds a new tuple per call, and a
  // selector that never returns the same value re-renders forever (React #185).
  const hasRange = usePreviewCacheStore((s) => markedRange(s) !== null);
  const job = usePreviewCacheStore((s) => s.job);
  const actions = previewCacheStore.getState();
  const playhead = () => playbackStore.getState().playheadTime ?? 0;
  return (
    <div className="timeline-tools-group" role="group" aria-label="Preview render">
      <button type="button" className="timeline-tool-btn" title="Mark In at the playhead (Shift+I)" aria-label="Mark In" onClick={() => actions.setInPoint(playhead())}>
        In
      </button>
      <button type="button" className="timeline-tool-btn" title="Mark Out at the playhead (Shift+O)" aria-label="Mark Out" onClick={() => actions.setOutPoint(playhead())}>
        Out
      </button>
      {job ? (
        <button type="button" className="timeline-tool-btn is-active" title="Stop rendering" aria-label="Stop preview render" onClick={() => actions.requestCancel()}>
          ⏹ {job.done}/{job.total}
        </button>
      ) : (
        <button
          type="button"
          className="timeline-tool-btn"
          disabled={!enabled || !hasRange}
          title={
            enabled
              ? 'Render the In → Out range into the preview cache so it plays back in real time (Shift+Enter)'
              : 'Turn the preview cache on (Export → Render cache) to render previews'
          }
          aria-label="Render In to Out"
          onClick={() => actions.requestRender()}
        >
          ⏺ Render In→Out
        </button>
      )}
    </div>
  );
}
