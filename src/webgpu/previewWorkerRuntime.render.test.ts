import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPreviewCompositionPlan } from '../composition/previewComposition';
import { PreviewWorkerRuntime, type RenderTimelineParams } from './previewWorkerRuntime';
import type { CapturedFrame, FrameRequest, PreviewWorkerProtocol } from './previewWorkerProtocol';
import type { WebGpuProbeResult } from './webgpuProbe';
import { InProcessWorker, flushWorkerMessages } from '../workers/inProcessWorker.test.helpers';
import { WorkerCrashedError, exposeWorker, type WorkerHandlers } from '../workers/workerRpc';

const PROBE_OK: WebGpuProbeResult = { ok: true, browser: 'test', reason: '', adapter: null };

const PLAN = buildPreviewCompositionPlan([], [], [], [], undefined, 0);

type RenderOnly = Pick<PreviewWorkerProtocol, 'configure' | 'init' | 'render' | 'frames-ready' | 'need-frames'>;

/**
 * A preview worker whose `render` asks main for `requests` (when any) over
 * the stream channel, the way `preview.worker.ts` does for layers its
 * decoder cannot serve, then answers with a plan.
 */
class FakePreviewWorker extends InProcessWorker {
  static last: FakePreviewWorker | null = null;
  requests: FrameRequest[] = [];
  readonly framesSeen: Array<CapturedFrame[]> = [];
  readonly cancelled: number[] = [];

  constructor() {
    super();
    FakePreviewWorker.last = this;
    const waiting = new Map<number, (frames: CapturedFrame[]) => void>();
    exposeWorker<RenderOnly>(
      (port): WorkerHandlers<RenderOnly> => ({
        configure: () => ({ webgpuAvailable: true, webgpuProbe: PROBE_OK }),
        init: () => {},
        render: async ({ renderId }, ctx) => {
          if (this.requests.length > 0) {
            const frames = await new Promise<CapturedFrame[] | null>((resolve) => {
              waiting.set(renderId, resolve);
              ctx.signal.addEventListener('abort', () => resolve(null));
              port.emit('need-frames', { renderId, requests: this.requests });
            });
            if (!frames) {
              this.cancelled.push(renderId);
              return null;
            }
            this.framesSeen.push(frames);
          }
          return { plan: PLAN, frameSources: { decoder: 1, element: this.requests.length } };
        },
        'frames-ready': ({ renderId, frames }) => waiting.get(renderId)?.(frames),
      }),
      { scope: this.scope },
    );
  }
}

const PARAMS: RenderTimelineParams = {
  clips: [],
  clipGroups: [],
  transitions: [],
  textOverlays: [],
  exportSettings: undefined,
  globalTime: 1,
};

async function createRuntime(): Promise<PreviewWorkerRuntime> {
  const canvas = document.createElement('canvas');
  canvas.transferControlToOffscreen = () => new OffscreenCanvas(1, 1);
  const runtime = await PreviewWorkerRuntime.create(canvas, false, () => new FakePreviewWorker());
  if (!runtime) throw new Error('runtime did not start');
  return runtime;
}

describe('PreviewWorkerRuntime renders', () => {
  beforeEach(() => {
    // Transferable through structuredClone, like the real OffscreenCanvas.
    vi.stubGlobal('OffscreenCanvas', ArrayBuffer);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers need-frames with frames-ready and resolves with the plan', async () => {
    const runtime = await createRuntime();
    const worker = FakePreviewWorker.last!;
    worker.requests = [{ clipId: 'still', role: 'base', sourceTime: 0.5 }];
    const capture = vi.fn(async (): Promise<CapturedFrame[]> => []);

    await expect(runtime.renderTimeline(PARAMS, capture)).resolves.toEqual(PLAN);
    expect(capture).toHaveBeenCalledWith(worker.requests);
    expect(worker.framesSeen).toEqual([[]]);
    expect(worker.sentPayloads<{ renderId: number }>('notify', 'frames-ready')).toEqual([{ renderId: 1, frames: [] }]);
    expect(runtime.frameSources).toEqual({ decoder: 1, element: 1 });
    runtime.destroy();
  });

  it('never round-trips when the worker needs no frames', async () => {
    const runtime = await createRuntime();
    const capture = vi.fn(async (): Promise<CapturedFrame[]> => []);
    await expect(runtime.renderTimeline(PARAMS, capture)).resolves.toEqual(PLAN);
    expect(capture).not.toHaveBeenCalled();
    runtime.destroy();
  });

  it('a newer render cancels the one in flight, which resolves null', async () => {
    const runtime = await createRuntime();
    const worker = FakePreviewWorker.last!;
    worker.requests = [{ clipId: 'still', role: 'base', sourceTime: 0 }];
    let release: () => void = () => {};
    const slow = (): Promise<CapturedFrame[]> => new Promise((resolve) => (release = () => resolve([])));
    const first = runtime.renderTimeline(PARAMS, slow);
    await flushWorkerMessages();
    const second = runtime.renderTimeline(PARAMS, async () => []);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual(PLAN);
    release();
    await flushWorkerMessages();
    expect(worker.cancelled).toEqual([1]);
    // The superseded capture is dropped on main, never sent.
    expect(worker.sentPayloads<{ renderId: number }>('notify', 'frames-ready').map((p) => p.renderId)).toEqual([2]);
    runtime.destroy();
  });

  it('rejects the render when capture fails', async () => {
    const runtime = await createRuntime();
    FakePreviewWorker.last!.requests = [{ clipId: 'still', role: 'base', sourceTime: 0 }];
    await expect(
      runtime.renderTimeline(PARAMS, async () => {
        throw new Error('seek failed');
      }),
    ).rejects.toThrow('seek failed');
    runtime.destroy();
  });

  it('destroy() rejects a pending render with WorkerCrashedError', async () => {
    const runtime = await createRuntime();
    FakePreviewWorker.last!.requests = [{ clipId: 'still', role: 'base', sourceTime: 0 }];
    const pending = runtime.renderTimeline(PARAMS, () => new Promise<CapturedFrame[]>(() => {}));
    await flushWorkerMessages();
    runtime.destroy();
    await expect(pending).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(FakePreviewWorker.last!.terminated).toBe(true);
  });
});
