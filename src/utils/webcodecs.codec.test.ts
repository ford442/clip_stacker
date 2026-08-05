import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  codecCandidates,
  crfToBitsPerPixel,
  h264CodecString,
  resolveEncoderBitrate,
  resolveEncoderCodec,
  WEBCODECS_PROGRESS_STAGES,
} from './webcodecs';

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

describe('resolveEncoderBitrate', () => {
  it('uses an explicit bitrate when set', () => {
    expect(resolveEncoderBitrate({ videoBitrate: 8_000_000, crf: 23 }, 1920, 1080)).toBe(
      8_000_000,
    );
  });

  it('derives bitrate from CRF when videoBitrate is 0 (auto)', () => {
    const auto = resolveEncoderBitrate({ videoBitrate: 0, crf: 18 }, 1920, 1080);
    const bpp = crfToBitsPerPixel(18);
    expect(auto).toBe(Math.round(1920 * 1080 * 30 * bpp));
    expect(auto).toBeGreaterThan(1_000_000);
  });

  it('produces lower bitrate for higher CRF', () => {
    const high = resolveEncoderBitrate({ videoBitrate: 0, crf: 15 }, 1280, 720);
    const low = resolveEncoderBitrate({ videoBitrate: 0, crf: 28 }, 1280, 720);
    expect(high).toBeGreaterThan(low);
  });
});

describe('WEBCODECS_PROGRESS_STAGES', () => {
  it('exposes decode → composite → encode stage labels', () => {
    expect(WEBCODECS_PROGRESS_STAGES.decodeCompositeEncode).toMatch(/Decode/);
    expect(WEBCODECS_PROGRESS_STAGES.flush).toMatch(/encoder/i);
    expect(WEBCODECS_PROGRESS_STAGES.audio).toMatch(/audio/i);
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
