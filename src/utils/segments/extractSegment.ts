import type { Clip, DriveMediaItem, ProcessingBackendId, SegmentRequest, SegmentResult } from '../../types';
import type { SegmentCutMode } from '../../ffmpeg/segment';
import type { ContaboJob, ContaboJobRequest, ContaboJobSource } from '../project/contaboJobs';
import { MIN_CLIP_DURATION } from '../media';
import { SEGMENT_DURATION_TOLERANCE_SEC } from './segmentReplace';

/**
 * Where a segment is cut. FFmpeg.wasm holds the whole input in memory, so it
 * only gets small files; anything big is cut on the Contabo worker, which for
 * Drive files downloads straight from Drive — the browser never sees the bytes.
 */
export const BROWSER_LOCAL_LIMIT_BYTES = 256 * 1024 * 1024;
/** Drive files up to this size are fetched into the browser and cut there. */
export const BROWSER_DRIVE_LIMIT_BYTES = 128 * 1024 * 1024;
/** Even when the user forces "Browser FFmpeg", nothing above this is loaded. */
export const BROWSER_HARD_LIMIT_BYTES = 1024 * 1024 * 1024;

export type ExtractRoute = 'browser' | 'contabo';
export type RoutePreference = 'auto' | ExtractRoute;

/** A failure with a message written for the user. */
export class SegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentError';
  }
}

export interface ExtractedSegment extends SegmentResult {
  /** Where the media was produced. */
  backend: ProcessingBackendId;
  /** `copy` / `reencode` / `rife` — how the media was produced. */
  method?: string;
  /** Name in the remote media library (Contabo results) — for the list/delete routes. */
  mediaName?: string;
}

/** Everything extractSegment needs from the outside world, so it can be tested without a browser. */
export interface SegmentDeps {
  getClip(clipId: string): Clip | undefined;
  getDriveItem(fileId: string): DriveMediaItem | undefined;
  getDriveToken(): Promise<string>;
  /** `null` when no storage endpoint is configured. */
  contabo(): {
    createJob(request: ContaboJobRequest): Promise<ContaboJob>;
    waitForJob(jobId: string, options?: { signal?: AbortSignal; onUpdate?: (job: ContaboJob) => void }): Promise<ContaboJob>;
    cancelJob(jobId: string): Promise<ContaboJob>;
    /** Remove a media-library file (a job output that is no longer needed). */
    deleteMedia(name: string): Promise<void>;
  } | null;
  cutInBrowser(file: File, startSec: number, endSec: number, mode: SegmentCutMode, onStatus: (message: string) => void): Promise<Blob>;
  probeMedia(file: File): Promise<{ durationSec: number; width?: number; height?: number; hasAudio?: boolean }>;
  /** Download a Drive file with the user's token (small files only; see the limits above). */
  fetchDriveFile(item: DriveMediaItem, token: string, signal?: AbortSignal): Promise<File>;
  makeObjectUrl(blob: Blob): string;
}

export interface ExtractOptions {
  prefer?: RoutePreference;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  onJob?: (job: ContaboJob) => void;
}

export function validateSegmentRange(startSec: number, endSec: number): void {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0) {
    throw new SegmentError('Enter a valid start and end time in seconds.');
  }
  if (endSec - startSec < MIN_CLIP_DURATION) {
    throw new SegmentError(`A segment must be at least ${MIN_CLIP_DURATION}s long.`);
  }
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export interface RouteFacts {
  kind: SegmentRequest['source']['kind'];
  /** Bytes; 0 / undefined = unknown (treated as large). */
  sizeBytes?: number;
  /** The clip is also in the remote media library, so the server can read it without an upload. */
  hasRemoteCopy?: boolean;
  contaboConfigured: boolean;
}

/** Pick where a segment is cut, or explain why it cannot be. Pure. */
export function chooseExtractRoute(facts: RouteFacts, prefer: RoutePreference = 'auto'): ExtractRoute {
  const size = facts.sizeBytes ?? 0;
  const needServer = (why: string) => {
    if (!facts.contaboConfigured) {
      throw new SegmentError(`${why} Set the storage endpoint (Remote storage) so a Contabo job can do it.`);
    }
  };

  if (facts.kind === 'remote') {
    if (prefer === 'browser') throw new SegmentError('Remote URLs are cut on the server; choose the Contabo job backend.');
    needServer('Remote media is cut on the server.');
    return 'contabo';
  }

  if (facts.kind === 'local') {
    if (prefer === 'contabo') {
      if (!facts.hasRemoteCopy) {
        throw new SegmentError(
          'This clip only exists in your browser. Save it to the remote library first (Save remote), or use Browser FFmpeg.',
        );
      }
      needServer('This clip is read from the remote library by the server.');
      return 'contabo';
    }
    const limit = prefer === 'browser' ? BROWSER_HARD_LIMIT_BYTES : BROWSER_LOCAL_LIMIT_BYTES;
    if (size <= limit) return 'browser';
    if (prefer === 'auto' && facts.hasRemoteCopy && facts.contaboConfigured) return 'contabo';
    throw new SegmentError(
      `This clip is ${mb(size)}, too large for the browser. Put it in the remote library (Save remote) or on Drive and cut it there.`,
    );
  }

  // Drive
  if (prefer === 'contabo') {
    needServer('Drive files are downloaded by the server.');
    return 'contabo';
  }
  const limit = prefer === 'browser' ? BROWSER_HARD_LIMIT_BYTES : BROWSER_DRIVE_LIMIT_BYTES;
  if (size > 0 && size <= limit) return 'browser';
  if (prefer === 'browser') {
    throw new SegmentError(
      size > 0
        ? `This Drive file is ${mb(size)}; the browser does not download files that large.`
        : 'Drive did not report this file’s size, so it will not be downloaded into the browser.',
    );
  }
  needServer(size > 0 ? `This Drive file is ${mb(size)}, too large for the browser.` : 'This Drive file’s size is unknown.');
  return 'contabo';
}

function jobSourceFor(request: SegmentRequest, clip: Clip | undefined, driveItem: DriveMediaItem | undefined, token: string | null): ContaboJobSource {
  const { source } = request;
  if (source.kind === 'remote') return { kind: 'remote', url: source.url };
  if (source.kind === 'local') {
    if (!clip?.remoteSourceUrl) throw new SegmentError('This clip has no copy in the remote library for the server to read.');
    return { kind: 'remote', url: clip.remoteSourceUrl };
  }
  if (!token) throw new SegmentError('Google Drive access is needed for this file.');
  return { kind: 'drive', fileId: source.fileId, accessToken: token, ...(driveItem ? { name: driveItem.name } : {}) };
}

/** What a server job needs to know about the segment's source, resolved from the stores. */
export async function buildJobSource(request: SegmentRequest, deps: SegmentDeps): Promise<ContaboJobSource> {
  const clip = request.source.kind === 'local' ? deps.getClip(request.source.clipId) : undefined;
  if (request.source.kind === 'local' && !clip) throw new SegmentError('That clip is no longer on the timeline.');
  const driveItem = request.source.kind === 'drive' ? deps.getDriveItem(request.source.fileId) : undefined;
  const token = request.source.kind === 'drive' ? await deps.getDriveToken() : null;
  return jobSourceFor(request, clip, driveItem, token);
}

/** Resolve routing facts for a request. */
export function routeFactsFor(request: SegmentRequest, deps: SegmentDeps): RouteFacts {
  const contaboConfigured = deps.contabo() !== null;
  const { source } = request;
  if (source.kind === 'local') {
    const clip = deps.getClip(source.clipId);
    if (!clip) throw new SegmentError('That clip is no longer on the timeline.');
    return { kind: 'local', sizeBytes: clip.file.size, hasRemoteCopy: Boolean(clip.remoteSourceUrl), contaboConfigured };
  }
  if (source.kind === 'drive') {
    return { kind: 'drive', sizeBytes: deps.getDriveItem(source.fileId)?.size ?? 0, contaboConfigured };
  }
  return { kind: 'remote', contaboConfigured };
}

/** Reject a result that is not the requested length (see SEGMENT_DURATION_TOLERANCE_SEC). */
export function assertSegmentLength(durationSec: number, startSec: number, endSec: number, what = 'The cut segment'): void {
  const wanted = endSec - startSec;
  if (!Number.isFinite(durationSec) || Math.abs(durationSec - wanted) > SEGMENT_DURATION_TOLERANCE_SEC) {
    throw new SegmentError(
      `${what} is ${Number.isFinite(durationSec) ? durationSec.toFixed(2) : '?'}s but ${wanted.toFixed(2)}s was requested; ` +
        'a different length would shift the timeline and break a later lossless join.',
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function sourceFile(request: SegmentRequest, deps: SegmentDeps, options: ExtractOptions): Promise<File> {
  const { source } = request;
  if (source.kind === 'local') {
    const clip = deps.getClip(source.clipId);
    if (!clip) throw new SegmentError('That clip is no longer on the timeline.');
    if (request.endSec > clip.duration + SEGMENT_DURATION_TOLERANCE_SEC) {
      throw new SegmentError(`The clip is only ${clip.duration.toFixed(2)}s long.`);
    }
    return clip.file;
  }
  if (source.kind === 'drive') {
    const item = deps.getDriveItem(source.fileId);
    if (!item) throw new SegmentError('That Drive file is no longer in the library.');
    options.onStatus?.(`Downloading "${item.name}" from Drive (${mb(item.size)})…`);
    return deps.fetchDriveFile(item, await deps.getDriveToken(), options.signal);
  }
  throw new SegmentError('Remote URLs are cut on the server.');
}

async function extractInBrowser(request: SegmentRequest, deps: SegmentDeps, options: ExtractOptions): Promise<ExtractedSegment> {
  const { startSec, endSec } = request;
  const onStatus = options.onStatus ?? (() => {});
  const file = await sourceFile(request, deps, options);
  throwIfAborted(options.signal);

  const audioOnly = file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name);
  const outName = request.outputName ?? file.name;

  // Stream copy first; if it comes out the wrong length (a cut that started between
  // keyframes pulls in the frames before it) cut again exactly. Audio always copies.
  for (const mode of audioOnly ? (['copy'] as const) : (['copy', 'reencode'] as const)) {
    const blob = await deps.cutInBrowser(file, startSec, endSec, mode, onStatus);
    throwIfAborted(options.signal);
    const probed = await deps.probeMedia(new File([blob], outName, { type: blob.type }));
    const fits = Math.abs(probed.durationSec - (endSec - startSec)) <= SEGMENT_DURATION_TOLERANCE_SEC;
    if (fits || mode === 'reencode' || audioOnly) {
      assertSegmentLength(probed.durationSec, startSec, endSec);
      return {
        backend: 'browser',
        method: mode,
        url: deps.makeObjectUrl(blob),
        durationSec: probed.durationSec,
        ...(probed.width ? { width: probed.width } : {}),
        ...(probed.height ? { height: probed.height } : {}),
      };
    }
    onStatus('The copy cut is not on a keyframe; cutting exactly instead…');
  }
  throw new SegmentError('Could not cut the segment.');
}

/** Run a server job to completion; aborting cancels it on the server. */
export async function runContaboJob(
  request: ContaboJobRequest,
  deps: SegmentDeps,
  options: ExtractOptions,
): Promise<NonNullable<ContaboJob['result']>> {
  const client = deps.contabo();
  if (!client) throw new SegmentError('Set the storage endpoint (Remote storage) to use Contabo jobs.');
  throwIfAborted(options.signal);
  const created = await client.createJob(request);
  options.onJob?.(created);
  const onAbort = () => void client.cancelJob(created.jobId).catch(() => {});
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const finished = await client.waitForJob(created.jobId, { signal: options.signal, onUpdate: options.onJob });
    if (finished.status === 'succeeded' && finished.result) return finished.result;
    if (finished.status === 'cancelled') throw new DOMException('Aborted', 'AbortError');
    throw new SegmentError(finished.error || `The processing job ${finished.status}.`);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function extractOnContabo(request: SegmentRequest, deps: SegmentDeps, options: ExtractOptions): Promise<ExtractedSegment> {
  const source = await buildJobSource(request, deps);
  options.onStatus?.('Sending the cut to the Contabo worker…');
  const result = await runContaboJob(
    {
      type: 'extract',
      source,
      startSec: request.startSec,
      endSec: request.endSec,
      ...(request.outputName ? { outputName: request.outputName } : {}),
    },
    deps,
    options,
  );
  assertSegmentLength(result.durationSec, request.startSec, request.endSec, 'The server’s segment');
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

/**
 * Cut `[startSec, endSec]` out of a clip, Drive file or remote URL.
 *
 * Small and local media is cut in the browser with FFmpeg.wasm; large Drive
 * files and remote URLs are handed to a Contabo `extract` job. The returned
 * `durationSec` is always within {@link SEGMENT_DURATION_TOLERANCE_SEC} of the
 * request, otherwise this throws — a segment of the wrong length is never
 * handed back.
 */
export async function extractSegment(
  request: SegmentRequest,
  deps: SegmentDeps,
  options: ExtractOptions = {},
): Promise<ExtractedSegment> {
  validateSegmentRange(request.startSec, request.endSec);
  const route = chooseExtractRoute(routeFactsFor(request, deps), options.prefer ?? 'auto');
  return route === 'browser' ? extractInBrowser(request, deps, options) : extractOnContabo(request, deps, options);
}
