import { describe, it, expect, afterEach } from 'vitest';
import type { Clip } from '../types';
import { ClipMediaPool } from './clipMediaPool';

function makeClip(id: string): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('ClipMediaPool', () => {
  const pools: ClipMediaPool[] = [];

  afterEach(() => {
    for (const pool of pools) pool.destroy();
    pools.length = 0;
  });

  function createPool(maxDecoders = 3): ClipMediaPool {
    const pool = new ClipMediaPool(maxDecoders);
    pools.push(pool);
    return pool;
  }

  it('reuses the same video element for a clip id', () => {
    const pool = createPool();
    const clip = makeClip('a');
    const first = pool.getVideo(clip);
    const second = pool.getVideo(clip);
    expect(second).toBe(first);
    expect(pool.size).toBe(1);
  });

  it('evicts least-recently-used decoders when enforceBudget is called', () => {
    const pool = createPool(2);
    const a = pool.getVideo(makeClip('a'));
    const b = pool.getVideo(makeClip('b'));
    pool.getVideo(makeClip('c'));
    expect(pool.size).toBe(3);

    pool.enforceBudget(new Set());
    expect(pool.size).toBe(2);
    expect(a.isConnected).toBe(false);
    expect(b.isConnected).toBe(true);
  });

  it('never evicts protected clip ids during enforceBudget', () => {
    const pool = createPool(2);
    pool.getVideo(makeClip('a'));
    pool.getVideo(makeClip('b'));
    pool.getVideo(makeClip('c'));

    pool.enforceBudget(new Set(['a', 'b']));
    expect(pool.size).toBe(2);
    expect(pool.getVideo(makeClip('a')).isConnected).toBe(true);
    expect(pool.getVideo(makeClip('b')).isConnected).toBe(true);
  });

  it('pruneExcept removes decoders for clips no longer on the timeline', () => {
    const pool = createPool();
    pool.getVideo(makeClip('a'));
    pool.getVideo(makeClip('b'));
    pool.pruneExcept(new Set(['b']));
    expect(pool.size).toBe(1);
    expect(pool.getVideo(makeClip('b')).isConnected).toBe(true);
  });

  it('pauseAll pauses every pooled decoder', () => {
    const pool = createPool();
    const video = pool.getVideo(makeClip('a'));
    video.play();
    pool.pauseAll();
    expect(video.paused).toBe(true);
  });
});
