/**
 * Contabo clip-stacker job API (`{endpoint}/jobs`), served by
 * `contabo_storage_manager/.../clip_stacker_jobs.py`.
 *
 *   POST {endpoint}/jobs               create (202)
 *   GET  {endpoint}/jobs/{jobId}       poll
 *   POST {endpoint}/jobs/{jobId}/cancel
 */

export type ContaboJobType = 'extract' | 'splice' | 'rife';

export type ContaboJobSource =
  /** `accessToken` is a Google OAuth token; the server uses it for the download only. */
  | { kind: 'drive'; fileId: string; accessToken: string; name?: string }
  | { kind: 'remote'; url: string }
  /** A file already in the remote media library (`clip-stacker/media`). */
  | { kind: 'media'; name: string };

export interface ContaboJobRequest {
  type: ContaboJobType;
  /** extract / rife */
  source?: ContaboJobSource;
  startSec?: number;
  endSec?: number;
  /** splice: ordered parts, each optionally a sub-range of its source. */
  parts?: { source: ContaboJobSource; startSec?: number; endSec?: number }[];
  outputName?: string;
  /** rife: `{ multiplier: 2 | 4 }`. Only length-preserving interpolation is accepted. */
  params?: { multiplier?: 2 | 4; mode?: 'interpolation' };
}

export type ContaboJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ContaboJobResult {
  /** Public URL of the output in the media library. */
  url: string;
  /** File name in the media library — usable with the media list/delete routes. */
  name: string;
  durationSec: number;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  sizeBytes?: number;
  /** `copy` = stream copy, `reencode` = exact re-encode, `rife` = interpolated. */
  method?: 'copy' | 'reencode' | 'rife';
}

export interface ContaboJob {
  jobId: string;
  type: ContaboJobType;
  status: ContaboJobStatus;
  stage?: string | null;
  /** 0..1 */
  progress: number;
  createdAt: string;
  updatedAt: string;
  result?: ContaboJobResult | null;
  error?: string | null;
}

export const CONTABO_JOB_POLL_MS = 2000;

export interface WaitForJobOptions {
  signal?: AbortSignal;
  pollMs?: number;
  onUpdate?: (job: ContaboJob) => void;
}

/** FastAPI error bodies are `{detail: string}` or `{detail: [{loc, msg}]}` (validation). */
export async function describeJobHttpError(response: Response, action: string): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') detail = body.detail;
    else if (Array.isArray(body.detail)) {
      detail = body.detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
        .filter(Boolean)
        .join('; ');
    }
  } catch {
    /* not JSON */
  }
  return `${action} failed (${response.status})${detail ? `: ${detail}` : ''}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/** Poll `getJob` until the job leaves queued/running. Aborting stops polling only; cancel the job separately. */
export async function pollJobUntilDone(
  getJob: (jobId: string) => Promise<ContaboJob>,
  jobId: string,
  { signal, pollMs = CONTABO_JOB_POLL_MS, onUpdate }: WaitForJobOptions = {},
): Promise<ContaboJob> {
  for (;;) {
    const job = await getJob(jobId);
    onUpdate?.(job);
    if (job.status !== 'queued' && job.status !== 'running') return job;
    await sleep(pollMs, signal);
  }
}
