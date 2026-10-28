import { describe, expect, it, vi } from 'vitest';
import { DEMO_CLIPS, demoClipUrl, fetchDemoClips } from './demoClips';

describe('demoClips', () => {
  it('resolves against the page so a sub-path deploy works', () => {
    expect(demoClipUrl('demo/a.mp4', 'https://x.test/clip-stacker/')).toBe(
      'https://x.test/clip-stacker/demo/a.mp4',
    );
  });

  it('fetches every demo clip as an mp4 File', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(['x']))) as unknown as typeof fetch;
    const files = await fetchDemoClips(fetchImpl);
    expect(files.map((f) => f.name)).toEqual(DEMO_CLIPS.map((c) => c.fileName));
    expect(files.every((f) => f.type === 'video/mp4')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(DEMO_CLIPS.length);
  });

  it('rejects when a clip is missing', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchDemoClips(fetchImpl)).rejects.toThrow(/HTTP 404/);
  });
});
