import { describe, expect, it, vi } from 'vitest';
import {
  FfmpegCoreHost,
  buildMainScriptUrl,
  type FfmpegCoreFactory,
  type FfmpegCoreModule,
} from './ffmpegCoreHost';
import { describeWorkerError, handleFfmpegWorkerRequest } from './ffmpegWorkerHandler';
import type { DistributiveOmit, WorkerRpcRequest } from './ffmpegWorkerProtocol';

class FakeErrnoError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super('FS error');
    this.name = 'ErrnoError';
    this.errno = errno;
  }
}

/** An in-memory stand-in for the Emscripten module's pre-js API + MEMFS. */
function fakeCore() {
  const files = new Map<string, Uint8Array>();
  let logger: (log: { type: string; message: string }) => void = () => {};
  const core = {
    ret: -1,
    exec: vi.fn((...args: string[]) => {
      logger({ type: 'stderr', message: `ran ${args.join(' ')}` });
      core.ret = args.includes('--fail') ? 1 : 0;
      return core.ret;
    }),
    reset: vi.fn(() => {
      core.ret = -1;
    }),
    setLogger: vi.fn((next: typeof logger) => {
      logger = next;
    }),
    setTimeout: vi.fn(),
    PThread: { terminateAllThreads: vi.fn() },
    FS: {
      writeFile: vi.fn((path: string, data: Uint8Array | string) => {
        files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
      }),
      readFile: vi.fn((path: string) => {
        const data = files.get(path);
        if (!data) throw new FakeErrnoError(44);
        return data.slice();
      }),
      unlink: vi.fn((path: string) => {
        if (!files.delete(path)) throw new FakeErrnoError(44);
      }),
      readdir: vi.fn(() => ['.', '..', ...files.keys()]),
      stat: vi.fn((path: string) => ({ mode: path.endsWith('/.') || path.endsWith('/..') ? 0o40000 : 0o100000 })),
      isDir: vi.fn((mode: number) => (mode & 0o170000) === 0o40000),
    },
  };
  return core;
}

function setup() {
  const core = fakeCore();
  const factory = vi.fn<FfmpegCoreFactory>(async () => core as unknown as FfmpegCoreModule);
  const importCore = vi.fn(async () => factory);
  const onLog = vi.fn();
  const host = new FfmpegCoreHost(onLog, importCore);
  let nextId = 0;
  const send = (request: DistributiveOmit<WorkerRpcRequest, 'id'>) =>
    handleFfmpegWorkerRequest(host, { id: ++nextId, ...request } as WorkerRpcRequest);
  return { core, factory, importCore, onLog, host, send };
}

const URLS = {
  coreURL: 'http://localhost:3000/ffmpeg-core-mt/ffmpeg-core.js',
  wasmURL: 'http://localhost:3000/ffmpeg-core-mt/ffmpeg-core.wasm',
  workerURL: 'http://localhost:3000/ffmpeg-core-mt/ffmpeg-core.worker.js',
};

describe('FfmpegCoreHost + worker handler', () => {
  it('imports the core by URL and hands it the wasm / worker URLs on mainScriptUrlOrBlob', async () => {
    const { importCore, factory, send } = setup();
    const reply = await send({ type: 'load', urls: URLS });

    expect(reply.response).toEqual({ id: 1, ok: true, result: undefined });
    expect(importCore).toHaveBeenCalledWith(URLS.coreURL);
    const [{ mainScriptUrlOrBlob }] = factory.mock.calls[0]!;
    expect(mainScriptUrlOrBlob).toBe(buildMainScriptUrl(URLS));
    // The core's locateFile decodes this fragment (ffmpeg-core.js pre-js).
    const [script, fragment] = mainScriptUrlOrBlob.split('#');
    expect(script).toBe(URLS.coreURL);
    expect(JSON.parse(atob(fragment!))).toEqual({
      wasmURL: URLS.wasmURL,
      workerURL: URLS.workerURL,
    });
  });

  it('leaves workerURL out for the single-threaded core', () => {
    const url = buildMainScriptUrl({ coreURL: 'blob:core', wasmURL: 'blob:wasm' });
    expect(JSON.parse(atob(url.split('#')[1]!))).toEqual({ wasmURL: 'blob:wasm' });
  });

  it('forwards core log lines', async () => {
    const { onLog, send } = setup();
    await send({ type: 'load', urls: URLS });
    await send({ type: 'exec', args: ['-i', 'a.mp4', 'b.mp4'] });
    expect(onLog).toHaveBeenCalledWith('ran -i a.mp4 b.mp4');
  });

  it('runs exec, returns the exit code and resets the core', async () => {
    const { core, send } = setup();
    await send({ type: 'load', urls: URLS });

    const ok = await send({ type: 'exec', args: ['-version'] });
    expect(ok.response).toEqual({ id: 2, ok: true, result: 0 });
    expect(core.setTimeout).toHaveBeenCalledWith(-1);
    expect(core.reset).toHaveBeenCalledTimes(1);

    const failed = await send({ type: 'exec', args: ['--fail'] });
    expect(failed.response).toEqual({ id: 3, ok: false, error: 'FFmpeg exited with code 1' });
    expect(core.reset).toHaveBeenCalledTimes(2);
  });

  it('transfers the array FS.readFile returns, without another copy', async () => {
    const { core, send } = setup();
    await send({ type: 'load', urls: URLS });
    await send({ type: 'writeFile', name: 'out.mp4', data: new Uint8Array([1, 2, 3]) });

    const reply = await send({ type: 'readFile', name: 'out.mp4' });
    const returned = core.FS.readFile.mock.results[0]!.value as Uint8Array;
    expect(reply.response).toEqual({ id: 3, ok: true, result: returned });
    expect((reply.response as { result: Uint8Array }).result).toBe(returned);
    expect(reply.transfer).toEqual([returned.buffer]);
  });

  it('writes, lists and deletes VFS files', async () => {
    const { send } = setup();
    await send({ type: 'load', urls: URLS });
    await send({ type: 'writeFile', name: 'list.txt', data: "file 'a.mp4'" });

    const listed = await send({ type: 'listDir', path: '/' });
    expect(listed.response).toEqual({
      id: 3,
      ok: true,
      result: [
        { name: '.', isDir: true },
        { name: '..', isDir: true },
        { name: 'list.txt', isDir: false },
      ],
    });
    expect((await send({ type: 'deleteFile', name: 'list.txt' })).response).toEqual({
      id: 4,
      ok: true,
      result: true,
    });
  });

  it('reports Emscripten FS errors with their name and errno', async () => {
    const { send } = setup();
    await send({ type: 'load', urls: URLS });
    const reply = await send({ type: 'readFile', name: 'missing.mp4' });
    expect(reply.response).toEqual({
      id: 2,
      ok: false,
      error: 'ErrnoError: FS error (errno 44)',
    });
    expect(reply.transfer).toEqual([]);
  });

  it('refuses work before load', async () => {
    const { send } = setup();
    expect((await send({ type: 'exec', args: [] })).response).toEqual({
      id: 1,
      ok: false,
      error: 'FFmpeg is not loaded',
    });
  });

  it('reports an import failure as a load error', async () => {
    const host = new FfmpegCoreHost(vi.fn(), async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const reply = await handleFfmpegWorkerRequest(host, { id: 7, type: 'load', urls: URLS });
    expect(reply.response).toEqual({
      id: 7,
      ok: false,
      error: 'TypeError: Failed to fetch dynamically imported module',
    });
  });

  it('cancels a load that terminate() overtook, and stops its threads', async () => {
    const core = fakeCore();
    let finish: (value: FfmpegCoreModule) => void = () => {};
    const factory: FfmpegCoreFactory = () =>
      new Promise<FfmpegCoreModule>((resolve) => {
        finish = resolve;
      });
    const host = new FfmpegCoreHost(vi.fn(), async () => factory);

    const loading = host.load(URLS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.terminate();
    finish(core as unknown as FfmpegCoreModule);

    await expect(loading).rejects.toThrow('FFmpeg load cancelled');
    expect(core.PThread.terminateAllThreads).toHaveBeenCalled();
    expect(() => host.exec([])).toThrow('FFmpeg is not loaded');
  });
});

describe('describeWorkerError', () => {
  it('passes plain Error messages and strings through', () => {
    expect(describeWorkerError(new Error('boom'))).toBe('boom');
    expect(describeWorkerError('Aborted()')).toBe('Aborted()');
  });
});
