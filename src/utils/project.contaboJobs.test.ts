import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContaboStorageManagerClient } from './project';
import { pollJobUntilDone, type ContaboJob } from './project/contaboJobs';

const ENDPOINT = 'https://storage.example/webhook/clip-stacker';

function job(overrides: Partial<ContaboJob> = {}): ContaboJob {
  return {
    jobId: 'a'.repeat(32),
    type: 'extract',
    status: 'queued',
    progress: 0,
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => vi.unstubAllGlobals());

describe('ContaboStorageManagerClient media list', () => {
  it('reads the `media` array the Contabo server returns', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ media: [{ name: 'a.mp4', url: 'https://x/a.mp4', size: 3 }] })));
    const items = await new ContaboStorageManagerClient(ENDPOINT, 't').listMedia();
    expect(items).toEqual([{ name: 'a.mp4', url: 'https://x/a.mp4', size: 3 }]);
  });

  it('deletes a media file by encoded name with the auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ status: 'success' }));
    vi.stubGlobal('fetch', fetchMock);
    await new ContaboStorageManagerClient(ENDPOINT, 'tok').deleteMedia('seg one.mp4');
    expect(fetchMock).toHaveBeenCalledWith(`${ENDPOINT}/media/seg%20one.mp4`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok' },
    });
  });
});

describe('ContaboStorageManagerClient jobs', () => {
  it('POSTs the request as JSON with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(job(), 202));
    vi.stubGlobal('fetch', fetchMock);
    const request = { type: 'extract', source: { kind: 'media', name: 'a.mp4' }, startSec: 1, endSec: 3 } as const;
    const created = await new ContaboStorageManagerClient(`${ENDPOINT}/`, 'tok').createJob(request);

    expect(created.status).toBe('queued');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/jobs`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok' });
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it('omits the auth header when no token is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(job()));
    vi.stubGlobal('fetch', fetchMock);
    await new ContaboStorageManagerClient(ENDPOINT).getJob('abc');
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/jobs/abc`);
  });

  it('cancels via POST /jobs/{id}/cancel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(job({ status: 'cancelled' })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new ContaboStorageManagerClient(ENDPOINT).cancelJob('abc');
    expect(result.status).toBe('cancelled');
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/jobs/abc/cancel`);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('turns FastAPI string and validation errors into readable messages', async () => {
    const client = new ContaboStorageManagerClient(ENDPOINT);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ detail: 'RIFE is not configured on this server' }, 501)));
    await expect(client.createJob({ type: 'rife' })).rejects.toThrow(
      'Starting the processing job failed (501): RIFE is not configured on this server',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ detail: [{ msg: 'Value error, a' }, { msg: 'Value error, b' }] }, 422)),
    );
    await expect(client.createJob({ type: 'extract' })).rejects.toThrow('(422): Value error, a; Value error, b');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('html'); } }));
    await expect(client.getJob('x')).rejects.toThrow('Checking the processing job failed (502)');
  });
});

describe('pollJobUntilDone', () => {
  it('polls until the job leaves queued/running and reports every update', async () => {
    const states = [job(), job({ status: 'running', progress: 0.5 }), job({ status: 'succeeded', progress: 1 })];
    const getJob = vi.fn(async () => states.shift()!);
    const seen: string[] = [];
    const done = await pollJobUntilDone(getJob, 'x', { pollMs: 1, onUpdate: (j) => seen.push(j.status) });
    expect(done.status).toBe('succeeded');
    expect(seen).toEqual(['queued', 'running', 'succeeded']);
  });

  it('stops polling when aborted', async () => {
    const controller = new AbortController();
    const getJob = vi.fn(async () => job({ status: 'running' }));
    const pending = pollJobUntilDone(getJob, 'x', { pollMs: 50, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getJob).toHaveBeenCalledTimes(1);
  });
});
