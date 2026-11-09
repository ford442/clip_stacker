import { describe, expect, it, vi } from 'vitest';
import type { SegmentRequest } from '../../types';
import { SegmentError } from './extractSegment';
import { importProcessedSegment, PROCESSING_BACKENDS, processSegment } from './processSegment';
import { job, makeDeps } from './segments.test.helpers';

const request: SegmentRequest = { source: { kind: 'local', clipId: 'clip1' }, startSec: 10, endSec: 20 };
const driveRequest: SegmentRequest = { source: { kind: 'drive', fileId: 'drive1' }, startSec: 100, endSec: 110 };

describe('PROCESSING_BACKENDS', () => {
  it('offers the four backends from the spec, in order', () => {
    expect(PROCESSING_BACKENDS.map((b) => b.label)).toEqual(['Browser FFmpeg', 'HF RIFE Space', 'Colab (manual)', 'Contabo job']);
  });

  it('only offers length-preserving operations (no boomerang)', () => {
    const ops = new Set(PROCESSING_BACKENDS.flatMap((b) => b.operations));
    expect([...ops].sort()).toEqual(['extract', 'rife2', 'rife4']);
  });
});

describe('processSegment', () => {
  it('browser backend cuts in the browser and nothing else', async () => {
    const { deps, contabo } = makeDeps();
    const result = await processSegment(request, deps, { backend: 'browser', operation: 'extract' });
    expect(result.backend).toBe('browser');
    expect(contabo.createJob).not.toHaveBeenCalled();
    expect(deps.rifeOnHuggingFace).not.toHaveBeenCalled();
  });

  it('refuses an operation the backend cannot do', async () => {
    const { deps } = makeDeps();
    await expect(processSegment(request, deps, { backend: 'browser', operation: 'rife2' })).rejects.toThrow(/cannot do/);
    await expect(processSegment(request, deps, { backend: 'hf-rife', operation: 'extract' })).rejects.toThrow(/cannot do/);
  });

  it('colab is manual', async () => {
    const { deps } = makeDeps();
    await expect(processSegment(request, deps, { backend: 'colab', operation: 'rife2' })).rejects.toThrow(/manual/);
  });

  describe('contabo', () => {
    it('extract runs an extract job', async () => {
      const { deps, contabo } = makeDeps();
      await processSegment(driveRequest, deps, { backend: 'contabo', operation: 'extract' });
      expect(contabo.createJob).toHaveBeenCalledWith(expect.objectContaining({ type: 'extract' }));
    });

    it('rife runs a length-preserving rife job on the Drive source', async () => {
      const { deps, contabo } = makeDeps();
      const result = await processSegment({ ...driveRequest, outputName: 'smooth.mp4' }, deps, { backend: 'contabo', operation: 'rife4' });
      expect(contabo.createJob).toHaveBeenCalledWith({
        type: 'rife',
        source: { kind: 'drive', fileId: 'drive1', accessToken: 'drive-token', name: 'huge.mp4' },
        startSec: 100,
        endSec: 110,
        params: { multiplier: 4, mode: 'interpolation' },
        outputName: 'smooth.mp4',
      });
      expect(result.backend).toBe('contabo');
    });

    it('rejects a rife result of the wrong length', async () => {
      const { deps, contabo } = makeDeps();
      contabo.waitForJob.mockResolvedValue(job({ status: 'succeeded', result: { url: 'u', name: 'n', durationSec: 20 } }));
      await expect(processSegment(driveRequest, deps, { backend: 'contabo', operation: 'rife2' })).rejects.toThrow(/20\.00s but 10\.00s/);
    });

    it('a local clip needs a library copy for the server to read', async () => {
      const { deps } = makeDeps();
      await expect(processSegment(request, deps, { backend: 'contabo', operation: 'rife2' })).rejects.toThrow(/no copy in the remote library/);
    });
  });

  describe('hf-rife', () => {
    it('cuts, interpolates, checks the raw length, restores audio and checks again', async () => {
      const order: string[] = [];
      const { deps } = makeDeps({
        cutInBrowser: vi.fn(async () => { order.push('cut'); return new Blob(['cut'], { type: 'video/mp4' }); }),
        rifeOnHuggingFace: vi.fn(async () => { order.push('rife'); return new Blob(['rife'], { type: 'video/mp4' }); }),
        muxSegmentAudio: vi.fn(async () => { order.push('mux'); return new Blob(['mux'], { type: 'video/mp4' }); }),
      });
      const result = await processSegment(request, deps, { backend: 'hf-rife', operation: 'rife2' });
      expect(order).toEqual(['cut', 'rife', 'mux']);
      expect(vi.mocked(deps.rifeOnHuggingFace).mock.calls[0][1]).toBe(2);
      expect(result).toMatchObject({ backend: 'hf-rife', method: 'rife', url: 'blob:result', durationSec: 10 });
    });

    it('catches a short RIFE video before the segment audio can pad it to length', async () => {
      const probes = [10, 10, 4]; // the cut, the segment as read back, then RIFE's raw output
      const { deps } = makeDeps({
        probeMedia: vi.fn(async () => ({ durationSec: probes.shift() ?? 10, hasAudio: true })),
      });
      await expect(processSegment(request, deps, { backend: 'hf-rife', operation: 'rife2' })).rejects.toThrow(/RIFE’s output is 4\.00s/);
      expect(deps.muxSegmentAudio).not.toHaveBeenCalled();
    });

    it('removes the server-side intermediate cut afterwards, success or not', async () => {
      const { deps, contabo } = makeDeps();
      await processSegment(driveRequest, deps, { backend: 'hf-rife', operation: 'rife2' });
      expect(contabo.deleteMedia).toHaveBeenCalledWith('out.mp4');

      contabo.deleteMedia.mockClear();
      vi.mocked(deps.rifeOnHuggingFace).mockRejectedValueOnce(new Error('Space is asleep'));
      await expect(processSegment(driveRequest, deps, { backend: 'hf-rife', operation: 'rife2' })).rejects.toThrow('Space is asleep');
      expect(contabo.deleteMedia).toHaveBeenCalledWith('out.mp4');
    });

    it('does not fail a finished run because the cleanup delete failed', async () => {
      const { deps, contabo } = makeDeps();
      contabo.deleteMedia.mockRejectedValue(new Error('offline'));
      await expect(processSegment(driveRequest, deps, { backend: 'hf-rife', operation: 'rife2' })).resolves.toMatchObject({ backend: 'hf-rife' });
    });
  });
});

describe('importProcessedSegment', () => {
  const file = new File(['x'], 'colab_out.mp4', { type: 'video/mp4' });

  it('accepts a file of the requested length', async () => {
    const { deps } = makeDeps({ probeMedia: vi.fn(async () => ({ durationSec: 10.1, width: 1280, height: 720 })) });
    await expect(importProcessedSegment(file, request, deps)).resolves.toMatchObject({
      backend: 'colab', url: 'blob:result', durationSec: 10.1, width: 1280,
    });
  });

  it('rejects a file that is longer or shorter, naming it', async () => {
    const { deps } = makeDeps({ probeMedia: vi.fn(async () => ({ durationSec: 20 })) });
    const err = await importProcessedSegment(file, request, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SegmentError);
    expect(err.message).toMatch(/“colab_out\.mp4” is 20\.00s but 10\.00s was requested/);
  });
});

