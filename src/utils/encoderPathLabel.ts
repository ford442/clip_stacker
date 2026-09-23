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
