import { describe, expect, it } from 'vitest';
import { formatEncoderPathLabel } from './encoderPathLabel';

describe('formatEncoderPathLabel', () => {
  it('labels GPU stitch distinctly from FFmpeg render', () => {
    expect(formatEncoderPathLabel('gpu-stitch')).toContain('GPU Stitch');
    expect(formatEncoderPathLabel('ffmpeg')).toContain('FFmpeg');
  });
});
