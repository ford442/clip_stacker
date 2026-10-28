import type { BrowserCapabilities } from './feature-detector';

/** User-facing label for the encoder path recorded after Render or GPU Stitch. */
export function formatEncoderPathLabel(path: string): string {
  switch (path) {
    case 'canvas':
      return '🎨 Canvas (audio-reactive)';
    case 'webcodecs-av':
      return '⚡ GPU (WebCodecs A/V)';
    case 'webcodecs':
      return '⚡ GPU (WebCodecs + FFmpeg audio)';
    case 'gpu-stitch':
      return '☁ Remote concat (base lanes only — ignores timeline compositing)';
    case 'ffmpeg':
      return '🖥 FFmpeg';
    default:
      return path;
  }
}

export interface EncoderBadge {
  label: string;
  /** WebGPU could not be initialised in this browser (shown as its own flag). */
  webgpuUnavailable: boolean;
}

/**
 * Toolbar badge for the encoder this browser can actually use, from the probed
 * capabilities rather than API presence alone: WebCodecs without a hardware
 * H.264 encoder is software, and WebGPU is reported on its own.
 */
export function describeEncoderBadge(
  caps: Pick<BrowserCapabilities, 'webcodecs' | 'webgpu' | 'hardwareH264'> | null,
  options: { useCanvasRenderer?: boolean; forceFFmpeg?: boolean } = {},
): EncoderBadge {
  const webgpuUnavailable = caps !== null && !caps.webgpu;
  if (options.useCanvasRenderer) return { label: '🎨 Canvas', webgpuUnavailable };
  if (!caps) return { label: '… Detecting', webgpuUnavailable: false };
  if (options.forceFFmpeg || !caps.webcodecs) {
    return { label: '🖥 CPU', webgpuUnavailable };
  }
  return {
    label: caps.hardwareH264 ? '⚡ HW H.264' : 'WebCodecs (SW)',
    webgpuUnavailable,
  };
}
