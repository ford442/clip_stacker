import { describe, it, expect } from 'vitest';
import {
  extractErrorMessage,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_MT_CDNS,
  FFMPEG_CORE_VERSION,
  getCdnLabel,
  getFfmpegCoreSources,
  getLocalFfmpegCoreBaseURL,
  normalizeError,
} from './ffmpegCommon';

describe('normalizeError', () => {
  it('returns string errors as-is', () => {
    expect(normalizeError('FFmpeg failed to exec: Invalid argument')).toBe(
      'FFmpeg failed to exec: Invalid argument',
    );
  });

  it('extracts message from Error objects', () => {
    expect(normalizeError(new Error('Something broke'))).toBe('Something broke');
  });

  it('never returns undefined for string throws', () => {
    const msg = normalizeError('Error: failed to import ffmpeg-core.js');
    expect(msg).toBeTruthy();
    expect(msg).not.toContain('undefined');
  });

  it('handles objects with message property', () => {
    expect(normalizeError({ message: 'worker rejected' })).toBe('worker rejected');
  });

  it('is an alias for extractErrorMessage', () => {
    const inputs: unknown[] = [
      'plain string',
      new Error('err obj'),
      { message: 'obj msg' },
      null,
      42,
    ];
    for (const input of inputs) {
      expect(normalizeError(input)).toBe(extractErrorMessage(input));
    }
  });
});

describe('getFfmpegCoreSources', () => {
  it('puts the self-hosted copy ahead of the CDNs for both variants', () => {
    expect(getFfmpegCoreSources('st')).toEqual([
      'http://localhost:3000/ffmpeg-core',
      ...FFMPEG_CORE_CDNS,
    ]);
    expect(getFfmpegCoreSources('mt')).toEqual([
      'http://localhost:3000/ffmpeg-core-mt',
      ...FFMPEG_CORE_MT_CDNS,
    ]);
  });

  it('pins every CDN fallback to the self-hosted version', () => {
    for (const url of [...FFMPEG_CORE_CDNS, ...FFMPEG_CORE_MT_CDNS]) {
      expect(url).toContain(`@${FFMPEG_CORE_VERSION}/dist/esm`);
    }
  });

  it('labels both local copies as locally hosted', () => {
    expect(getCdnLabel(getLocalFfmpegCoreBaseURL('mt'))).toBe('local hosted FFmpeg core');
    expect(getCdnLabel(FFMPEG_CORE_MT_CDNS[0])).toBe('jsDelivr CDN');
  });
});
