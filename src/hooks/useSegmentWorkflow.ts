import { useCallback } from 'react';
import type { ProcessingBackendId, SegmentOperation, SegmentRequest } from '../types';
import { segmentActions, segmentStore, useSegmentSession, type SegmentSession } from '../store/segmentStore';
import { settingsStore } from '../store/settingsStore';
import { editorStore } from '../store/editorStore';
import { projectStore } from '../store/projectStore';
import { ContaboStorageManagerClient } from '../utils/project';
import {
  extractSegment,
  type ExtractedSegment,
  type ExtractOptions,
} from '../utils/segments/extractSegment';
import {
  backendInfo,
  importProcessedSegment,
  OPERATION_LABELS,
  processSegment,
} from '../utils/segments/processSegment';
import { replaceSegment } from '../utils/segments/replaceSegment';
import { createReplaceDeps, createSegmentDeps } from '../utils/segments/segmentDeps';

let controller: AbortController | null = null;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Free what a finished-but-unused result holds: its blob URL and (Contabo) its library file. */
function releaseResult(result: ExtractedSegment | undefined, { keepRemote }: { keepRemote: boolean }): void {
  if (!result) return;
  if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
  if (!keepRemote && result.mediaName && result.backend !== 'browser') {
    const { storageEndpoint, storageAuthToken } = projectStore.getState();
    if (storageEndpoint.trim()) {
      void new ContaboStorageManagerClient(storageEndpoint.trim(), storageAuthToken)
        .deleteMedia(result.mediaName)
        .catch(() => {});
    }
  }
}

interface StartArgs {
  request: SegmentRequest;
  backend: ProcessingBackendId;
  operation: SegmentOperation;
  working: string;
  run: (options: ExtractOptions) => Promise<ExtractedSegment>;
  afterResult?: Partial<SegmentSession>;
}

async function start({ request, backend, operation, working, run, afterResult }: StartArgs) {
  if (segmentStore.getState().session?.phase === 'working') return;
  releaseResult(segmentStore.getState().session?.result, { keepRemote: false });
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  segmentActions.setSession({ request, backend, operation, phase: 'working', message: working });

  try {
    const result = await run({
      signal: mine.signal,
      onStatus: (message) => segmentActions.patchSession({ message }),
      onJob: (job) =>
        segmentActions.patchSession({
          message: `Contabo job: ${job.stage ?? job.status}…`,
          progress: job.progress,
        }),
    });
    segmentActions.patchSession({
      phase: 'ready',
      result,
      progress: undefined,
      message: `Segment ready — ${result.durationSec.toFixed(2)}s (${result.method ?? result.backend}).`,
      ...afterResult,
    });
  } catch (error) {
    if (isAbort(error)) {
      segmentActions.setSession(null);
      settingsStore.getState().setStatus('Segment job cancelled.');
    } else {
      segmentActions.patchSession({ phase: 'error', message: messageOf(error), progress: undefined });
    }
  } finally {
    if (controller === mine) controller = null;
  }
}

export interface SegmentRange {
  startSec: number;
  endSec: number;
}

/**
 * Actions behind the Inspector's segment section and the Drive library rows:
 * extract, send to processing, import a manual result, replace, discard.
 */
export function useSegmentWorkflow() {
  const session = useSegmentSession();

  /** "Extract segment…": a plain cut, routed automatically (browser for small/local, Contabo for large). */
  const extract = useCallback((source: SegmentRequest['source'], range: SegmentRange, outputName?: string) => {
    const request: SegmentRequest = { source, ...range, ...(outputName ? { outputName } : {}) };
    const deps = createSegmentDeps();
    return start({
      request,
      backend: 'browser',
      operation: 'extract',
      working: 'Cutting the segment…',
      run: (options) => extractSegment(request, deps, options),
    });
  }, []);

  /** "Send to processing": run the chosen operation on the chosen backend. */
  const sendToProcessing = useCallback(
    (
      source: SegmentRequest['source'],
      range: SegmentRange,
      backend: ProcessingBackendId,
      operation: SegmentOperation,
      outputName?: string,
    ) => {
      const request: SegmentRequest = { source, ...range, ...(outputName ? { outputName } : {}) };
      const deps = createSegmentDeps();
      if (backend === 'colab') {
        // Manual: cut it, hand over the file, wait for the processed one.
        return start({
          request,
          backend,
          operation,
          working: 'Cutting the segment for Colab…',
          run: (options) => extractSegment(request, deps, options),
          afterResult: {
            awaitingImport: true,
            message: `Segment ready. Download it, run ${OPERATION_LABELS[operation]} in your notebook, then import the result.`,
          },
        });
      }
      return start({
        request,
        backend,
        operation,
        working: `Sending to ${backendInfo(backend).label}…`,
        run: (options) => processSegment(request, deps, { ...options, backend, operation }),
      });
    },
    [],
  );

  /** Colab round trip: accept the processed file, but only at the requested length. */
  const importResult = useCallback(async (file: File) => {
    const current = segmentStore.getState().session;
    if (!current) return;
    try {
      const imported = await importProcessedSegment(file, current.request, createSegmentDeps());
      releaseResult(current.result, { keepRemote: false });
      segmentActions.patchSession({
        phase: 'ready',
        result: imported,
        awaitingImport: false,
        message: `Imported “${file.name}” — ${imported.durationSec.toFixed(2)}s.`,
      });
    } catch (error) {
      segmentActions.patchSession({ message: messageOf(error) });
    }
  }, []);

  /** "Replace with result": swap the processed segment in, in place. */
  const replace = useCallback(async () => {
    const current = segmentStore.getState().session;
    if (!current?.result || current.request.source.kind !== 'local') return;
    const { clipId } = current.request.source;
    const { setStatus, setOutputUrl } = settingsStore.getState();
    segmentActions.patchSession({ phase: 'working', message: 'Replacing the segment…' });
    const outcome = await replaceSegment(clipId, current.request, current.result, createReplaceDeps());
    if (outcome.ok) {
      releaseResult(current.result, { keepRemote: true });
      segmentActions.setSession(null);
      setOutputUrl(null);
      setStatus(outcome.message);
    } else {
      segmentActions.patchSession({ phase: 'ready', message: outcome.message });
    }
  }, []);

  const cancel = useCallback(() => controller?.abort(), []);

  const discard = useCallback(() => {
    controller?.abort();
    releaseResult(segmentStore.getState().session?.result, { keepRemote: false });
    segmentActions.setSession(null);
  }, []);

  return { session, extract, sendToProcessing, importResult, replace, cancel, discard };
}

/** Selected clip's trim window, the default segment. */
export function defaultSegmentRange(clipId: string): SegmentRange | null {
  const clip = editorStore.getState().clips.find((c) => c.id === clipId);
  if (!clip) return null;
  return {
    startSec: clip.trimStart,
    endSec: Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration,
  };
}
