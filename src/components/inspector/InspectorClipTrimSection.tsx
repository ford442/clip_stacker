import type { Clip } from '../../types';
import { MIN_CLIP_DURATION } from '../../utils/media';
import { FadeCanvasPreview } from '../FadeCanvasPreview';
import { WaveformCanvas } from '../WaveformCanvas';
import { GpuChoreLevelsPanel } from './GpuChoreLevelsPanel';
import { clamp, parseNumber } from './helpers';
import type { ClipValues } from './types';

interface InspectorClipTrimSectionProps {
  clip: Clip;
  values: ClipValues;
  trimStart: number;
  trimEnd: number;
  trimDuration: number;
  trimStartPct: number;
  trimEndPct: number;
  clipPreviewDuration: number;
  currentThumbs: string[] | undefined;
  currentWave: Float32Array | undefined;
  update: (field: keyof ClipValues, value: string) => void;
  nudge: (field: 'trimStart' | 'trimEnd', delta: number) => void;
  updateTrimStart: (nextStart: number) => void;
  updateTrimEnd: (nextEnd: number) => void;
}

export function InspectorClipTrimSection({
  clip,
  values,
  trimStart,
  trimEnd,
  trimDuration,
  trimStartPct,
  trimEndPct,
  clipPreviewDuration,
  currentThumbs,
  currentWave,
  update,
  nudge,
  updateTrimStart,
  updateTrimEnd,
}: InspectorClipTrimSectionProps) {
  return (
    <>
      <label>
        Clip title
        <input type="text" value={values.title} onChange={(e) => update('title', e.target.value)} />
      </label>
      <div className="inspector-group-label">Trim</div>
      <div className="inspector-trim-visual-group">
        <div className="inspector-trim-visual">
          {clip.kind === 'video' ? (
            <div className={`timeline-thumbs inspector-trim-media${currentThumbs ? '' : ' is-loading'}`}>
              {currentThumbs?.map((src, index) => <img key={index} src={src} alt="" />) ?? null}
            </div>
          ) : (
            <div className={`timeline-waveform inspector-trim-media${currentWave ? '' : ' is-loading'}`}>
              {currentWave ? <WaveformCanvas peaks={currentWave} height={54} /> : <span className="waveform-loading-icon">♫</span>}
            </div>
          )}
          <div className="inspector-trim-mask" style={{ width: `${trimStartPct}%` }} />
          <div className="inspector-trim-mask inspector-trim-mask--right" style={{ width: `${100 - trimEndPct}%` }} />
          <div
            className="inspector-trim-window"
            style={{ left: `${trimStartPct}%`, width: `${Math.max(0, trimEndPct - trimStartPct)}%` }}
          />
        </div>
        <div className="inspector-trim-sliders">
          <label className="inspector-trim-slider">
            Start {trimStart.toFixed(2)}s
            <input
              type="range"
              min="0"
              max={Math.max(0, trimDuration - MIN_CLIP_DURATION)}
              step="0.01"
              value={trimStart}
              onChange={(e) => updateTrimStart(Number(e.target.value))}
            />
          </label>
          <label className="inspector-trim-slider">
            End {trimEnd.toFixed(2)}s
            <input
              type="range"
              min={MIN_CLIP_DURATION}
              max={trimDuration}
              step="0.01"
              value={trimEnd}
              onChange={(e) => updateTrimEnd(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="inspector-hint">
          Drag the trim sliders to align with the preview strip for precise trimming.
        </p>
      </div>
      {(clip.lumaHistogram || clip.stillImage) && (
        <GpuChoreLevelsPanel clip={clip} />
      )}
      <label>
        Trim start (s)
        <input
          type="number"
          min="0"
          step="0.01"
          value={values.trimStart}
          onChange={(e) => update('trimStart', e.target.value)}
        />
        <div className="nudge-row">
          <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', -0.5)} title="−0.5 s">−0.5</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', -0.1)} title="−0.1 s">−0.1</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', -0.01)} title="−0.01 s">−0.01</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', +0.01)} title="+0.01 s">+0.01</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', +0.1)} title="+0.1 s">+0.1</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', +0.5)} title="+0.5 s">+0.5</button>
        </div>
      </label>
      <label>
        Trim end (s, optional)
        <input
          type="number"
          min="0"
          step="0.01"
          value={values.trimEnd}
          onChange={(e) => update('trimEnd', e.target.value)}
        />
        <div className="nudge-row">
          <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', -0.5)} title="−0.5 s">−0.5</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', -0.1)} title="−0.1 s">−0.1</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', -0.01)} title="−0.01 s">−0.01</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', +0.01)} title="+0.01 s">+0.01</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', +0.1)} title="+0.1 s">+0.1</button>
          <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', +0.5)} title="+0.5 s">+0.5</button>
        </div>
      </label>
      <div className="inspector-group-label">Video fades</div>
      <div className="inspector-field-with-preview">
        <label>
          Fade in (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.videoFadeIn}
            onChange={(e) => update('videoFadeIn', e.target.value)}
          />
        </label>
        {clip.kind === 'video' ? (
          <FadeCanvasPreview
            objectUrl={clip.objectUrl}
            trimStart={trimStart}
            trimEnd={trimEnd}
            clipDuration={trimDuration}
            fadeDuration={clamp(parseNumber(values.videoFadeIn, 0), 0, clipPreviewDuration / 2)}
            direction="in"
            tone="video"
          />
        ) : (
          <FadeCanvasPreview
            trimStart={trimStart}
            trimEnd={trimEnd}
            clipDuration={trimDuration}
            fadeDuration={clamp(parseNumber(values.videoFadeIn, 0), 0, clipPreviewDuration / 2)}
            direction="in"
            tone="video"
          />
        )}
      </div>
      <div className="inspector-field-with-preview">
        <label>
          Fade out (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.videoFadeOut}
            onChange={(e) => update('videoFadeOut', e.target.value)}
          />
        </label>
        {clip.kind === 'video' ? (
          <FadeCanvasPreview
            objectUrl={clip.objectUrl}
            trimStart={trimStart}
            trimEnd={trimEnd}
            clipDuration={trimDuration}
            fadeDuration={clamp(parseNumber(values.videoFadeOut, 0), 0, clipPreviewDuration / 2)}
            direction="out"
            tone="video"
          />
        ) : (
          <FadeCanvasPreview
            trimStart={trimStart}
            trimEnd={trimEnd}
            clipDuration={trimDuration}
            fadeDuration={clamp(parseNumber(values.videoFadeOut, 0), 0, clipPreviewDuration / 2)}
            direction="out"
            tone="video"
          />
        )}
      </div>
      <div className="inspector-group-label">Audio fades</div>
      <div className="inspector-field-with-preview">
        <label>
          Fade in (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.audioFadeIn}
            onChange={(e) => update('audioFadeIn', e.target.value)}
          />
        </label>
        <FadeCanvasPreview
          peaks={currentWave}
          trimStart={trimStart}
          trimEnd={trimEnd}
          clipDuration={trimDuration}
          fadeDuration={clamp(parseNumber(values.audioFadeIn, 0), 0, clipPreviewDuration / 2)}
          direction="in"
          tone="audio"
        />
      </div>
      <div className="inspector-field-with-preview">
        <label>
          Fade out (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.audioFadeOut}
            onChange={(e) => update('audioFadeOut', e.target.value)}
          />
        </label>
        <FadeCanvasPreview
          peaks={currentWave}
          trimStart={trimStart}
          trimEnd={trimEnd}
          clipDuration={trimDuration}
          fadeDuration={clamp(parseNumber(values.audioFadeOut, 0), 0, clipPreviewDuration / 2)}
          direction="out"
          tone="audio"
        />
      </div>
    </>
  );
}
