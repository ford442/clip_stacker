import { afterEach, describe, expect, it } from 'vitest';
import {
  __setPreviewDecoderOverrideForTests,
  isLegacyPreviewVideoForced,
  isPreviewDecoderEnabled,
  isPreviewDecoderSupported,
} from './previewDecodeFlags';

const withCodecs = { VideoDecoder: () => {}, EncodedVideoChunk: () => {} };

afterEach(() => __setPreviewDecoderOverrideForTests(null));

describe('preview decode flags', () => {
  it('detects WebCodecs support', () => {
    expect(isPreviewDecoderSupported(withCodecs)).toBe(true);
    expect(isPreviewDecoderSupported({})).toBe(false);
    expect(isPreviewDecoderSupported({ VideoDecoder: () => {} })).toBe(false);
  });

  it('enables the decoder path by default when WebCodecs exist', () => {
    expect(isPreviewDecoderEnabled('', withCodecs)).toBe(true);
  });

  it('forces the legacy <video> path with ?legacy_preview_video', () => {
    expect(isLegacyPreviewVideoForced('?legacy_preview_video')).toBe(true);
    expect(isLegacyPreviewVideoForced('?legacy_preview_video=1&x=2')).toBe(true);
    expect(isLegacyPreviewVideoForced('?other=1')).toBe(false);
    expect(isPreviewDecoderEnabled('?legacy_preview_video', withCodecs)).toBe(false);
  });

  it('stays off when WebCodecs is missing', () => {
    expect(isPreviewDecoderEnabled('', {})).toBe(false);
  });

  it('honours the test override above everything else', () => {
    __setPreviewDecoderOverrideForTests(true);
    expect(isPreviewDecoderEnabled('?legacy_preview_video', {})).toBe(true);
    __setPreviewDecoderOverrideForTests(false);
    expect(isPreviewDecoderEnabled('', withCodecs)).toBe(false);
  });
});
