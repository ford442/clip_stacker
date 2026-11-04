import { describe, expect, it } from 'vitest';
import { buildTrimmedClipArgs } from './extract';

describe('buildTrimmedClipArgs', () => {
  it('stream-copies a cut that starts at the beginning of the file (exact and lossless)', () => {
    expect(buildTrimmedClipArgs({ trimStart: 0, trimEnd: 4 }, 'in.mp4', 'out.mp4')).toEqual([
      '-i', 'in.mp4', '-t', '4', '-c', 'copy', '-avoid_negative_ts', 'make_zero', 'out.mp4',
    ]);
    expect(buildTrimmedClipArgs({ trimStart: 0, trimEnd: NaN }, 'in.mp4', 'out.mp4')).toEqual([
      '-i', 'in.mp4', '-c', 'copy', '-avoid_negative_ts', 'make_zero', 'out.mp4',
    ]);
  });

  it('re-encodes a later in-point instead of snapping it back to a keyframe', () => {
    const args = buildTrimmedClipArgs({ trimStart: 2.5, trimEnd: 6 }, 'in.mp4', 'out.mp4');
    expect(args.slice(0, 6)).toEqual(['-ss', '2.5', '-i', 'in.mp4', '-t', '3.5']);
    expect(args).not.toContain('copy');
    expect(args).toContain('libx264');
    expect(args.at(-1)).toBe('out.mp4');
  });
});
