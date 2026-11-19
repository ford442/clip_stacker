import { afterEach, describe, expect, it, vi } from 'vitest';
import { InProcessWorker, flushWorkerMessages } from './inProcessWorker.test.helpers';
import {
  WorkerCrashedError,
  WorkerTimeoutError,
  __clearWorkerCrashLogForTests,
  createWorkerClient,
  exposeWorker,
  getWorkerCrashLog,
  withTransfer,
  type WorkerClientOptions,
  type WorkerHandlers,
  type WorkerPort,
} from './workerRpc';

type TestProtocol = {
  double: { req: { values: Float32Array }; res: { values: Float32Array } };
  echo: { req: string; res: string };
  ping: { req: void; res: 'pong' };
  fail: { req: { name?: string; message: string }; res: never };
  wait: { req: number; res: 'done' | 'aborted' };
  hang: { req: void; res: void };
  sink: { req: unknown; res: void };
  stream: { req: { count: number }; res: number };
  push: { notify: { value: number } };
  reset: { notify: void };
  tick: { event: { index: number; data: Float32Array } };
  pushed: { event: number };
};

function testHandlers(port: WorkerPort<TestProtocol>): WorkerHandlers<TestProtocol> {
  let total = 0;
  return {
    double: ({ values }) => {
      const out = values.map((v) => v * 2);
      return withTransfer({ values: out }, [out.buffer]);
    },
    echo: async (s) => {
      await Promise.resolve();
      return s;
    },
    ping: () => 'pong',
    fail: ({ name, message }) => {
      const err = new Error(message);
      if (name) err.name = name;
      throw err;
    },
    wait: (ms, ctx) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('done'), ms);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve('aborted');
        });
      }),
    hang: () => new Promise<void>(() => {}),
    sink: () => {},
    stream: async ({ count }) => {
      for (let i = 0; i < count; i++) {
        const data = new Float32Array([i]);
        port.emit('tick', { index: i, data }, [data.buffer]);
        await Promise.resolve();
      }
      return count;
    },
    push: ({ value }) => {
      total += value;
      port.emit('pushed', total);
    },
    reset: () => {
      total = 0;
    },
  };
}

function setup(options: Partial<WorkerClientOptions> = {}) {
  const workers: InProcessWorker[] = [];
  const factory = vi.fn(() => {
    const w = new InProcessWorker();
    exposeWorker<TestProtocol>(testHandlers, { scope: w.scope });
    workers.push(w);
    return w;
  });
  const client = createWorkerClient<TestProtocol>(factory, { name: 'test', ...options });
  return { client, factory, workers };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __clearWorkerCrashLogForTests();
});

describe('worker RPC calls', () => {
  it('matches responses to requests by id, whatever order they finish in', async () => {
    const { client, workers } = setup();
    const results = await Promise.all([client.call('echo', 'a'), client.call('ping'), client.call('echo', 'b')]);
    expect(results).toEqual(['a', 'pong', 'b']);
    const ids = workers[0]!.posted.map((p) => (p.message as { id: number }).id);
    expect(new Set(ids).size).toBe(3);
  });

  it('transfers the request and the reply buffers instead of copying them', async () => {
    const { client, workers } = setup();
    const values = new Float32Array([1, 2, 3]);
    const result = await client.call('double', { values }, { transfer: [values.buffer] });
    expect(values.length).toBe(0); // detached: moved to the worker
    expect(workers[0]!.posted[0]!.transfer).toEqual([values.buffer]);
    expect(Array.from(result.values)).toEqual([2, 4, 6]);
  });

  it('rejects with the error the handler threw, keeping message and name', async () => {
    const { client } = setup();
    await expect(client.call('fail', { message: 'no such file', name: 'ErrnoError' })).rejects.toMatchObject({
      message: 'no such file',
      name: 'ErrnoError',
    });
    const abort = await client.call('fail', { message: 'stopped', name: 'AbortError' }).catch((e: unknown) => e);
    expect(abort).toBeInstanceOf(DOMException);
    expect((abort as DOMException).name).toBe('AbortError');
  });

  it('rejects a call the worker has no handler for', async () => {
    const workers: InProcessWorker[] = [];
    const client = createWorkerClient<TestProtocol>(
      () => {
        const w = new InProcessWorker();
        exposeWorker<{ ping: { req: void; res: 'pong' } }>({ ping: () => 'pong' }, { scope: w.scope });
        workers.push(w);
        return w;
      },
      { name: 'test' },
    );
    await expect(client.call('echo', 'x')).rejects.toThrow('unknown worker call: echo');
    await expect(client.call('ping')).resolves.toBe('pong');
  });

  it('aborts: rejects at once with the reason and cancels the handler', async () => {
    const { client, workers } = setup();
    const controller = new AbortController();
    const call = client.call('wait', 10_000, { signal: controller.signal });
    await flushWorkerMessages(1);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await flushWorkerMessages();
    // The worker saw the cancel and its handler settled (its late answer is dropped).
    expect(workers[0]!.posted.map((p) => (p.message as { rpc: string }).rpc)).toEqual(['call', 'cancel']);
    expect(workers[0]!.emitted).toEqual([expect.objectContaining({ rpc: 'result', payload: 'aborted' })]);
  });

  it('never posts a call whose signal is already aborted', async () => {
    const { client, factory } = setup();
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(client.call('ping', undefined, { signal: controller.signal })).rejects.toThrow('gone');
    expect(factory).not.toHaveBeenCalled();
  });

  it('times out a call with WorkerTimeoutError and tells the worker', async () => {
    const { client, workers } = setup({ timeoutMs: 20 });
    const call = client.call('wait', 10_000);
    await expect(call).rejects.toBeInstanceOf(WorkerTimeoutError);
    await expect(call).rejects.toThrow('test worker: wait timed out after 20ms');
    await flushWorkerMessages();
    expect(workers[0]!.emitted).toEqual([expect.objectContaining({ rpc: 'result', payload: 'aborted' })]);
    // A per-call timeout overrides the client's.
    await expect(client.call('wait', 30, { timeoutMs: 0 })).resolves.toBe('done');
  });

  it('rejects a call whose message cannot be posted', async () => {
    const { client } = setup();
    await expect(client.call('sink', () => {})).rejects.toThrow();
    await expect(client.call('ping')).resolves.toBe('pong');
  });
});

describe('worker RPC lifecycle', () => {
  it('terminate() rejects every pending call with WorkerCrashedError and refuses later ones', async () => {
    const { client, workers } = setup();
    const a = client.call('hang');
    const b = client.call('wait', 10_000);
    client.terminate();
    const [ea, eb] = await Promise.all([a.catch((e: unknown) => e), b.catch((e: unknown) => e)]);
    expect(ea).toBeInstanceOf(WorkerCrashedError);
    expect(eb).toBe(ea);
    expect(ea).toMatchObject({ workerName: 'test', reason: 'terminated', message: 'test worker terminated' });
    expect(workers[0]!.terminated).toBe(true);
    expect(client.available).toBe(false);
    await expect(client.call('ping')).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(getWorkerCrashLog()).toEqual([]); // a terminate is not a crash
  });

  it('a crash rejects pending calls, reports it, and (by default) ends the client', async () => {
    const onCrash = vi.fn();
    const { client, workers, factory } = setup({ onCrash });
    const pending = client.call('hang');
    await flushWorkerMessages(1);
    workers[0]!.crash('memory access out of bounds');
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerCrashedError);
    expect(err).toMatchObject({ reason: 'crashed', message: 'test worker failed: memory access out of bounds' });
    expect(onCrash).toHaveBeenCalledWith(err);
    expect(workers[0]!.terminated).toBe(true);
    expect(client.failure).toBe(err);
    await expect(client.call('ping')).rejects.toBe(err);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(getWorkerCrashLog()).toEqual([
      expect.objectContaining({ worker: 'test', reason: 'crashed', message: 'test worker failed: memory access out of bounds' }),
    ]);
  });

  it("restart: 'on-crash' spawns a fresh worker for the next call", async () => {
    const { client, workers, factory } = setup({ restart: 'on-crash' });
    const pending = client.call('hang');
    workers[0]!.messageError();
    await expect(pending).rejects.toThrow('test worker failed: a message could not be deserialized');
    expect(client.available).toBe(true);
    await expect(client.call('ping')).resolves.toBe('pong');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(workers[1]!.terminated).toBe(false);
  });

  it('a factory that throws makes the client unavailable, with the reason', async () => {
    const client = createWorkerClient<TestProtocol>(
      () => {
        throw new Error('Worker is not defined');
      },
      { name: 'test' },
    );
    expect(client.start()).toBe(false);
    expect(client.available).toBe(false);
    expect(client.failure).toMatchObject({ reason: 'start-failed', message: 'test worker could not start: Worker is not defined' });
    await expect(client.call('ping')).rejects.toBeInstanceOf(WorkerCrashedError);
    client.notify('reset'); // dropped, not thrown
  });

  it('starts lazily, once', async () => {
    const { client, factory } = setup();
    expect(factory).not.toHaveBeenCalled();
    expect(client.start()).toBe(true);
    expect(client.start()).toBe(true);
    await client.call('ping');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('worker RPC stream channel', () => {
  it('delivers events in order, with their transfers, while a call runs', async () => {
    const { client } = setup();
    const ticks: Array<[number, number]> = [];
    const off = client.on('tick', ({ index, data }) => ticks.push([index, data[0]!]));
    await expect(client.call('stream', { count: 4 })).resolves.toBe(4);
    await flushWorkerMessages();
    expect(ticks).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    off();
    await client.call('stream', { count: 1 });
    await flushWorkerMessages();
    expect(ticks).toHaveLength(4);
  });

  it('runs notifications in post order and answers with events', async () => {
    const { client } = setup();
    const totals: number[] = [];
    client.on('pushed', (total) => totals.push(total));
    client.notify('push', { value: 1 });
    client.notify('push', { value: 2 });
    client.notify('reset');
    client.notify('push', { value: 5 });
    await flushWorkerMessages();
    expect(totals).toEqual([1, 3, 5]);
  });

  it('a throwing listener does not stop the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = setup();
    const seen: number[] = [];
    client.on('pushed', () => {
      throw new Error('listener bug');
    });
    client.on('pushed', (total) => seen.push(total));
    client.notify('push', { value: 7 });
    await flushWorkerMessages();
    expect(seen).toEqual([7]);
  });
});

describe('exposeWorker', () => {
  it('is a no-op outside a worker scope', () => {
    expect(exposeWorker<TestProtocol>(testHandlers)).toBeNull();
  });

  it('ignores messages that are not RPC envelopes', async () => {
    const w = new InProcessWorker();
    exposeWorker<TestProtocol>(testHandlers, { scope: w.scope });
    w.postMessage({ type: 'legacy' }, []);
    await flushWorkerMessages();
    expect(w.emitted).toEqual([]);
  });
});
