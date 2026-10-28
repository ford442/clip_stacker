import { vi } from 'vitest';
import type { Clip, DriveMediaItem } from '../../types';
import type { ContaboJob } from '../project/contaboJobs';
import type { ProcessDeps } from './processSegment';

type ContaboApi = NonNullable<ReturnType<ProcessDeps['contabo']>>;

export function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip1',
    file: new File([new Uint8Array(1000)], 'clip1.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:clip1',
    title: 'Clip 1',
    kind: 'video',
    duration: 60,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

export const GB = 1024 * 1024 * 1024;

export function driveItem(overrides: Partial<DriveMediaItem> = {}): DriveMediaItem {
  return { kind: 'drive', fileId: 'drive1', name: 'huge.mp4', size: 4 * GB, mimeType: 'video/mp4', ...overrides };
}

export function job(overrides: Partial<ContaboJob> = {}): ContaboJob {
  return { jobId: 'j1', type: 'extract', status: 'queued', progress: 0, createdAt: 'x', updatedAt: 'x', ...overrides };
}

/** A fully mocked environment; override pieces per test. */
export function makeDeps(overrides: Partial<ProcessDeps> & { clips?: Clip[]; drive?: DriveMediaItem[] } = {}) {
  const { clips = [makeClip()], drive = [driveItem()], ...rest } = overrides;
  const contabo = {
    createJob: vi.fn<ContaboApi['createJob']>(async () => job()),
    waitForJob: vi.fn<ContaboApi['waitForJob']>(async () =>
      job({
        status: 'succeeded',
        progress: 1,
        result: { url: 'https://s/clip-stacker/media/out.mp4', name: 'out.mp4', durationSec: 10, width: 1920, height: 1080, fps: 30, method: 'copy' },
      }),
    ),
    cancelJob: vi.fn<ContaboApi['cancelJob']>(async () => job({ status: 'cancelled' })),
    deleteMedia: vi.fn<ContaboApi['deleteMedia']>(async () => {}),
  };
  const deps: ProcessDeps = {
    getClip: (id) => clips.find((c) => c.id === id),
    getDriveItem: (id) => drive.find((d) => d.fileId === id),
    getDriveToken: vi.fn(async () => 'drive-token'),
    contabo: () => contabo,
    cutInBrowser: vi.fn(async () => new Blob(['cut'], { type: 'video/mp4' })),
    probeMedia: vi.fn(async () => ({ durationSec: 10, width: 640, height: 360, hasAudio: true })),
    fetchDriveFile: vi.fn(async (item) => new File(['x'], item.name, { type: item.mimeType })),
    makeObjectUrl: vi.fn(() => 'blob:result'),
    fetchBlob: vi.fn(async () => new Blob(['seg'], { type: 'video/mp4' })),
    rifeOnHuggingFace: vi.fn(async () => new Blob(['rife'], { type: 'video/mp4' })),
    muxSegmentAudio: vi.fn(async () => new Blob(['muxed'], { type: 'video/mp4' })),
    ...rest,
  };
  return { deps, contabo };
}
