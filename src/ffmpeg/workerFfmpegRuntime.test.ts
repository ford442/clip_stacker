import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FfmpegManager } from './ffmpegManager';
import { transferableBytes, type WorkerRpcRequest } from './ffmpegWorkerProtocol';
import { WorkerFfmpegRuntime } from './workerFfmpegRuntime';

/**
 * A Worker double: records what was posted (and transferred), answers RPCs
 * like ffmpeg.worker.ts on the next macrotask, and can crash on demand.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: { request: WorkerRpcRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  /** Leave requests unanswered (to test rejection of pending calls). */
  hold = false;
  readFileResult: Uint8Array = new Uint8Array([9, 8, 7]);

  constructor(
    readonly url?: URL | string,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(request: WorkerRpcRequest, transfer: Transferable[] = []): void {
    this.posted.push({ request, transfer });
    if (this.hold) return;
    setTimeout(() => {
      if (this.terminated) return;
      const result =
        request.type === 'readFile'
          ? this.readFileResult
          : request.type === 'listDir'
            ? []
            : undefined;
      this.onmessage?.({ data: { id: request.id, ok: true, result } } as MessageEvent);
    }, 0);
  }

  log(message: string): void {
    this.onmessage?.({ data: { type: 'log', message } } as MessageEvent);
  }

  crash(message = 'Uncaught RuntimeError: memory access out of bounds'): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function makeRuntime(options: ConstructorParameters<typeof WorkerFfmpegRuntime>[0] = {}) {
  let worker: FakeWorker | null = null;
  const runtime = new WorkerFfmpegRuntime({
    ...options,
    createWorker: () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    },
  });
  return { runtime, worker: () => worker! };
}

const URLS = {
  coreURL: 'http://localhost:3000/ffmpeg-core/ffmpeg-core.js',
  wasmURL: 'http://localhost:3000/ffmpeg-core/ffmpeg-core.wasm',
};

beforeEach(() => {
  FakeWorker.instances.length = 0;
});

describe('WorkerFfmpegRuntime transfers', () => {
  it('transfers writeFile bytes without copying them', async () => {
    const { runtime, worker } = makeRuntime();
    const data = new Uint8Array([1, 2, 3, 4]);
    await runtime.writeFile('in.mp4', data);

    const { request, transfer } = worker().posted[0]!;
    expect(request).toMatchObject({ type: 'writeFile', name: 'in.mp4' });
    expect((request as { data: Uint8Array }).data).toBe(data);
    expect(transfer).toEqual([data.buffer]);
    expect(transfer[0]).toBe(data.buffer);
  });

  it('copies a view over part of a buffer, so the rest is not shipped or detached', async () => {
    const { runtime, worker } = makeRuntime();
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = backing.subarray(2, 4);
    await runtime.writeFile('part.bin', view);

    const { request, transfer } = worker().posted[0]!;
    const sent = (request as { data: Uint8Array }).data;
    expect(sent).not.toBe(view);
    expect(Array.from(sent)).toEqual([2, 3]);
    expect(transfer).toEqual([sent.buffer]);
    expect(transfer[0]).not.toBe(backing.buffer);
  });

  it('posts strings with no transfer list', async () => {
    const { runtime, worker } = makeRuntime();
    await runtime.writeFile('list.txt', "file 'a.mp4'");
    expect(worker().posted[0]!.transfer).toEqual([]);
  });

  it('returns the transferred readFile array as-is', async () => {
    const { runtime, worker } = makeRuntime();
    const pending = runtime.readFile('out.mp4');
    const expected = worker().readFileResult;
    await expect(pending).resolves.toBe(expected);
  });

  it('sends the resolved core URLs on load', async () => {
    const { runtime, worker } = makeRuntime();
    await runtime.load(URLS);
    expect(worker().posted[0]!.request).toEqual({ id: 1, type: 'load', urls: URLS });
  });

  it('forwards worker log lines', async () => {
    const onLog = vi.fn();
    const { runtime, worker } = makeRuntime({ onLog });
    await runtime.load(URLS);
    worker().log('frame=  10 time=00:00:01.00');
    expect(onLog).toHaveBeenCalledWith('frame=  10 time=00:00:01.00');
  });
});

describe('transferableBytes', () => {
  it('shares a SharedArrayBuffer view instead of transferring it', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    expect(transferableBytes(shared)).toEqual({ bytes: shared, transfer: [] });
  });
});

describe('WorkerFfmpegRuntime worker failure', () => {
  it('rejects pending calls, terminates the worker and refuses to reuse it', async () => {
    const onWorkerLost = vi.fn();
    const { runtime, worker } = makeRuntime({ onWorkerLost });
    await runtime.load(URLS);
    worker().hold = true;

    const pending = runtime.exec(['-i', 'in.mp4', 'out.mp4']);
    worker().crash();

    await expect(pending).rejects.toThrow('memory access out of bounds');
    expect(worker().terminated).toBe(true);
    expect(onWorkerLost).toHaveBeenCalledWith(expect.any(Error));

    // A dead runtime never spawns an unloaded worker behind the caller's back.
    await expect(runtime.exec(['-version'])).rejects.toThrow('memory access out of bounds');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('terminate() kills the worker and rejects what is in flight', async () => {
    const { runtime, worker } = makeRuntime();
    await runtime.load(URLS);
    worker().hold = true;
    const pending = runtime.listDir('/');

    runtime.terminate();

    await expect(pending).rejects.toThrow('FFmpeg worker terminated');
    expect(worker().terminated).toBe(true);
  });
});

describe('FfmpegManager with the worker runtime', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new Response(null, {
          status: 200,
          headers: {
            'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('spawns and loads a fresh worker on the next call after the loaded one crashes', async () => {
    const manager = new FfmpegManager({ useWorker: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = await manager.ensureFfmpeg(vi.fn());
    expect(FakeWorker.instances).toHaveLength(1);
    const firstWorker = FakeWorker.instances[0]!;
    expect(firstWorker.url?.toString()).toContain('ffmpeg.worker');
    expect(firstWorker.options).toEqual({ type: 'module' });
    expect(firstWorker.posted[0]!.request).toMatchObject({
      type: 'load',
      urls: {
        coreURL: 'http://localhost:3000/ffmpeg-core/ffmpeg-core.js',
        wasmURL: 'http://localhost:3000/ffmpeg-core/ffmpeg-core.wasm',
      },
    });
    manager.markFontLoaded('roboto.ttf');

    firstWorker.crash();
    expect(firstWorker.terminated).toBe(true);
    expect(manager.getInstance()).toBeNull();
    expect(manager.isFontLoaded('roboto.ttf')).toBe(false);
    expect(manager.getLastLogs(1)[0]).toContain('FFmpeg will reload on next use');

    const second = await manager.ensureFfmpeg(vi.fn());
    expect(second).not.toBe(first);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.posted[0]!.request.type).toBe('load');
    await manager.reset();
    expect(FakeWorker.instances[1]!.terminated).toBe(true);
  });
});
