import {
  emitLoadStatus,
  getCdnLabel,
  getFfmpegCoreSources,
  toBlobURLWithRetry,
  withTimeout,
  type ProgressCallback,
  type StatusCallback,
} from './ffmpegCommon';

/** The files one `@ffmpeg/core` build needs, as the worker loads them. */
export interface FfmpegCoreURLs {
  coreURL: string;
  wasmURL: string;
  /** The pthread worker script; the multi-threaded core only. */
  workerURL?: string;
}

export interface ResolvedFfmpegCore extends FfmpegCoreURLs {
  /** Base URL every file came from (one source, so one build). */
  source: string;
  /**
   * `url`: same-origin files loaded by URL, so the wasm compiles while it
   * streams and the browser can cache the compiled code. `blob`: a CDN copy
   * downloaded into blob URLs, because the CSP allows `blob:` scripts but not
   * the CDN hosts.
   */
  delivery: 'url' | 'blob';
}

type CoreFileKey = 'coreURL' | 'wasmURL' | 'workerURL';

interface CoreFile {
  key: CoreFileKey;
  name: string;
  mimeType: string;
  label: string;
}

/** How long one HEAD probe of a self-hosted file may take. */
export const FFMPEG_CORE_PROBE_TIMEOUT_MS = 10_000;

function coreFiles(variant: 'mt' | 'st'): CoreFile[] {
  const prefix = variant === 'mt' ? 'FFmpeg core-mt' : 'FFmpeg core';
  const files: CoreFile[] = [
    { key: 'coreURL', name: 'ffmpeg-core.js', mimeType: 'text/javascript', label: `${prefix}.js` },
    { key: 'wasmURL', name: 'ffmpeg-core.wasm', mimeType: 'application/wasm', label: `${prefix}.wasm` },
  ];
  if (variant === 'mt') {
    files.push({
      key: 'workerURL',
      name: 'ffmpeg-core.worker.js',
      mimeType: 'text/javascript',
      label: `${prefix} worker.js`,
    });
  }
  return files;
}

function pageOrigin(): string | null {
  const base =
    typeof document !== 'undefined'
      ? document.baseURI
      : typeof location !== 'undefined'
        ? location.href
        : null;
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** A source on the page's own origin (the self-hosted `/ffmpeg-core*` copy). */
export function isSameOriginCoreSource(baseURL: string): boolean {
  const origin = pageOrigin();
  if (!origin) return false;
  try {
    return new URL(baseURL).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Cheap check that a self-hosted file is really there before the worker is
 * pointed at it. A static server with an SPA fallback answers a missing file
 * with index.html (200, text/html), so the type is checked too; a module
 * script or worker script must be served as JavaScript. Servers that refuse
 * HEAD (405 / 501) cannot be probed and are trusted.
 */
async function probeSelfHostedFile(
  url: string,
  file: CoreFile,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await withTimeout(
    fetchImpl(url, { method: 'HEAD', credentials: 'same-origin' }),
    FFMPEG_CORE_PROBE_TIMEOUT_MS,
    `Checking ${url}`,
  );
  if (response.status === 405 || response.status === 501) return;
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('text/html')) {
    throw new Error(`${url} is served as ${type} (missing file behind an HTML fallback?)`);
  }
  if (file.mimeType === 'text/javascript' && !/javascript|ecmascript/.test(type)) {
    throw new Error(`${url} is served as "${type}", not JavaScript`);
  }
}

function revokeAll(urls: string[]): void {
  if (typeof URL.revokeObjectURL !== 'function') return;
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

async function downloadAsBlobs(
  baseURL: string,
  files: CoreFile[],
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  recordLog: (message: string) => void,
): Promise<Record<CoreFileKey, string | undefined>> {
  const cdnLabel = getCdnLabel(baseURL);
  const urls: Record<CoreFileKey, string | undefined> = {
    coreURL: undefined,
    wasmURL: undefined,
    workerURL: undefined,
  };
  const created: string[] = [];
  try {
    for (const file of files) {
      const blobURL = await toBlobURLWithRetry(
        `${baseURL}/${file.name}`,
        file.mimeType,
        onStatus,
        onProgress,
        `${file.label} from ${cdnLabel}`,
        recordLog,
      );
      created.push(blobURL);
      urls[file.key] = blobURL;
    }
  } catch (error) {
    // One file failed: this source is out, so free what it already downloaded.
    revokeAll(created);
    throw error;
  }
  return urls;
}

/**
 * Pick the first source that has every file of the variant (js + wasm, plus
 * the pthread worker for mt), so all of them come from one source and one
 * version. The self-hosted copy is probed and then loaded by URL; a CDN copy
 * is downloaded into blob URLs. Any file failing moves on to the next source.
 */
export async function resolveFfmpegCoreSource(
  variant: 'mt' | 'st',
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  recordLog: (message: string) => void,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ResolvedFfmpegCore> {
  const files = coreFiles(variant);
  const variantLabel = variant === 'mt' ? 'FFmpeg core-mt' : 'FFmpeg core';
  const sources = getFfmpegCoreSources(variant);
  let lastError: Error | null = null;

  for (const [index, baseURL] of sources.entries()) {
    const cdnLabel = getCdnLabel(baseURL);
    try {
      let urls: Record<CoreFileKey, string | undefined>;
      let delivery: ResolvedFfmpegCore['delivery'];
      if (isSameOriginCoreSource(baseURL)) {
        emitLoadStatus(onStatus, onProgress, `Checking ${variantLabel} on ${cdnLabel}...`);
        urls = { coreURL: undefined, wasmURL: undefined, workerURL: undefined };
        for (const file of files) {
          const url = `${baseURL}/${file.name}`;
          await probeSelfHostedFile(url, file, fetchImpl);
          urls[file.key] = url;
        }
        delivery = 'url';
      } else {
        urls = await downloadAsBlobs(baseURL, files, onStatus, onProgress, recordLog);
        delivery = 'blob';
      }
      const { coreURL, wasmURL, workerURL } = urls;
      if (!coreURL || !wasmURL) {
        throw new Error(`${baseURL} is missing ffmpeg-core.js or ffmpeg-core.wasm`);
      }
      return {
        source: baseURL,
        delivery,
        coreURL,
        wasmURL,
        ...(workerURL ? { workerURL } : {}),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      recordLog(`[FFmpeg load] ${variant} source ${baseURL} failed: ${lastError.message}`);
      if (index < sources.length - 1) {
        emitLoadStatus(
          onStatus,
          onProgress,
          `${cdnLabel} unavailable for ${variantLabel}. Trying the next FFmpeg source...`,
        );
      }
    }
  }
  throw new Error(
    `Failed to load ${variant === 'mt' ? 'the multi-threaded ' : ''}FFmpeg core from local assets and all fallback CDNs. Last error: ${lastError?.message ?? 'unknown'}`,
  );
}
