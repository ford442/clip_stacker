import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { codecCandidates, h264CodecString, resolveEncoderCodec } from './webcodecs';

describe('h264CodecString', () => {
  it('picks level 3.0 for 720p and below', () => {
    expect(h264CodecString(1280, 720)).toBe('avc1.42001e');
    expect(h264CodecString(640, 360)).toBe('avc1.42001e');
  });

  it('picks level 4.0 for 1080p', () => {
    expect(h264CodecString(1920, 1080)).toBe('avc1.420028');
  });

  it('picks level 5.1 for 4K', () => {
    expect(h264CodecString(3840, 2160)).toBe('avc1.420033');
  });
});

describe('codecCandidates', () => {
  it('returns only H.264 by default', () => {
    expect(codecCandidates(undefined, 1280, 720).map((c) => c.muxerCodec)).toEqual(['avc']);
    expect(codecCandidates('h264', 1280, 720).map((c) => c.muxerCodec)).toEqual(['avc']);
  });

  it('prefers HEVC/AV1 with an H.264 fallback', () => {
    expect(codecCandidates('hevc', 1280, 720).map((c) => c.muxerCodec)).toEqual(['hevc', 'avc']);
    expect(codecCandidates('av1', 1280, 720).map((c) => c.muxerCodec)).toEqual(['av1', 'avc']);
  });
});

describe('resolveEncoderCodec', () => {
  const isConfigSupported = vi.fn();

  beforeEach(() => {
    isConfigSupported.mockReset();
    vi.stubGlobal('VideoEncoder', { isConfigSupported });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the requested codec when supported', async () => {
    isConfigSupported.mockResolvedValue({ supported: true });
    const resolved = await resolveEncoderCodec('av1', 1920, 1080);
    expect(resolved.muxerCodec).toBe('av1');
    expect(resolved.codec).toBe('av01.0.08M.08');
  });

  it('falls back to H.264 when HEVC is unsupported', async () => {
    isConfigSupported
      .mockResolvedValueOnce({ supported: false })
      .mockResolvedValueOnce({ supported: true });
    const resolved = await resolveEncoderCodec('hevc', 1920, 1080);
    expect(resolved.muxerCodec).toBe('avc');
    expect(resolved.codec).toBe('avc1.420028');
  });

  it('falls back to H.264 when the probe throws', async () => {
    isConfigSupported.mockRejectedValue(new TypeError('bad codec string'));
    const resolved = await resolveEncoderCodec('av1', 1280, 720);
    expect(resolved.muxerCodec).toBe('avc');
  });
});
