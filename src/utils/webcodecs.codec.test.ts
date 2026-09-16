import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  EXPORT_BITRATE_MODE,
  REC709_COLOR_SPACE,
  VIDEO_ENCODER_LATENCY_MODE,
  WEBCODECS_PROGRESS_STAGES,
  buildVideoEncoderConfig,
  codecCandidates,
  crfToBitsPerPixel,
  h264CodecString,
  resolveEncoderBitrate,
  resolveEncoderCodec,
} from './webcodecs';

describe('h264CodecString', () => {
  it('picks level 3.0 for 720p and below (defaults to Constrained Baseline)', () => {
    expect(h264CodecString(1280, 720)).toBe('avc1.42001e');
    expect(h264CodecString(640, 360)).toBe('avc1.42001e');
  });

  it('picks level 4.0 for 1080p', () => {
    expect(h264CodecString(1920, 1080)).toBe('avc1.420028');
  });

  it('picks level 5.1 for 4K', () => {
    expect(h264CodecString(3840, 2160)).toBe('avc1.420033');
  });

  it('varies only the profile_idc byte for High / Main / Baseline at the same resolution', () => {
    expect(h264CodecString(1920, 1080, 'high')).toBe('avc1.640028');
    expect(h264CodecString(1920, 1080, 'main')).toBe('avc1.4d0028');
    expect(h264CodecString(1920, 1080, 'baseline')).toBe('avc1.420028');
  });
});

describe('codecCandidates', () => {
  it('probes High -> Main -> Baseline H.264 profiles by default', () => {
    expect(codecCandidates(undefined, 1280, 720).map((c) => c.codec)).toEqual([
      'avc1.64001e',
      'avc1.4d001e',
      'avc1.42001e',
    ]);
    expect(codecCandidates(undefined, 1280, 720).every((c) => c.muxerCodec === 'avc')).toBe(true);
    expect(codecCandidates('h264', 1280, 720).map((c) => c.muxerCodec)).toEqual([
      'avc',
      'avc',
      'avc',
    ]);
  });

  it('prefers HEVC/AV1 with the same High -> Main -> Baseline H.264 fallback', () => {
    expect(codecCandidates('hevc', 1280, 720).map((c) => c.muxerCodec)).toEqual([
      'hevc',
      'avc',
      'avc',
      'avc',
    ]);
    expect(codecCandidates('av1', 1280, 720).map((c) => c.muxerCodec)).toEqual([
      'av1',
      'avc',
      'avc',
      'avc',
    ]);
  });
});

describe('buildVideoEncoderConfig', () => {
  it('uses VBR, Rec.709 color tagging, and length-prefixed AVC for H.264 candidates', () => {
    const config = buildVideoEncoderConfig(
      { codec: 'avc1.640028', muxerCodec: 'avc' },
      1920,
      1080,
      8_000_000,
      30,
    );
    expect(config.bitrateMode).toBe(EXPORT_BITRATE_MODE);
    expect(config.bitrateMode).toBe('variable');
    expect(config.colorSpace).toEqual(REC709_COLOR_SPACE);
    expect(config.avc).toEqual({ format: 'avc' });
    expect(config.hardwareAcceleration).toBe('prefer-hardware');
    expect(config.latencyMode).toBe(VIDEO_ENCODER_LATENCY_MODE);
  });

  it('omits the avc field for non-H.264 candidates', () => {
    const config = buildVideoEncoderConfig(
      { codec: 'hvc1.1.6.L123.B0', muxerCodec: 'hevc' },
      1920,
      1080,
      8_000_000,
    );
    expect(config.avc).toBeUndefined();
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

describe('VIDEO_ENCODER_LATENCY_MODE', () => {
  it('uses quality mode so export does not drop to realtime', () => {
    expect(VIDEO_ENCODER_LATENCY_MODE).toBe('quality');
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
    const resolved = await resolveEncoderCodec('av1', 1920, 1080, 8_000_000);
    expect(resolved.muxerCodec).toBe('av1');
    expect(resolved.codec).toBe('av01.0.08M.08');
  });

  it('falls back through H.264 High -> Main -> Baseline when HEVC is unsupported', async () => {
    isConfigSupported
      .mockResolvedValueOnce({ supported: false }) // hevc
      .mockResolvedValueOnce({ supported: true }); // avc1 High
    const resolved = await resolveEncoderCodec('hevc', 1920, 1080, 8_000_000);
    expect(resolved.muxerCodec).toBe('avc');
    expect(resolved.codec).toBe('avc1.640028'); // High profile, level 4.0
  });

  it('prefers High profile over Main/Baseline when all three are supported', async () => {
    isConfigSupported.mockResolvedValue({ supported: true });
    const resolved = await resolveEncoderCodec(undefined, 1920, 1080, 8_000_000);
    expect(resolved.codec).toBe('avc1.640028');
    // Only the first (High) candidate should have been probed.
    expect(isConfigSupported).toHaveBeenCalledTimes(1);
  });

  it('falls back to Main when High is unsupported but Main is', async () => {
    isConfigSupported
      .mockResolvedValueOnce({ supported: false }) // High
      .mockResolvedValueOnce({ supported: true }); // Main
    const resolved = await resolveEncoderCodec(undefined, 1920, 1080, 8_000_000);
    expect(resolved.codec).toBe('avc1.4d0028');
  });

  it('falls back to Baseline when the probe throws for every candidate', async () => {
    isConfigSupported.mockRejectedValue(new TypeError('bad codec string'));
    const resolved = await resolveEncoderCodec('av1', 1280, 720, 4_000_000);
    expect(resolved.muxerCodec).toBe('avc');
    expect(resolved.codec).toBe('avc1.42001e'); // last candidate: Baseline
  });

  it('probes with the same bitrate/latencyMode/bitrateMode the real configure() will use', async () => {
    isConfigSupported.mockResolvedValue({ supported: true });
    await resolveEncoderCodec(undefined, 1920, 1080, 8_000_000);
    expect(isConfigSupported).toHaveBeenCalledWith(
      expect.objectContaining({
        bitrate: 8_000_000,
        bitrateMode: EXPORT_BITRATE_MODE,
        latencyMode: VIDEO_ENCODER_LATENCY_MODE,
      }),
    );
  });
});
