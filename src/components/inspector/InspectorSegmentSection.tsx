import { useMemo, useState } from 'react';
import type { Clip, ProcessingBackendId, SegmentOperation } from '../../types';
import { useStorageEndpoint } from '../../store';
import { useSegmentWorkflow } from '../../hooks/useSegmentWorkflow';
import { chooseExtractRoute, SegmentError } from '../../utils/segments/extractSegment';
import { backendInfo, OPERATION_LABELS, PROCESSING_BACKENDS } from '../../utils/segments/processSegment';
import { MIN_CLIP_DURATION } from '../../utils/media';
import { SegmentSessionView } from '../segments/SegmentSessionView';
import { InspectorSection } from './InspectorSection';

const trimWindow = (clip: Clip) => ({
  start: clip.trimStart,
  end: Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration,
});

/** Why `[start, end]` cannot be a segment of `clip`, or null. */
export function segmentRangeProblem(clip: Clip, start: number, end: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter a start and end time.';
  if (start < 0) return 'Start cannot be negative.';
  if (end - start < MIN_CLIP_DURATION) return `A segment must be at least ${MIN_CLIP_DURATION}s long.`;
  if (end > clip.duration + 0.01) return `The clip is only ${clip.duration.toFixed(2)}s long.`;
  const window = trimWindow(clip);
  if (start < window.start - 0.001 || end > window.end + 0.001) {
    return 'The segment has to stay inside the clip’s trimmed range.';
  }
  return null;
}

/**
 * Keyed by clip and trim window: a different clip, or a re-trim, starts the
 * inputs from the trimmed range again.
 */
export function InspectorSegmentSection({ clip }: { clip: Clip }) {
  const { start, end } = trimWindow(clip);
  return <SegmentForm key={`${clip.id}:${start}:${end}`} clip={clip} />;
}

function SegmentForm({ clip }: { clip: Clip }) {
  const workflow = useSegmentWorkflow();
  const endpoint = useStorageEndpoint();
  const window = trimWindow(clip);
  const [startText, setStartText] = useState(String(window.start));
  const [endText, setEndText] = useState(String(window.end));
  const [backend, setBackend] = useState<ProcessingBackendId>('browser');
  const [operation, setOperation] = useState<SegmentOperation>('extract');

  const start = Number(startText);
  const end = Number(endText);
  const problem = segmentRangeProblem(clip, start, end);
  const source = { kind: 'local', clipId: clip.id } as const;

  const { session } = workflow;
  const mine = session?.request.source.kind === 'local' && session.request.source.clipId === clip.id;
  const busy = session?.phase === 'working';
  const blockedByOther = session !== null && !mine && busy;

  // Surface "too large for the browser" before the user clicks.
  const routeWarning = useMemo(() => {
    try {
      chooseExtractRoute({
        kind: 'local',
        sizeBytes: clip.file.size,
        hasRemoteCopy: Boolean(clip.remoteSourceUrl),
        contaboConfigured: endpoint.trim().length > 0,
      });
      return null;
    } catch (error) {
      return error instanceof SegmentError ? error.message : null;
    }
  }, [clip.file.size, clip.remoteSourceUrl, endpoint]);

  const info = backendInfo(backend);
  const disabled = Boolean(problem) || busy || blockedByOther;
  const baseName = clip.title.replace(/\.[^.]+$/, '') || 'clip';

  return (
    <InspectorSection id="clip.segment" title="Segment extract / replace" defaultOpen={false}>
      <p className="inspector-hint">
        Cut part of this clip, process it, then swap it back at the same spot. The result must be exactly as long as
        the segment, so nothing after it moves and a later lossless join still lines up.
      </p>
      <div className="segment-range">
        <label>
          Start (s)
          <input type="number" min="0" step="0.01" value={startText} onChange={(e) => setStartText(e.target.value)} />
        </label>
        <label>
          End (s)
          <input type="number" min="0" step="0.01" value={endText} onChange={(e) => setEndText(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setStartText(String(window.start));
            setEndText(String(window.end));
          }}
          title="Use the clip’s whole trimmed range"
        >
          Use trim range
        </button>
      </div>
      {problem && <p className="inspector-warning">{problem}</p>}
      {!problem && routeWarning && <p className="inspector-warning">{routeWarning}</p>}

      <div className="segment-actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          onClick={() => void workflow.extract(source, { startSec: start, endSec: end }, `${baseName}_${start.toFixed(2)}-${end.toFixed(2)}.mp4`)}
          title="Cut the segment: in the browser for small clips, on the Contabo worker for large ones"
        >
          Extract segment…
        </button>
      </div>

      <div className="segment-processing">
        <label>
          Backend
          <select
            value={backend}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as ProcessingBackendId;
              setBackend(next);
              const ops = backendInfo(next).operations;
              if (!ops.includes(operation)) setOperation(ops[0]);
            }}
          >
            {PROCESSING_BACKENDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Operation
          <select value={operation} disabled={busy} onChange={(e) => setOperation(e.target.value as SegmentOperation)}>
            {info.operations.map((op) => (
              <option key={op} value={op}>
                {OPERATION_LABELS[op]}
              </option>
            ))}
          </select>
        </label>
        <p className="inspector-hint">{info.hint}</p>
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          onClick={() =>
            void workflow.sendToProcessing(
              source,
              { startSec: start, endSec: end },
              backend,
              operation,
              `${baseName}_${start.toFixed(2)}-${end.toFixed(2)}_${operation}.mp4`,
            )
          }
        >
          Send to processing
        </button>
      </div>

      {mine && session && (
        <SegmentSessionView
          session={session}
          onCancel={workflow.cancel}
          onDiscard={workflow.discard}
          onImport={(file) => void workflow.importResult(file)}
          downloadName={`${baseName}_${session.request.startSec.toFixed(2)}-${session.request.endSec.toFixed(2)}.mp4`}
          action={
            <button type="button" className="btn-primary" onClick={() => void workflow.replace()}>
              Replace with result
            </button>
          }
        />
      )}
    </InspectorSection>
  );
}
