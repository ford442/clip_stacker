/**
 * Chunked, resumable media uploads for ContaboStorageManagerClient.
 *
 * Files larger than {@link CHUNK_THRESHOLD_BYTES} use a session-based protocol:
 *   POST   {mediaEndpoint}/upload/init
 *   PUT    {mediaEndpoint}/upload/{uploadId}/{chunkIndex}
 *   POST   {mediaEndpoint}/upload/{uploadId}/complete
 *   GET    {mediaEndpoint}/upload/{uploadId}/status
 *
 * In-flight sessions (uploadId + completed chunk bitmap) are persisted in
 * localStorage so a mid-upload refresh / sleep can resume from the last
 * confirmed chunk.
 */

/** Default chunk size requested from the server (5 MiB). */
export const DEFAULT_CHUNK_SIZE = 5_242_880;

/**
 * Files at or below this size use the legacy single-request multipart POST.
 * Larger files use the chunked path.
 */
export const CHUNK_THRESHOLD_BYTES = 10 * 1024 * 1024;

/** Per-chunk network retries before surfacing failure to the caller. */
export const CHUNK_MAX_ATTEMPTS = 3;

/** localStorage key for in-flight upload session metadata. */
export const UPLOAD_SESSION_STORAGE_KEY = 'clip_stacker_upload_sessions_v1';

/** Drop persisted sessions older than this (matches server 24 h TTL). */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChunkedUploadProgress {
  /** Overall 0..1 progress across all chunks. */
  progress: number;
  /** Zero-based index of the chunk currently uploading (if any). */
  chunkIndex?: number;
  /** Total number of chunks for this file. */
  chunkTotal?: number;
  /** Bytes confirmed by the server so far. */
  bytesUploaded: number;
  /** Total file size in bytes. */
  bytesTotal: number;
}

export interface ChunkedUploadOptions {
  mediaEndpoint: string;
  authHeader?: string | null;
  name: string;
  blob: Blob;
  mimeType?: string;
  onProgress?: (update: ChunkedUploadProgress) => void;
  /** Override storage (tests). Defaults to `localStorage`. */
  storage?: UploadSessionStorage;
  /** Inject fetch (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Inject XMLHttpRequest constructor (tests).
   * Pass `null` to force the fetch-based chunk PUT path (no XHR).
   */
  xhrImpl?: typeof XMLHttpRequest | null;
}

export interface UploadSessionRecord {
  uploadId: string;
  endpoint: string;
  fingerprint: string;
  name: string;
  size: number;
  chunkSize: number;
  receivedChunks: number[];
  updatedAt: number;
}

export interface UploadSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SessionStore {
  version: 1;
  sessions: UploadSessionRecord[];
}

function defaultStorage(): UploadSessionStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Stable fingerprint for resume matching (name + size + lastModified when available). */
export function buildUploadFingerprint(name: string, blob: Blob): string {
  const lastModified =
    typeof File !== 'undefined' && blob instanceof File ? blob.lastModified : 0;
  return `${name}|${blob.size}|${lastModified}`;
}

export function loadUploadSessionStore(
  storage: UploadSessionStorage | null = defaultStorage(),
): SessionStore {
  if (!storage) return { version: 1, sessions: [] };
  try {
    const raw = storage.getItem(UPLOAD_SESSION_STORAGE_KEY);
    if (!raw) return { version: 1, sessions: [] };
    const parsed = JSON.parse(raw) as SessionStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: [] };
    }
    const now = Date.now();
    const sessions = parsed.sessions.filter(
      (s) => s && typeof s.uploadId === 'string' && now - (s.updatedAt || 0) < UPLOAD_SESSION_TTL_MS,
    );
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function persistSessionStore(
  store: SessionStore,
  storage: UploadSessionStorage | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(UPLOAD_SESSION_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota / private mode — resume will be best-effort for this tab only.
  }
}

export function findUploadSession(
  endpoint: string,
  fingerprint: string,
  storage: UploadSessionStorage | null = defaultStorage(),
): UploadSessionRecord | undefined {
  const store = loadUploadSessionStore(storage);
  return store.sessions.find(
    (s) => s.endpoint === endpoint && s.fingerprint === fingerprint,
  );
}

export function saveUploadSession(
  record: UploadSessionRecord,
  storage: UploadSessionStorage | null = defaultStorage(),
): void {
  const store = loadUploadSessionStore(storage);
  const next = store.sessions.filter(
    (s) => !(s.endpoint === record.endpoint && s.fingerprint === record.fingerprint),
  );
  next.push({ ...record, updatedAt: Date.now() });
  persistSessionStore({ version: 1, sessions: next }, storage);
}

export function clearUploadSession(
  endpoint: string,
  fingerprint: string,
  storage: UploadSessionStorage | null = defaultStorage(),
): void {
  const store = loadUploadSessionStore(storage);
  const next = store.sessions.filter(
    (s) => !(s.endpoint === endpoint && s.fingerprint === fingerprint),
  );
  persistSessionStore({ version: 1, sessions: next }, storage);
}

function authHeaders(authHeader?: string | null): Record<string, string> {
  if (!authHeader) return {};
  return { authorization: authHeader };
}

async function initUploadSession(
  mediaEndpoint: string,
  name: string,
  size: number,
  contentType: string,
  authHeader: string | null | undefined,
  fetchImpl: typeof fetch,
): Promise<{ uploadId: string; chunkSize: number }> {
  const response = await fetchImpl(`${mediaEndpoint}/upload/init`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(authHeader),
    },
    body: JSON.stringify({ name, size, contentType }),
  });
  if (!response.ok) {
    throw new Error(`Chunked upload init failed (${response.status})`);
  }
  const result = (await response.json()) as { uploadId?: string; chunkSize?: number };
  if (!result.uploadId) {
    throw new Error('Chunked upload init failed (missing uploadId)');
  }
  return {
    uploadId: result.uploadId,
    chunkSize: result.chunkSize && result.chunkSize > 0 ? result.chunkSize : DEFAULT_CHUNK_SIZE,
  };
}

async function fetchUploadStatus(
  mediaEndpoint: string,
  uploadId: string,
  authHeader: string | null | undefined,
  fetchImpl: typeof fetch,
): Promise<{ receivedChunks: number[]; chunkSize?: number } | null> {
  try {
    const response = await fetchImpl(`${mediaEndpoint}/upload/${uploadId}/status`, {
      headers: authHeaders(authHeader),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Chunked upload status failed (${response.status})`);
    }
    const result = (await response.json()) as {
      receivedChunks?: number[];
      chunkSize?: number;
    };
    return {
      receivedChunks: Array.isArray(result.receivedChunks)
        ? result.receivedChunks.map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [],
      chunkSize: result.chunkSize,
    };
  } catch (error) {
    // Network blip while probing — treat as no resume data.
    if (error instanceof Error && /status failed/.test(error.message)) throw error;
    return null;
  }
}

function putChunkWithXhr(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onChunkProgress: ((loaded: number, total: number) => void) | undefined,
  XhrCtor: typeof XMLHttpRequest,
): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    const request = new XhrCtor();
    request.open('PUT', url);
    for (const [key, value] of Object.entries(headers)) {
      request.setRequestHeader(key, value);
    }

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onChunkProgress) return;
      onChunkProgress(event.loaded, event.total);
    };

    request.onerror = () => reject(new Error('Chunk upload failed (network error)'));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`Chunk upload failed (${request.status})`));
        return;
      }
      try {
        const result = JSON.parse(request.responseText) as { received?: number };
        if (typeof result.received !== 'number') {
          reject(new Error('Chunk upload failed (invalid response)'));
          return;
        }
        resolve({ received: result.received });
      } catch (error) {
        reject(
          new Error(
            `Chunk upload failed (invalid JSON response: ${(error as Error).message})`,
          ),
        );
      }
    };

    request.send(body);
  });
}

async function putChunkWithFetch(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ received: number }> {
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Chunk upload failed (${response.status})`);
  }
  const result = (await response.json()) as { received?: number };
  if (typeof result.received !== 'number') {
    throw new Error('Chunk upload failed (invalid response)');
  }
  return { received: result.received };
}

async function completeUpload(
  mediaEndpoint: string,
  uploadId: string,
  authHeader: string | null | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${mediaEndpoint}/upload/${uploadId}/complete`, {
    method: 'POST',
    headers: authHeaders(authHeader),
  });
  if (!response.ok) {
    throw new Error(`Chunked upload complete failed (${response.status})`);
  }
  const result = (await response.json()) as { url?: string };
  if (!result.url) {
    throw new Error('Chunked upload complete failed (missing url)');
  }
  return result.url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upload a blob using the chunked, resumable protocol.
 * Returns the public media URL (same shape as the single-request path).
 */
export async function uploadMediaChunked(options: ChunkedUploadOptions): Promise<string> {
  const {
    mediaEndpoint,
    authHeader,
    name,
    blob,
    mimeType = 'application/octet-stream',
    onProgress,
    storage = defaultStorage(),
    fetchImpl = fetch,
  } = options;

  const xhrImpl =
    options.xhrImpl === null
      ? undefined
      : (options.xhrImpl ??
        (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined));

  const endpoint = mediaEndpoint.replace(/\/*$/, '');
  const fingerprint = buildUploadFingerprint(name, blob);
  const totalSize = blob.size;

  let uploadId: string;
  let chunkSize: number;
  let received = new Set<number>();

  const existing = findUploadSession(endpoint, fingerprint, storage);
  if (existing && existing.size === totalSize) {
    const status = await fetchUploadStatus(endpoint, existing.uploadId, authHeader, fetchImpl);
    if (status) {
      uploadId = existing.uploadId;
      chunkSize = status.chunkSize && status.chunkSize > 0 ? status.chunkSize : existing.chunkSize;
      received = new Set(status.receivedChunks);
    } else {
      clearUploadSession(endpoint, fingerprint, storage);
      const init = await initUploadSession(
        endpoint,
        name,
        totalSize,
        mimeType,
        authHeader,
        fetchImpl,
      );
      uploadId = init.uploadId;
      chunkSize = init.chunkSize;
    }
  } else {
    const init = await initUploadSession(
      endpoint,
      name,
      totalSize,
      mimeType,
      authHeader,
      fetchImpl,
    );
    uploadId = init.uploadId;
    chunkSize = init.chunkSize;
  }

  const chunkTotal = Math.max(1, Math.ceil(totalSize / chunkSize));

  const persist = () => {
    saveUploadSession(
      {
        uploadId,
        endpoint,
        fingerprint,
        name,
        size: totalSize,
        chunkSize,
        receivedChunks: [...received].sort((a, b) => a - b),
        updatedAt: Date.now(),
      },
      storage,
    );
  };
  persist();

  const emitProgress = (
    bytesConfirmed: number,
    chunkIndex?: number,
    chunkLoaded = 0,
    chunkLength = 0,
  ) => {
    const bytesUploaded = Math.min(totalSize, bytesConfirmed + chunkLoaded);
    onProgress?.({
      progress: totalSize > 0 ? Math.max(0, Math.min(1, bytesUploaded / totalSize)) : 1,
      chunkIndex,
      chunkTotal,
      bytesUploaded,
      bytesTotal: totalSize,
    });
  };

  const bytesFromReceived = () => {
    let bytes = 0;
    for (const index of received) {
      const start = index * chunkSize;
      bytes += Math.min(chunkSize, totalSize - start);
    }
    return bytes;
  };

  emitProgress(bytesFromReceived());

  for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex += 1) {
    if (received.has(chunkIndex)) continue;

    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, totalSize) - 1;
    const chunkBlob = blob.slice(start, end + 1);
    const contentRange = `bytes ${start}-${end}/${totalSize}`;
    const url = `${endpoint}/upload/${uploadId}/${chunkIndex}`;
    const headers: Record<string, string> = {
      'Content-Range': contentRange,
      'Content-Type': 'application/octet-stream',
      ...authHeaders(authHeader),
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt += 1) {
      try {
        const onChunkProgress = (loaded: number, total: number) => {
          emitProgress(bytesFromReceived(), chunkIndex, loaded, total);
        };

        if (xhrImpl) {
          await putChunkWithXhr(url, chunkBlob, headers, onChunkProgress, xhrImpl);
        } else {
          await putChunkWithFetch(url, chunkBlob, headers, fetchImpl);
        }

        received.add(chunkIndex);
        persist();
        emitProgress(bytesFromReceived(), chunkIndex);
        lastError = null;
        break;
      } catch (error) {
        lastError = error as Error;
        if (attempt < CHUNK_MAX_ATTEMPTS) {
          await sleep(250 * attempt);
        }
      }
    }

    if (lastError) {
      throw new Error(
        `Chunk ${chunkIndex + 1}/${chunkTotal} failed after ${CHUNK_MAX_ATTEMPTS} attempts: ${lastError.message}`,
      );
    }
  }

  const url = await completeUpload(endpoint, uploadId, authHeader, fetchImpl);
  clearUploadSession(endpoint, fingerprint, storage);
  onProgress?.({
    progress: 1,
    chunkIndex: chunkTotal - 1,
    chunkTotal,
    bytesUploaded: totalSize,
    bytesTotal: totalSize,
  });
  return url;
}
