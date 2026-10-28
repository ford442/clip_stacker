import { describe, expect, it } from 'vitest';
import { describeEncoderBadge, formatEncoderPathLabel } from './encoderPathLabel';

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

describe('describeEncoderBadge', () => {
  const caps = { webcodecs: true, webgpu: true, hardwareH264: true };

  it('says hardware only when a hardware H.264 encoder was probed', () => {
    expect(describeEncoderBadge(caps).label).toBe('⚡ HW H.264');
    expect(describeEncoderBadge({ ...caps, hardwareH264: false }).label).toBe('WebCodecs (SW)');
  });

  it('is CPU without WebCodecs, or when FFmpeg is forced', () => {
    expect(describeEncoderBadge({ ...caps, webcodecs: false }).label).toBe('🖥 CPU');
    expect(describeEncoderBadge(caps, { forceFFmpeg: true }).label).toBe('🖥 CPU');
  });

  it('flags missing WebGPU separately from the encoder', () => {
    const noGpu = describeEncoderBadge({ ...caps, webgpu: false });
    expect(noGpu).toEqual({ label: '⚡ HW H.264', webgpuUnavailable: true });
    expect(describeEncoderBadge(caps).webgpuUnavailable).toBe(false);
  });

  it('does not flag WebGPU before capabilities are known', () => {
    expect(describeEncoderBadge(null)).toEqual({ label: '… Detecting', webgpuUnavailable: false });
  });

  it('shows the canvas renderer when selected', () => {
    expect(describeEncoderBadge(caps, { useCanvasRenderer: true }).label).toBe('🎨 Canvas');
  });
});
