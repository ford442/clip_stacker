import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ toBlobURL: vi.fn() }));

vi.mock('@ffmpeg/util', () => ({ toBlobURL: mocked.toBlobURL }));

import { isSameOriginCoreSource, resolveFfmpegCoreSource } from './coreSources';

const LOCAL_ST = 'http://localhost:3000/ffmpeg-core';
const LOCAL_MT = 'http://localhost:3000/ffmpeg-core-mt';
const JSDELIVR = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const UNPKG = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

function head(status: number, type?: string): Response {
  return new Response(null, { status, headers: type ? { 'content-type': type } : {} });
}

/** A static server with every self-hosted file, except where `override` answers. */
function serverFetch(override: (url: string) => Response | undefined = () => undefined) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    return (
      override(url) ??
      head(200, url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8')
    );
  });
}

async function resolve(variant: 'mt' | 'st', fetchImpl: typeof fetch) {
  const recordLog = vi.fn();
  const result = await resolveFfmpegCoreSource(variant, vi.fn(), undefined, recordLog, fetchImpl);
  return { result, recordLog };
}

describe('resolveFfmpegCoreSource', () => {
  beforeEach(() => {
    mocked.toBlobURL.mockReset();
    mocked.toBlobURL.mockImplementation(async (url: string) => `blob:${url}`);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads the self-hosted st core by URL after a HEAD probe of each file', async () => {
    const fetchImpl = serverFetch();
    const { result } = await resolve('st', fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      source: LOCAL_ST,
      delivery: 'url',
      coreURL: `${LOCAL_ST}/ffmpeg-core.js`,
      wasmURL: `${LOCAL_ST}/ffmpeg-core.wasm`,
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${LOCAL_ST}/ffmpeg-core.js`, 'HEAD'],
      [`${LOCAL_ST}/ffmpeg-core.wasm`, 'HEAD'],
    ]);
    expect(mocked.toBlobURL).not.toHaveBeenCalled();
  });

  it('loads the self-hosted mt core (js + wasm + worker.js) by URL', async () => {
    const { result } = await resolve('mt', serverFetch() as unknown as typeof fetch);
    expect(result).toEqual({
      source: LOCAL_MT,
      delivery: 'url',
      coreURL: `${LOCAL_MT}/ffmpeg-core.js`,
      wasmURL: `${LOCAL_MT}/ffmpeg-core.wasm`,
      workerURL: `${LOCAL_MT}/ffmpeg-core.worker.js`,
    });
  });

  it('skips the whole self-hosted source when one file is missing, and uses CDN blobs', async () => {
    const fetchImpl = serverFetch((url) => (url.endsWith('.wasm') ? head(404) : undefined));
    const { result, recordLog } = await resolve('st', fetchImpl as unknown as typeof fetch);

    // js and wasm come from the same CDN, never the local js with a CDN wasm.
    expect(result).toEqual({
      source: JSDELIVR,
      delivery: 'blob',
      coreURL: `blob:${JSDELIVR}/ffmpeg-core.js`,
      wasmURL: `blob:${JSDELIVR}/ffmpeg-core.wasm`,
    });
    expect(recordLog).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
  });

  it('treats an HTML answer (SPA fallback) as a missing file', async () => {
    const fetchImpl = serverFetch((url) =>
      url.endsWith('.wasm') ? head(200, 'text/html; charset=utf-8') : undefined,
    );
    const { result } = await resolve('st', fetchImpl as unknown as typeof fetch);
    expect(result.delivery).toBe('blob');
  });

  it('refuses a self-hosted script that is not served as JavaScript', async () => {
    const fetchImpl = serverFetch((url) =>
      url.endsWith('.js') ? head(200, 'text/plain') : undefined,
    );
    const { result } = await resolve('st', fetchImpl as unknown as typeof fetch);
    expect(result.source).toBe(JSDELIVR);
  });

  it('trusts a server that refuses HEAD', async () => {
    const fetchImpl = serverFetch(() => head(405));
    const { result } = await resolve('st', fetchImpl as unknown as typeof fetch);
    expect(result.delivery).toBe('url');
  });

  it('falls back as a pair: a CDN missing its wasm loses its js too', async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fetchImpl = serverFetch(() => head(404));
    mocked.toBlobURL.mockImplementation(async (url: string) => {
      if (url === `${JSDELIVR}/ffmpeg-core.wasm`) throw new Error('jsDelivr down');
      return `blob:${url}`;
    });

    const promise = resolve('st', fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(10_000);
    const { result } = await promise;

    expect(result).toEqual({
      source: UNPKG,
      delivery: 'blob',
      coreURL: `blob:${UNPKG}/ffmpeg-core.js`,
      wasmURL: `blob:${UNPKG}/ffmpeg-core.wasm`,
    });
    // The jsDelivr js that did download is freed, not leaked.
    expect(revoke).toHaveBeenCalledWith(`blob:${JSDELIVR}/ffmpeg-core.js`);
  });

  it('fails with the last error when no source has every file', async () => {
    vi.useFakeTimers();
    mocked.toBlobURL.mockRejectedValue(new Error('offline'));
    const promise = resolveFfmpegCoreSource(
      'mt',
      vi.fn(),
      undefined,
      vi.fn(),
      serverFetch(() => head(404)) as unknown as typeof fetch,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await promise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /Failed to load the multi-threaded FFmpeg core .* Last error: .*offline/,
    );
  });
});

describe('isSameOriginCoreSource', () => {
  it('is true for the self-hosted copy and false for the CDNs', () => {
    expect(isSameOriginCoreSource(LOCAL_ST)).toBe(true);
    expect(isSameOriginCoreSource(JSDELIVR)).toBe(false);
    expect(isSameOriginCoreSource('not a url')).toBe(false);
  });
});
