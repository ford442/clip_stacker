import { describe, it, expect } from 'vitest';
import { normalizeError, extractErrorMessage } from './ffmpegCommon';

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
