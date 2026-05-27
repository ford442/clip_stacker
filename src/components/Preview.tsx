import type { Clip } from '../types';
import { sanitizeFilename } from '../utils/filename';

interface Props {
  clip: Clip | null;
  outputUrl: string | null;
  exportFilename?: string;
}

export function Preview({ clip, outputUrl, exportFilename }: Props) {
  if (outputUrl) {
    const downloadFilename = exportFilename ? sanitizeFilename(exportFilename) : 'stacked.mp4';
    return (
      <section className="panel">
        <h2>Preview</h2>
        <video
          controls
          src={outputUrl}
          aria-label="Rendered output video preview. Press space to play/pause."
        />
        <a href={outputUrl} download={downloadFilename}>
          Download merged MP4
        </a>
      </section>
    );
  }

  if (!clip) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <div className="muted">No clip selected.</div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Preview</h2>
      {clip.kind === 'video' ? (
        <video
          controls
          src={clip.objectUrl}
          aria-label={`Preview of ${clip.title} video. Press space to play/pause.`}
        />
      ) : (
        <audio
          controls
          src={clip.objectUrl}
          aria-label={`Preview of ${clip.title} audio. Press space to play/pause.`}
        />
      )}
    </section>
  );
}
