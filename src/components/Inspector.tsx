import { useEffect, useState } from 'react';
import type { Clip } from '../types';

interface ClipValues {
  title: string;
  trimStart: string;
  trimEnd: string;
  videoFadeIn: string;
  videoFadeOut: string;
  audioFadeIn: string;
  audioFadeOut: string;
}

interface Props {
  clip: Clip | null;
  onChange: (values: ClipValues) => void;
}

export function Inspector({ clip, onChange }: Props) {
  const [values, setValues] = useState<ClipValues>({
    title: '',
    trimStart: '0',
    trimEnd: '',
    videoFadeIn: '0',
    videoFadeOut: '0',
    audioFadeIn: '0',
    audioFadeOut: '0',
  });

  useEffect(() => {
    if (!clip) return;
    setValues({
      title: clip.title,
      trimStart: String(clip.trimStart),
      trimEnd: Number.isFinite(clip.trimEnd) ? String(clip.trimEnd) : '',
      videoFadeIn: String(clip.videoFadeIn),
      videoFadeOut: String(clip.videoFadeOut),
      audioFadeIn: String(clip.audioFadeIn),
      audioFadeOut: String(clip.audioFadeOut),
    });
  }, [clip]);

  if (!clip) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <div className="muted">Select a clip to edit trim and fades.</div>
      </section>
    );
  }

  const update = (field: keyof ClipValues, value: string) => {
    const next = { ...values, [field]: value };
    setValues(next);
    onChange(next);
  };

  return (
    <section className="panel">
      <h2>Inspector</h2>
      <label>
        Clip title
        <input type="text" value={values.title} onChange={(e) => update('title', e.target.value)} />
      </label>
      <label>
        Trim start (s)
        <input
          type="number"
          min="0"
          step="0.1"
          value={values.trimStart}
          onChange={(e) => update('trimStart', e.target.value)}
        />
      </label>
      <label>
        Trim end (s, optional)
        <input
          type="number"
          min="0"
          step="0.1"
          value={values.trimEnd}
          onChange={(e) => update('trimEnd', e.target.value)}
        />
      </label>
      <label>
        Video fade in (s)
        <input
          type="number"
          min="0"
          step="0.1"
          value={values.videoFadeIn}
          onChange={(e) => update('videoFadeIn', e.target.value)}
        />
      </label>
      <label>
        Video fade out (s)
        <input
          type="number"
          min="0"
          step="0.1"
          value={values.videoFadeOut}
          onChange={(e) => update('videoFadeOut', e.target.value)}
        />
      </label>
      <label>
        Audio fade in (s)
        <input
          type="number"
          min="0"
          step="0.1"
          value={values.audioFadeIn}
          onChange={(e) => update('audioFadeIn', e.target.value)}
        />
      </label>
      <label>
        Audio fade out (s)
        <input
          type="number"
          min="0"
          step="0.1"
          value={values.audioFadeOut}
          onChange={(e) => update('audioFadeOut', e.target.value)}
        />
      </label>
    </section>
  );
}

export type { ClipValues };
