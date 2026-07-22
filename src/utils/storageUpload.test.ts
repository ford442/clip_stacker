import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_MAX_ATTEMPTS,
  CHUNK_THRESHOLD_BYTES,
  DEFAULT_CHUNK_SIZE,
  buildUploadFingerprint,
  clearUploadSession,
  findUploadSession,
  saveUploadSession,
  uploadMediaChunked,
  type UploadSessionStorage,
} from './storageUpload';

function memoryStorage(): UploadSessionStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

describe('storageUpload helpers', () => {
  it('exports the documented chunk size and threshold', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(5_242_880);
    expect(CHUNK_THRESHOLD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('builds a stable fingerprint from name, size, and lastModified', () => {
    const file = new File([new Uint8Array(12)], 'clip.mp4', {
      type: 'video/mp4',
      lastModified: 1_700_000_000_000,
    });
    expect(buildUploadFingerprint('clip.mp4', file)).toBe(
      `clip.mp4|12|1700000000000`,
    );
  });

  it('persists and clears upload sessions in storage', () => {
    const storage = memoryStorage();
    saveUploadSession(
      {
        uploadId: 'u1',
        endpoint: 'https://example.com/api/media',
        fingerprint: 'a|10|0',
        name: 'a.bin',
        size: 10,
        chunkSize: 5,
        receivedChunks: [0],
        updatedAt: Date.now(),
      },
      storage,
    );
    expect(
      findUploadSession('https://example.com/api/media', 'a|10|0', storage)?.uploadId,
    ).toBe('u1');
    clearUploadSession('https://example.com/api/media', 'a|10|0', storage);
    expect(
      findUploadSession('https://example.com/api/media', 'a|10|0', storage),
    ).toBeUndefined();
  });
});

describe('uploadMediaChunked', () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockChunkServer(options?: {
    failChunkAttempts?: Record<number, number>;
    chunkSize?: number;
  }) {
    const chunkSize = options?.chunkSize ?? 8;
    const failRemaining = new Map<number, number>(
      Object.entries(options?.failChunkAttempts ?? {}).map(([k, v]) => [
        Number(k),
        v,
      ]),
    );
    const sessions = new Map<
      string,
      { name: string; size: number; received: Set<number>; bytes: Uint8Array }
    >();
    let uploadCounter = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/upload/init') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          name: string;
          size: number;
        };
        uploadCounter += 1;
        const uploadId = `upload-${uploadCounter}`;
        sessions.set(uploadId, {
          name: body.name,
          size: body.size,
          received: new Set(),
          bytes: new Uint8Array(body.size),
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ uploadId, chunkSize }),
        };
      }

      const statusMatch = url.match(/\/upload\/([^/]+)\/status$/);
      if (statusMatch && method === 'GET') {
        const session = sessions.get(statusMatch[1]);
        if (!session) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            receivedChunks: [...session.received].sort((a, b) => a - b),
            chunkSize,
            totalSize: session.size,
            name: session.name,
          }),
        };
      }

      const chunkMatch = url.match(/\/upload\/([^/]+)\/(\d+)$/);
      if (chunkMatch && method === 'PUT') {
        const uploadId = chunkMatch[1];
        const chunkIndex = Number(chunkMatch[2]);
        const session = sessions.get(uploadId);
        if (!session) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        const remaining = failRemaining.get(chunkIndex) ?? 0;
        if (remaining > 0) {
          failRemaining.set(chunkIndex, remaining - 1);
          return { ok: false, status: 503, json: async () => ({ error: 'flaky' }) };
        }
        const body = init?.body;
        let bytes: Uint8Array;
        if (body instanceof Blob) {
          bytes = new Uint8Array(await body.arrayBuffer());
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body);
        } else {
          bytes = new Uint8Array(0);
        }
        const start = chunkIndex * chunkSize;
        session.bytes.set(bytes, start);
        session.received.add(chunkIndex);
        return {
          ok: true,
          status: 200,
          json: async () => ({ received: start + bytes.length, chunkIndex }),
        };
      }

      const completeMatch = url.match(/\/upload\/([^/]+)\/complete$/);
      if (completeMatch && method === 'POST') {
        const session = sessions.get(completeMatch[1]);
        if (!session) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        const expected = Math.ceil(session.size / chunkSize);
        if (session.received.size < expected) {
          return { ok: false, status: 409, json: async () => ({ error: 'incomplete' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            url: `https://storage.example.com/media/${session.name}`,
          }),
        };
      }

      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;

    return { fetchImpl, sessions };
  }

  it('uploads all chunks and returns the public url', async () => {
    const payload = new Uint8Array(20).map((_, i) => i);
    const blob = new Blob([payload], { type: 'application/octet-stream' });
    const { fetchImpl } = mockChunkServer({ chunkSize: 8 });
    const progress: number[] = [];

    const url = await uploadMediaChunked({
      mediaEndpoint: 'https://example.com/api/media',
      name: 'clip.bin',
      blob,
      storage,
      fetchImpl,
      xhrImpl: null,
      onProgress: (p) => progress.push(p.progress),
    });

    expect(url).toBe('https://storage.example.com/media/clip.bin');
    expect(progress.at(-1)).toBe(1);
    expect(
      findUploadSession(
        'https://example.com/api/media',
        buildUploadFingerprint('clip.bin', blob),
        storage,
      ),
    ).toBeUndefined();
  });

  it('retries a failed chunk without restarting the whole file', async () => {
    const blob = new Blob([new Uint8Array(16)]);
    const { fetchImpl } = mockChunkServer({
      chunkSize: 8,
      failChunkAttempts: { 1: 1 },
    });

    const url = await uploadMediaChunked({
      mediaEndpoint: 'https://example.com/api/media',
      name: 'clip.bin',
      blob,
      storage,
      fetchImpl,
      xhrImpl: null,
    });

    expect(url).toContain('clip.bin');
    const putCalls = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    // chunk 0 once + chunk 1 twice (fail then success) = 3
    expect(putCalls.length).toBe(3);
  });

  it('resumes from persisted session + server status', async () => {
    const blob = new Blob([new Uint8Array(16)]);
    const { fetchImpl, sessions } = mockChunkServer({ chunkSize: 8 });

    // Seed a server session with chunk 0 already received.
    sessions.set('upload-resume', {
      name: 'clip.bin',
      size: 16,
      received: new Set([0]),
      bytes: new Uint8Array(16),
    });
    saveUploadSession(
      {
        uploadId: 'upload-resume',
        endpoint: 'https://example.com/api/media',
        fingerprint: buildUploadFingerprint('clip.bin', blob),
        name: 'clip.bin',
        size: 16,
        chunkSize: 8,
        receivedChunks: [0],
        updatedAt: Date.now(),
      },
      storage,
    );

    const url = await uploadMediaChunked({
      mediaEndpoint: 'https://example.com/api/media',
      name: 'clip.bin',
      blob,
      storage,
      fetchImpl,
      xhrImpl: null,
    });

    expect(url).toContain('clip.bin');
    const putCalls = fetchImpl.mock.calls.filter(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method === 'PUT' &&
        String(input).includes('/upload/upload-resume/'),
    );
    // Only chunk 1 should be uploaded.
    expect(putCalls).toHaveLength(1);
    expect(String(putCalls[0][0])).toContain('/upload/upload-resume/1');
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/upload/init')),
    ).toBe(false);
  });

  it(`gives up a chunk after ${CHUNK_MAX_ATTEMPTS} failures`, async () => {
    const blob = new Blob([new Uint8Array(8)]);
    const { fetchImpl } = mockChunkServer({
      chunkSize: 8,
      failChunkAttempts: { 0: CHUNK_MAX_ATTEMPTS },
    });

    await expect(
      uploadMediaChunked({
        mediaEndpoint: 'https://example.com/api/media',
        name: 'clip.bin',
        blob,
        storage,
        fetchImpl,
        xhrImpl: null,
      }),
    ).rejects.toThrow(/Chunk 1\/1 failed/);
  });
});
