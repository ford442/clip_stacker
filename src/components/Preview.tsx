import type { Clip } from '../types';

interface Props {
  clip: Clip | null;
  outputUrl: string | null;
}

export function Preview({ clip, outputUrl }: Props) {
  if (outputUrl) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <video controls src={outputUrl} />
        <a href={outputUrl} download="stacked.mp4">
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
        <video controls src={clip.objectUrl} />
      ) : (
        <audio controls src={clip.objectUrl} />
      )}
    </section>
  );
}
