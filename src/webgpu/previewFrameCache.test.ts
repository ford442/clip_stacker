import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { buildPreviewCompositionPlan } from '../composition/previewComposition';
import { createTestClip } from '../project/project.test.helpers';
import { quantizePlan } from '../export/renderKey';
import {
  FRAME_BLIT_SHADER,
  FrameLru,
  previewCacheBudgetBytes,
  previewFrameKey,
  type PreviewFrameKeyInput,
} from './previewFrameCache';
import { cacheFrameNumber, snapToCacheGrid } from './previewWorkerCache';
import { frameRanges } from '../composition/previewCacheGrid';
import { listAssembledShaders } from './shaderCatalog';

const MB = 1024 ** 2;

describe('FrameLru', () => {
  it('evicts least recently used values past the budget and disposes them', () => {
    const disposed: string[] = [];
    const lru = new FrameLru<string>(30, (value) => disposed.push(value));
    lru.set('a', 'A', 10);
    lru.set('b', 'B', 10);
    lru.set('c', 'C', 10);
    expect(lru.get('a')).toBe('A'); // a is now the most recent
    lru.set('d', 'D', 10);
    expect(disposed).toEqual(['B']);
    expect([...lru.values()].map(([key]) => key)).toEqual(['c', 'a', 'd']);
    expect(lru.bytes).toBe(30);
    lru.setBudget(10);
    expect(lru.size).toBe(1);
    expect(lru.has('d')).toBe(true);
  });

  it('replaces a key, refuses values larger than the budget, and clears', () => {
    const disposed: string[] = [];
    const lru = new FrameLru<string>(20, (value) => disposed.push(value));
    lru.set('a', 'A1', 5);
    lru.set('a', 'A2', 5);
    expect(disposed).toEqual(['A1']);
    expect(lru.bytes).toBe(5);
    lru.set('huge', 'H', 50);
    expect(lru.has('huge')).toBe(false);
    expect(disposed).toContain('H');
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.bytes).toBe(0);
  });
});

describe('previewCacheBudgetBytes', () => {
  it('follows the device class, clamped, and always holds 60 frames', () => {
    expect(previewCacheBudgetBytes({ maxBufferSize: 512 * MB }, 640, 360)).toBe(512 * MB);
    expect(previewCacheBudgetBytes({ maxBufferSize: 128 * MB }, 640, 360)).toBe(192 * MB);
    expect(previewCacheBudgetBytes({ maxBufferSize: 8192 * MB }, 640, 360)).toBe(1024 * MB);
    expect(previewCacheBudgetBytes(null, 3840, 2160)).toBe(3840 * 2160 * 4 * 60);
  });
});

describe('frameRanges', () => {
  it('collapses frame numbers into [start, end) runs', () => {
    expect(frameRanges([5, 1, 2, 3, 9, 3, 6])).toEqual([
      [1, 4],
      [5, 7],
      [9, 10],
    ]);
    expect(frameRanges([])).toEqual([]);
  });
});

describe('preview frame keys', () => {
  const clip: Clip = { ...createTestClip('a', 4), videoWidth: 640, videoHeight: 360 };
  const title = { id: 't', text: 'Hi', x: 0.1, y: 0.1, fontsize: 24, fontcolor: '#fff', scrolling: false, scrollSpeed: 0 };
  const input = (overrides: Partial<PreviewFrameKeyInput> = {}, overlays = [] as never[]): PreviewFrameKeyInput => ({
    plan: quantizePlan(buildPreviewCompositionPlan([clip], [], [], overlays, { outputResolution: '640x360' }, 1, 360, 640)),
    clipsById: new Map([[clip.id, clip]]),
    mediaKey: () => 'media',
    finishing: undefined,
    colorManagement: undefined,
    displayHdr: false,
    buildId: 'test',
    ...overrides,
  });

  it('ignores titles (main draws them over the composite)', () => {
    const plain = previewFrameKey(input());
    expect(plain).not.toBeNull();
    expect(previewFrameKey(input({}, [title] as never[]))).toBe(plain);
  });

  it('changes with the display mode and media, and is off under temporal noise reduction', () => {
    const plain = previewFrameKey(input());
    expect(previewFrameKey(input({ displayHdr: true }))).not.toBe(plain);
    expect(previewFrameKey(input({ mediaKey: () => 'proxy' }))).not.toBe(plain);
    expect(previewFrameKey(input({ mediaKey: () => null }))).toBeNull();
    expect(
      previewFrameKey(
        input({
          finishing: {
            noiseReduction: { enabled: true, amount: 1, spatialStrength: 0, temporal: true, temporalStrength: 0.5 },
          } as never,
        }),
      ),
    ).toBeNull();
  });

  it('snaps preview times to the 30 fps grid', () => {
    expect(snapToCacheGrid(1.01)).toBe(1);
    expect(snapToCacheGrid(1.02)).toBeCloseTo(31 / 30, 12);
    expect(cacheFrameNumber(snapToCacheGrid(2.5))).toBe(75);
  });

  it('registers the blit shader with the catalog', () => {
    expect(listAssembledShaders().find((s) => s.name === 'frameBlit.wgsl')?.code).toBe(FRAME_BLIT_SHADER);
  });
});
