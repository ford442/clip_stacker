import { describe, expect, it } from 'vitest';
import { formatEncoderPathLabel } from './encoderPathLabel';

describe('formatEncoderPathLabel', () => {
  it('labels the demoted remote-concat stitch path distinctly from FFmpeg render', () => {
    expect(formatEncoderPathLabel('gpu-stitch')).toContain('Remote concat');
    expect(formatEncoderPathLabel('ffmpeg')).toContain('FFmpeg');
  });

  it('warns that remote concat ignores timeline compositing, matching the demotion in useRenderActions', () => {
    expect(formatEncoderPathLabel('gpu-stitch')).toContain('ignores timeline compositing');
  });

  it('distinguishes every encoder path label from every other', () => {
    const paths = ['canvas', 'webcodecs-av', 'webcodecs', 'gpu-stitch', 'ffmpeg'];
    const labels = paths.map(formatEncoderPathLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
