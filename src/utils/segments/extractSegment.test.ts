import { describe, expect, it, vi } from 'vitest';
import type { SegmentRequest } from '../../types';
import {
  BROWSER_DRIVE_LIMIT_BYTES,
  BROWSER_HARD_LIMIT_BYTES,
  BROWSER_LOCAL_LIMIT_BYTES,
  chooseExtractRoute,
  extractSegment,
  SegmentError,
  type RouteFacts,
} from './extractSegment';
import { driveItem, GB, job, makeClip, makeDeps } from './segments.test.helpers';

const MB = 1024 * 1024;
const facts = (overrides: Partial<RouteFacts>): RouteFacts => ({ kind: 'local', contaboConfigured: true, ...overrides });

describe('chooseExtractRoute', () => {
  it('cuts small local clips in the browser and never uploads them', () => {
    expect(chooseExtractRoute(facts({ sizeBytes: 5 * MB }))).toBe('browser');
    expect(chooseExtractRoute(facts({ sizeBytes: BROWSER_LOCAL_LIMIT_BYTES }))).toBe('browser');
    expect(chooseExtractRoute(facts({ sizeBytes: 5 * MB, contaboConfigured: false }))).toBe('browser');
  });

  it('sends a large local clip to the server only if the server already has a copy', () => {
    const big = BROWSER_LOCAL_LIMIT_BYTES + 1;
    expect(chooseExtractRoute(facts({ sizeBytes: big, hasRemoteCopy: true }))).toBe('contabo');
    expect(() => chooseExtractRoute(facts({ sizeBytes: big }))).toThrow(/too large for the browser/);
    expect(() => chooseExtractRoute(facts({ sizeBytes: big, hasRemoteCopy: true, contaboConfigured: false }))).toThrow(SegmentError);
  });

  it('honours an explicit backend choice for local clips', () => {
    expect(chooseExtractRoute(facts({ sizeBytes: 300 * MB }), 'browser')).toBe('browser');
    expect(() => chooseExtractRoute(facts({ sizeBytes: 2 * GB }), 'browser')).toThrow(/too large/);
    expect(chooseExtractRoute(facts({ sizeBytes: MB, hasRemoteCopy: true }), 'contabo')).toBe('contabo');
    expect(() => chooseExtractRoute(facts({ sizeBytes: MB }), 'contabo')).toThrow(/only exists in your browser/);
  });

  it('keeps multi-GB Drive files out of the browser by default', () => {
    const drive = (sizeBytes: number, extra: Partial<RouteFacts> = {}) => facts({ kind: 'drive', sizeBytes, ...extra });
    expect(chooseExtractRoute(drive(4 * GB))).toBe('contabo');
    expect(chooseExtractRoute(drive(BROWSER_DRIVE_LIMIT_BYTES + 1))).toBe('contabo');
    expect(chooseExtractRoute(drive(50 * MB))).toBe('browser');
    // Unknown size counts as large.
    expect(chooseExtractRoute(drive(0))).toBe('contabo');
    expect(() => chooseExtractRoute(drive(4 * GB, { contaboConfigured: false }))).toThrow(/storage endpoint/);
  });

  it('lets the user force the browser for a mid-size Drive file, but never a huge or unknown one', () => {
    const drive = (sizeBytes: number) => facts({ kind: 'drive', sizeBytes });
    expect(chooseExtractRoute(drive(500 * MB), 'browser')).toBe('browser');
    expect(() => chooseExtractRoute(drive(BROWSER_HARD_LIMIT_BYTES + 1), 'browser')).toThrow(/does not download files that large/);
    expect(() => chooseExtractRoute(drive(0), 'browser')).toThrow(/size/);
    expect(chooseExtractRoute(drive(MB), 'contabo')).toBe('contabo');
  });

  it('cuts remote URLs on the server only', () => {
    expect(chooseExtractRoute(facts({ kind: 'remote' }))).toBe('contabo');
    expect(() => chooseExtractRoute(facts({ kind: 'remote' }), 'browser')).toThrow(/cut on the server/);
    expect(() => chooseExtractRoute(facts({ kind: 'remote', contaboConfigured: false }))).toThrow(SegmentError);
  });
});

const localReq = (over: Partial<SegmentRequest> = {}): SegmentRequest => ({
  source: { kind: 'local', clipId: 'clip1' }, startSec: 10, endSec: 20, ...over,
});

describe('extractSegment (browser route)', () => {
  it('stream-copies and returns a blob URL with the measured length', async () => {
    const { deps } = makeDeps();
    const result = await extractSegment(localReq(), deps);
    expect(result).toMatchObject({ backend: 'browser', method: 'copy', url: 'blob:result', durationSec: 10, width: 640, height: 360 });
    expect(deps.cutInBrowser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.cutInBrowser).mock.calls[0].slice(1, 4)).toEqual([10, 20, 'copy']);
  });

  it('re-cuts exactly when the copy comes out the wrong length', async () => {
    const lengths = [14.2, 10.04];
    const { deps } = makeDeps({
      probeMedia: vi.fn(async () => ({ durationSec: lengths.shift()!, width: 640, height: 360 })),
    });
    const result = await extractSegment(localReq(), deps);
    expect(result.method).toBe('reencode');
    expect(vi.mocked(deps.cutInBrowser).mock.calls.map((c) => c[3])).toEqual(['copy', 'reencode']);
  });

  it('throws instead of returning a segment of the wrong length', async () => {
    const { deps } = makeDeps({ probeMedia: vi.fn(async () => ({ durationSec: 13 })) });
    await expect(extractSegment(localReq(), deps)).rejects.toThrow(/13\.00s but 10\.00s was requested/);
  });

  it('copies audio-only clips once, with no re-encode fallback', async () => {
    const wav = makeClip({ id: 'a', kind: 'audio', file: new File(['x'], 'a.wav', { type: 'audio/wav' }) });
    const { deps } = makeDeps({ clips: [wav], probeMedia: vi.fn(async () => ({ durationSec: 12 })) });
    await expect(extractSegment(localReq({ source: { kind: 'local', clipId: 'a' } }), deps)).rejects.toThrow(/requested/);
    expect(deps.cutInBrowser).toHaveBeenCalledTimes(1);
  });

  it('downloads small Drive files into the browser, with the token, and cuts there', async () => {
    const { deps, contabo } = makeDeps({ drive: [driveItem({ size: 40 * MB })] });
    const result = await extractSegment({ source: { kind: 'drive', fileId: 'drive1' }, startSec: 0, endSec: 10 }, deps);
    expect(result.backend).toBe('browser');
    expect(deps.fetchDriveFile).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'drive1' }), 'drive-token', undefined);
    expect(contabo.createJob).not.toHaveBeenCalled();
  });

  it('rejects ranges that make no sense before touching any media', async () => {
    const { deps } = makeDeps();
    for (const [s, e] of [[5, 5], [8, 2], [-1, 3], [NaN, 3], [0, 0.01]]) {
      await expect(extractSegment(localReq({ startSec: s, endSec: e }), deps)).rejects.toThrow(SegmentError);
    }
    await expect(extractSegment(localReq({ startSec: 50, endSec: 90 }), deps)).rejects.toThrow(/only 60\.00s long/);
    expect(deps.cutInBrowser).not.toHaveBeenCalled();
  });

  it('reports a clip that has left the timeline', async () => {
    const { deps } = makeDeps({ clips: [] });
    await expect(extractSegment(localReq(), deps)).rejects.toThrow(/no longer on the timeline/);
  });
});

describe('extractSegment (Contabo route)', () => {
  const driveReq: SegmentRequest = { source: { kind: 'drive', fileId: 'drive1' }, startSec: 100, endSec: 110 };

  it('hands a multi-GB Drive file to an extract job without downloading anything', async () => {
    const { deps, contabo } = makeDeps();
    const result = await extractSegment({ ...driveReq, outputName: 'part.mp4' }, deps);

    expect(contabo.createJob).toHaveBeenCalledWith({
      type: 'extract',
      source: { kind: 'drive', fileId: 'drive1', accessToken: 'drive-token', name: 'huge.mp4' },
      startSec: 100,
      endSec: 110,
      outputName: 'part.mp4',
    });
    expect(deps.fetchDriveFile).not.toHaveBeenCalled();
    expect(deps.cutInBrowser).not.toHaveBeenCalled();
    expect(result).toEqual({
      backend: 'contabo', method: 'copy', mediaName: 'out.mp4', url: 'https://s/clip-stacker/media/out.mp4',
      durationSec: 10, width: 1920, height: 1080, fps: 30,
    });
  });

  it('reads a large local clip from its remote library copy', async () => {
    const file = new File(['x'], 'big.mp4');
    Object.defineProperty(file, 'size', { value: 2 * GB });
    const big = makeClip({ file, remoteSourceUrl: 'https://s/clip-stacker/media/big.mp4' });
    const { deps, contabo } = makeDeps({ clips: [big] });
    await extractSegment(localReq(), deps);
    expect(contabo.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'remote', url: 'https://s/clip-stacker/media/big.mp4' } }),
    );
  });

  it('surfaces a failed job’s message', async () => {
    const { deps, contabo } = makeDeps();
    contabo.waitForJob.mockResolvedValue(job({ status: 'failed', error: 'Source refused access (HTTP 403) — for Drive, the token may have expired' }));
    await expect(extractSegment(driveReq, deps)).rejects.toThrow('token may have expired');
  });

  it('refuses a server result whose length is off', async () => {
    const { deps, contabo } = makeDeps();
    contabo.waitForJob.mockResolvedValue(
      job({ status: 'succeeded', result: { url: 'https://s/x.mp4', name: 'x.mp4', durationSec: 12.5 } }),
    );
    await expect(extractSegment(driveReq, deps)).rejects.toThrow(/12\.50s but 10\.00s was requested/);
  });

  it('cancels the server job when the user aborts', async () => {
    const controller = new AbortController();
    const { deps, contabo } = makeDeps();
    contabo.waitForJob.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(extractSegment(driveReq, deps, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(contabo.cancelJob).toHaveBeenCalledWith('j1');
  });

  it('treats a cancelled job as an abort, not an error message', async () => {
    const { deps, contabo } = makeDeps();
    contabo.waitForJob.mockResolvedValue(job({ status: 'cancelled' }));
    await expect(extractSegment(driveReq, deps)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('needs a storage endpoint', async () => {
    const { deps } = makeDeps({ contabo: () => null });
    await expect(extractSegment(driveReq, deps)).rejects.toThrow(/storage endpoint/);
  });

  it('streams job updates to the caller', async () => {
    const { deps, contabo } = makeDeps();
    const seen: string[] = [];
    contabo.waitForJob.mockImplementation(async (_id, o) => {
      o?.onUpdate?.(job({ status: 'running', stage: 'downloading' }));
      return job({ status: 'succeeded', result: { url: 'u', name: 'n', durationSec: 10 } });
    });
    await extractSegment(driveReq, deps, { onJob: (j) => seen.push(j.stage ?? j.status) });
    expect(seen).toEqual(['queued', 'downloading']);
  });
});
