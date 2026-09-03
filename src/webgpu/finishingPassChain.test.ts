import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finishingIntermediateTextureDescriptor } from './finishingPassChain';

beforeEach(() => {
  if (typeof GPUTextureUsage === 'undefined') {
    vi.stubGlobal('GPUTextureUsage', {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      RENDER_ATTACHMENT: 0x10,
    });
  }
});

describe('finishingIntermediateTextureDescriptor', () => {
  it('matches the canvas format so ping-pong copies stay format-neutral', () => {
    const desc = finishingIntermediateTextureDescriptor(1920, 1080, 'bgra8unorm');
    expect(desc.size).toEqual([1920, 1080, 1]);
    expect(desc.format).toBe('bgra8unorm');
    expect(typeof desc.usage).toBe('number');
    expect(desc.usage).toBeGreaterThan(0);
  });
});
