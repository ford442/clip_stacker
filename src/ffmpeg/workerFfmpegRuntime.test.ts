import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FfmpegManager } from './ffmpegManager';
import { transferableBytes, type FfmpegWorkerProtocol } from './ffmpegWorkerProtocol';
import { WorkerFfmpegRuntime } from './workerFfmpegRuntime';
import { InProcessWorker } from '../workers/inProcessWorker.test.helpers';
import { exposeWorker, withTransfer, type WorkerPort } from '../workers/workerRpc';

type FfmpegCall = { method: string; payload: Record<string, unknown>; transfer: Transferable[] };

/**
 * A Worker double: serves the FFmpeg protocol like ffmpeg.worker.ts (through
 * the real worker RPC, in-process), records what was called (and
 * transferred), and can crash on demand.
 */
class FakeWorker extends InProcessWorker {
  static instances: FakeWorker[] = [];
  readFileResult: Uint8Array = new Uint8Array([9, 8, 7]);
  /** The bytes the worker received per writeFile. */
  readonly written = new Map<string, Uint8Array | string>();
  private readonly port: WorkerPort<FfmpegWorkerProtocol> | null;

  constructor(
    readonly url?: URL | string,
    readonly options?: WorkerOptions,
  ) {
    super();
    FakeWorker.instances.push(this);
    this.port = exposeWorker<FfmpegWorkerProtocol>(
      {
        load: () => {},
        exec: () => 0,
        writeFile: ({ name, data }) => {
          this.written.set(name, data);
        },
        readFile: () => {
          const bytes = this.readFileResult.slice();
          return withTransfer<Uint8Array | string>(bytes, [bytes.buffer]);
        },
        deleteFile: () => true,
        listDir: () => [],
      },
      { scope: this.scope },
    );
  }

  get calls(): FfmpegCall[] {
    return this.posted.flatMap(({ message, transfer }) => {
      const m = message as { rpc: string; method: string; payload: Record<string, unknown> };
      return m.rpc === 'call' ? [{ method: m.method, payload: m.payload, transfer }] : [];
    });
  }

  log(message: string): void {
    this.port?.emit('log', { message });
  }
}

function makeRuntime(options: ConstructorParameters<typeof WorkerFfmpegRuntime>[0] = {}) {
  let worker: FakeWorker | null = null;
  const runtime = new WorkerFfmpegRuntime({
    ...options,
    createWorker: () => {
      worker = new FakeWorker();
      return worker;
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
    const buffer = data.buffer;
    await runtime.writeFile('in.mp4', data);

    const { method, payload, transfer } = worker().calls[0]!;
    expect(method).toBe('writeFile');
    expect(payload).toMatchObject({ name: 'in.mp4' });
    expect(transfer).toEqual([buffer]);
    expect(transfer[0]).toBe(buffer);
    expect(data.byteLength).toBe(0); // moved, not copied
    expect(Array.from(worker().written.get('in.mp4') as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it('copies a view over part of a buffer, so the rest is not shipped or detached', async () => {
    const { runtime, worker } = makeRuntime();
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = backing.subarray(2, 4);
    await runtime.writeFile('part.bin', view);

    const { transfer } = worker().calls[0]!;
    expect(Array.from(worker().written.get('part.bin') as Uint8Array)).toEqual([2, 3]);
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).not.toBe(backing.buffer);
    expect(backing.byteLength).toBe(6);
    expect(view.byteLength).toBe(2);
  });

  it('posts strings with no transfer list', async () => {
    const { runtime, worker } = makeRuntime();
    await runtime.writeFile('list.txt', "file 'a.mp4'");
    expect(worker().calls[0]!.transfer).toEqual([]);
    expect(worker().written.get('list.txt')).toBe("file 'a.mp4'");
  });

  it('returns the transferred readFile array', async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.readFile('out.mp4')).resolves.toEqual(new Uint8Array([9, 8, 7]));
  });

  it('sends the resolved core URLs on load', async () => {
    const { runtime, worker } = makeRuntime();
    await runtime.load(URLS);
    expect(worker().calls[0]).toMatchObject({ method: 'load', payload: { urls: URLS } });
  });

  it('forwards worker log lines', async () => {
    const onLog = vi.fn();
    const { runtime, worker } = makeRuntime({ onLog });
    await runtime.load(URLS);
    worker().log('frame=  10 time=00:00:01.00');
    await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith('frame=  10 time=00:00:01.00'));
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
    worker().crash('Uncaught RuntimeError: memory access out of bounds');

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
    expect(firstWorker.calls[0]).toMatchObject({
      method: 'load',
      payload: {
        urls: {
        coreURL: 'http://localhost:3000/ffmpeg-core/ffmpeg-core.js',
          wasmURL: 'http://localhost:3000/ffmpeg-core/ffmpeg-core.wasm',
        },
      },
    });
    manager.markFontLoaded('roboto.ttf');

    firstWorker.crash('Uncaught RuntimeError: memory access out of bounds');
    expect(firstWorker.terminated).toBe(true);
    expect(manager.getInstance()).toBeNull();
    expect(manager.isFontLoaded('roboto.ttf')).toBe(false);
    expect(manager.getLastLogs(1)[0]).toContain('FFmpeg will reload on next use');

    const second = await manager.ensureFfmpeg(vi.fn());
    expect(second).not.toBe(first);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.calls[0]!.method).toBe('load');
    await manager.reset();
    expect(FakeWorker.instances[1]!.terminated).toBe(true);
  });
});
