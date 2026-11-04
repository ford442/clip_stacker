import type { ProcessingBackendId, SegmentOperation, SegmentRequest } from '../../types';
import {
  assertSegmentLength,
  buildJobSource,
  extractSegment,
  runContaboJob,
  SegmentError,
  validateSegmentRange,
  type ExtractedSegment,
  type ExtractOptions,
  type SegmentDeps,
} from './extractSegment';

/** "Send to processing": where a cut segment is processed, and what each place can do. */
export interface ProcessingBackendInfo {
  id: ProcessingBackendId;
  label: string;
  operations: SegmentOperation[];
  hint: string;
}

export const PROCESSING_BACKENDS: ProcessingBackendInfo[] = [
  {
    id: 'browser',
    label: 'Browser FFmpeg',
    operations: ['extract'],
    hint: 'Cuts in this tab with FFmpeg.wasm. For small files; no interpolation.',
  },
  {
    id: 'hf-rife',
    label: 'HF RIFE Space',
    operations: ['rife2', 'rife4'],
    hint: 'Cuts the segment, then interpolates it on the public 1inkusFace/RIFE HuggingFace Space.',
  },
  {
    id: 'colab',
    label: 'Colab (manual)',
    operations: ['rife2', 'rife4'],
    hint: 'Cuts the segment and gives you the file. Process it in your own Colab notebook, then import the result.',
  },
  {
    id: 'contabo',
    label: 'Contabo job',
    operations: ['extract', 'rife2', 'rife4'],
    hint: 'Runs on the Contabo server, which reads Drive and library files directly. Best for large files.',
  },
];

export function backendInfo(id: ProcessingBackendId): ProcessingBackendInfo {
  return PROCESSING_BACKENDS.find((b) => b.id === id) ?? PROCESSING_BACKENDS[0];
}

export const OPERATION_LABELS: Record<SegmentOperation, string> = {
  extract: 'Extract only',
  rife2: 'RIFE 2× smoother',
  rife4: 'RIFE 4× smoother',
};

const multiplierOf = (operation: SegmentOperation): 2 | 4 | null =>
  operation === 'rife2' ? 2 : operation === 'rife4' ? 4 : null;

/** What the HF Space and audio re-mux need beyond SegmentDeps. */
export interface ProcessDeps extends SegmentDeps {
  fetchBlob(url: string): Promise<Blob>;
  rifeOnHuggingFace(blob: Blob, multiplier: 2 | 4, onProgress: (message: string) => void): Promise<Blob>;
  /** Put the segment's own audio under RIFE's silent video, length-pinned to the audio. */
  muxSegmentAudio(video: Blob, segment: File, hasAudio: boolean | undefined, onStatus: (message: string) => void): Promise<Blob>;
}

export interface ProcessOptions extends ExtractOptions {
  backend: ProcessingBackendId;
  operation: SegmentOperation;
}

async function processOnContabo(
  request: SegmentRequest,
  operation: SegmentOperation,
  deps: ProcessDeps,
  options: ExtractOptions,
): Promise<ExtractedSegment> {
  const multiplier = multiplierOf(operation);
  if (!multiplier) return extractSegment(request, deps, { ...options, prefer: 'contabo' });
  const source = await buildJobSource(request, deps);
  options.onStatus?.(`Interpolating ${multiplier}× on the Contabo worker…`);
  const result = await runContaboJob(
    {
      type: 'rife',
      source,
      startSec: request.startSec,
      endSec: request.endSec,
      params: { multiplier, mode: 'interpolation' },
      ...(request.outputName ? { outputName: request.outputName } : {}),
    },
    deps,
    options,
  );
  assertSegmentLength(result.durationSec, request.startSec, request.endSec, 'The interpolated segment');
  return {
    backend: 'contabo',
    method: result.method,
    mediaName: result.name,
    url: result.url,
    durationSec: result.durationSec,
    ...(result.width ? { width: result.width } : {}),
    ...(result.height ? { height: result.height } : {}),
    ...(result.fps ? { fps: result.fps } : {}),
  };
}

async function processOnHuggingFace(
  request: SegmentRequest,
  multiplier: 2 | 4,
  deps: ProcessDeps,
  options: ExtractOptions,
): Promise<ExtractedSegment> {
  const onStatus = options.onStatus ?? (() => {});
  const segment = await extractSegment(request, deps, { ...options, prefer: 'auto' });
  try {
    const segmentBlob = await deps.fetchBlob(segment.url);
    const segmentFile = new File([segmentBlob], request.outputName ?? 'segment.mp4', {
      type: segmentBlob.type || 'video/mp4',
    });
    const segmentInfo = await deps.probeMedia(segmentFile);

    onStatus('Sending the segment to the RIFE Space…');
    const raw = await deps.rifeOnHuggingFace(segmentBlob, multiplier, onStatus);

    // Check RIFE's own video before the audio goes on: the segment's audio would
    // otherwise pad a short result up to the right length and hide the mismatch.
    const rawInfo = await deps.probeMedia(new File([raw], 'rife.mp4', { type: raw.type || 'video/mp4' }));
    assertSegmentLength(rawInfo.durationSec, request.startSec, request.endSec, 'RIFE’s output');

    const muxed = await deps.muxSegmentAudio(raw, segmentFile, segmentInfo.hasAudio, onStatus);
    const info = await deps.probeMedia(new File([muxed], 'rife-audio.mp4', { type: 'video/mp4' }));
    assertSegmentLength(info.durationSec, request.startSec, request.endSec, 'The interpolated segment');
    return {
      backend: 'hf-rife',
      method: 'rife',
      url: deps.makeObjectUrl(muxed),
      durationSec: info.durationSec,
      ...(info.width ? { width: info.width } : {}),
      ...(info.height ? { height: info.height } : {}),
    };
  } finally {
    // The cut we stored on the server only fed RIFE.
    if (segment.mediaName) await deps.contabo()?.deleteMedia(segment.mediaName).catch(() => {});
  }
}

/**
 * Cut a segment and process it on the chosen backend. The result is always the
 * length that was requested, or this throws.
 *
 * `colab` is manual: use {@link extractSegment} to get the file to take away,
 * then {@link importProcessedSegment} for what comes back.
 */
export async function processSegment(
  request: SegmentRequest,
  deps: ProcessDeps,
  { backend, operation, ...options }: ProcessOptions,
): Promise<ExtractedSegment> {
  validateSegmentRange(request.startSec, request.endSec);
  if (!backendInfo(backend).operations.includes(operation)) {
    throw new SegmentError(`${backendInfo(backend).label} cannot do “${OPERATION_LABELS[operation]}”.`);
  }
  switch (backend) {
    case 'browser':
      return extractSegment(request, deps, { ...options, prefer: 'browser' });
    case 'contabo':
      return processOnContabo(request, operation, deps, options);
    case 'hf-rife':
      return processOnHuggingFace(request, multiplierOf(operation)!, deps, options);
    case 'colab':
      throw new SegmentError('Colab is manual: download the cut segment, process it, then import the result.');
  }
}

/** A processed file the user brings back (Colab round trip): accepted only at the requested length. */
export async function importProcessedSegment(
  file: File,
  request: Pick<SegmentRequest, 'startSec' | 'endSec'>,
  deps: Pick<SegmentDeps, 'probeMedia' | 'makeObjectUrl'>,
): Promise<ExtractedSegment> {
  validateSegmentRange(request.startSec, request.endSec);
  const info = await deps.probeMedia(file);
  assertSegmentLength(info.durationSec, request.startSec, request.endSec, `“${file.name}”`);
  return {
    backend: 'colab',
    url: deps.makeObjectUrl(file),
    durationSec: info.durationSec,
    ...(info.width ? { width: info.width } : {}),
    ...(info.height ? { height: info.height } : {}),
  };
}
