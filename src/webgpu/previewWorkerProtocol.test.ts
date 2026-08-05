import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import {
  frameCaptureGroupKey,
  groupFrameRequestsByMedia,
  toWorkerClip,
  PREVIEW_WORKER_INIT_TIMEOUT_MS,
  type FrameRequest,
} from './previewWorkerProtocol';
import { isCanvasTransferred } from './previewWorkerRuntime';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    file: new File([], 'clip-1.mp4'),
    objectUrl: 'blob:clip-1',
    title: 'Clip 1',
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('previewWorkerProtocol', () => {
  it('strips non-serializable File from WorkerClip', () => {
    const clip = makeClip({ title: 'A', layerIndex: 2 });
    const workerClip = toWorkerClip(clip);
    expect(workerClip).not.toHaveProperty('file');
    expect(workerClip.id).toBe('clip-1');
    expect(workerClip.title).toBe('A');
    expect(workerClip.objectUrl).toBe('blob:clip-1');
    expect(workerClip.layerIndex).toBe(2);
    // Original is untouched.
    expect(clip.file).toBeInstanceOf(File);
  });

  it('groups frame requests by media element for parallel capture', () => {
    const requests: FrameRequest[] = [
      { clipId: 'a', role: 'base', sourceTime: 0 },
      { clipId: 'b', role: 'base', sourceTime: 1 },
      { clipId: 'a', role: 'outgoing', sourceTime: 2 },
      { clipId: 'c', role: 'base', sourceTime: 0, mediaObjectUrl: 'blob:morph' },
      { clipId: 'c', role: 'base', sourceTime: 1 },
    ];

    const groups = groupFrameRequestsByMedia(requests);
    expect(groups).toHaveLength(4);
    expect(groups[0].map((r) => r.role)).toEqual(['base', 'outgoing']);
    expect(groups[0].every((r) => r.clipId === 'a')).toBe(true);
    expect(groups[1].map((r) => r.clipId)).toEqual(['b']);
    expect(frameCaptureGroupKey(requests[3])).toBe('c::blob:morph');
    expect(frameCaptureGroupKey(requests[4])).toBe('c');
  });

  it('exports a finite worker init timeout', () => {
    expect(PREVIEW_WORKER_INIT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('isCanvasTransferred', () => {
  it('returns false for a fresh canvas', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    expect(isCanvasTransferred(canvas)).toBe(false);
  });
});
