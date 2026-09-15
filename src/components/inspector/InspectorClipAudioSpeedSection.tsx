import type { Clip, ClipAutomation } from '../../types';
import { getClipDuration } from '../../utils/project';
import {
  DEFAULT_CLIP_PAN,
  MAX_CLIP_PAN,
  MIN_CLIP_PAN,
} from '../../utils/clipAutomation';
import {
  beatsSpannedByDuration,
  MAX_CLIP_LOOP_COUNT,
  MIN_CLIP_LOOP_COUNT,
  MIN_CLIP_PLAYBACK_RATE,
  MAX_CLIP_PLAYBACK_RATE,
  nudgePlaybackRate,
  playbackRateForTargetDuration,
  playbackRateToFitBeats,
  PLAYBACK_RATE_NUDGE_COARSE,
  PLAYBACK_RATE_NUDGE_FINE,
  UI_MAX_CLIP_PLAYBACK_RATE,
} from '../../utils/playbackRate';
import { MIN_CLIP_DURATION } from '../../utils/media';
import { BeatmatchPanel } from '../BeatmatchPanel';
import { KeyframeMiniEditor } from '../KeyframeMiniEditor';
import { WaveformCanvas } from '../WaveformCanvas';
import { parseNumber } from './helpers';

interface InspectorClipAudioSpeedSectionProps {
  clip: Clip;
  clipLocalTime: number;
  currentWave: Float32Array | undefined;
  volumeValue: number;
  volumePercent: number;
  playbackRateValue: number;
  trimmedSourceDuration: number;
  outputSpeedDuration: number;
  loopCountValue: number;
  loopedOutputDuration: number;
  fitBeatCount: string;
  setFitBeatCount: (value: string) => void;
  setPlaybackRate: (rate: number) => void;
  setLoopCount: (count: number) => void;
  updateVolume: (value: string) => void;
  onAutomationChange?: (automation: ClipAutomation | undefined) => void;
  onExtractAudio?: () => void;
}

export function InspectorClipAudioSpeedSection({
  clip,
  clipLocalTime,
  currentWave,
  volumeValue,
  volumePercent,
  playbackRateValue,
  trimmedSourceDuration,
  outputSpeedDuration,
  loopCountValue,
  loopedOutputDuration,
  fitBeatCount,
  setFitBeatCount,
  setPlaybackRate,
  setLoopCount,
  updateVolume,
  onAutomationChange,
  onExtractAudio,
}: InspectorClipAudioSpeedSectionProps) {
  return (
    <>
      <div className="inspector-group-label">Volume</div>
      <div className="inspector-volume-group">
        <div className={`inspector-volume-waveform${currentWave ? '' : ' is-loading'}`}>
          {currentWave ? (
            <WaveformCanvas peaks={currentWave} height={40} />
          ) : (
            <span className="waveform-loading-icon">♫</span>
          )}
        </div>
        <label className="inspector-volume-slider" title="Clip volume from 0% (muted) to 200% (double). Applied during render and preview.">
          Volume {volumePercent}%
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={volumeValue}
            onChange={(e) => updateVolume(e.target.value)}
          />
        </label>
        <label
          className="inspector-checkbox-label"
          title="Mute this clip's audio entirely."
        >
          <input
            type="checkbox"
            checked={volumeValue <= 0}
            onChange={(e) => updateVolume(e.target.checked ? '0' : '1')}
          />
          Mute clip audio
        </label>
        <p className="inspector-hint">
          Volume is baked into the final render via FFmpeg and reflected in preview playback.
          Automation lanes override the scalar level over clip-local time; fades still apply on top.
        </p>
      </div>
      <div className="inspector-group-label">Speed / time-stretch</div>
      <div className="inspector-speed-panel">
        <div className="inspector-speed-primary">
          <label
            className="inspector-speed-slider"
            title="Constant playback speed. Higher = shorter on the timeline. Export audio is pitch-preserving."
          >
            <span className="inspector-speed-slider-header">
              <span>Speed</span>
              <strong className="inspector-speed-live-rate" aria-live="polite">
                {playbackRateValue.toFixed(3)}×
              </strong>
              <span className="inspector-speed-out-duration" aria-live="polite">
                Out {loopedOutputDuration.toFixed(2)}s
                {loopCountValue > 1 && (
                  <span className="inspector-speed-loop-badge"> (×{loopCountValue})</span>
                )}
              </span>
            </span>
            <input
              type="range"
              min={MIN_CLIP_PLAYBACK_RATE}
              max={UI_MAX_CLIP_PLAYBACK_RATE}
              step="0.01"
              value={playbackRateValue}
              onChange={(e) => setPlaybackRate(Number(e.target.value))}
              aria-valuetext={`${playbackRateValue.toFixed(3)} times, output duration ${loopedOutputDuration.toFixed(2)} seconds`}
            />
          </label>

          <div className="inspector-speed-controls" role="group" aria-label="Playback rate controls">
            <label className="inspector-speed-field" title="Exact playback rate">
              Rate
              <input
                type="number"
                min={MIN_CLIP_PLAYBACK_RATE}
                max={UI_MAX_CLIP_PLAYBACK_RATE}
                step="0.001"
                value={Number(playbackRateValue.toFixed(3))}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
                aria-describedby="inspector-speed-out-hint"
              />
            </label>
            <div className="inspector-speed-nudges" role="group" aria-label="Nudge speed">
              <button
                type="button"
                className="btn-secondary kf-btn"
                title={`−${PLAYBACK_RATE_NUDGE_COARSE}×`}
                onClick={() =>
                  setPlaybackRate(
                    nudgePlaybackRate(playbackRateValue, -PLAYBACK_RATE_NUDGE_COARSE),
                  )
                }
              >
                −0.05
              </button>
              <button
                type="button"
                className="btn-secondary kf-btn"
                title={`−${PLAYBACK_RATE_NUDGE_FINE}×`}
                onClick={() =>
                  setPlaybackRate(
                    nudgePlaybackRate(playbackRateValue, -PLAYBACK_RATE_NUDGE_FINE),
                  )
                }
              >
                −0.01
              </button>
              <button
                type="button"
                className="btn-secondary kf-btn"
                title={`+${PLAYBACK_RATE_NUDGE_FINE}×`}
                onClick={() =>
                  setPlaybackRate(
                    nudgePlaybackRate(playbackRateValue, PLAYBACK_RATE_NUDGE_FINE),
                  )
                }
              >
                +0.01
              </button>
              <button
                type="button"
                className="btn-secondary kf-btn"
                title={`+${PLAYBACK_RATE_NUDGE_COARSE}×`}
                onClick={() =>
                  setPlaybackRate(
                    nudgePlaybackRate(playbackRateValue, PLAYBACK_RATE_NUDGE_COARSE),
                  )
                }
              >
                +0.05
              </button>
            </div>
          </div>
        </div>

        <div className="inspector-speed-row">
          <label
            className="inspector-speed-field"
            title="Set the output timeline length; rate is computed from the trimmed source."
          >
            Fit to duration (s)
            <input
              type="number"
              min={MIN_CLIP_DURATION}
              step="0.01"
              value={Number(outputSpeedDuration.toFixed(3))}
              onChange={(e) => {
                const target = Number(e.target.value);
                if (!Number.isFinite(target) || target <= 0) return;
                setPlaybackRate(
                  playbackRateForTargetDuration(trimmedSourceDuration, target),
                );
              }}
            />
          </label>
          <div id="inspector-speed-out-hint" className="inspector-speed-meta" aria-live="polite">
            <span>Source {trimmedSourceDuration.toFixed(2)}s</span>
            <span>→</span>
            {loopCountValue > 1 ? (
              <>
                <span>cycle {outputSpeedDuration.toFixed(2)}s</span>
                <span>× {loopCountValue}</span>
                <span>=</span>
                <span>Out {loopedOutputDuration.toFixed(2)}s</span>
              </>
            ) : (
              <span>Out {outputSpeedDuration.toFixed(2)}s</span>
            )}
          </div>
        </div>

        <div className="inspector-speed-row">
          <label
            className="inspector-speed-field"
            title="Play the trimmed + sped-up window this many times, back to back, as one timeline block."
          >
            Loop
            <input
              type="number"
              min={MIN_CLIP_LOOP_COUNT}
              max={MAX_CLIP_LOOP_COUNT}
              step="1"
              value={loopCountValue}
              onChange={(e) => setLoopCount(Number(e.target.value))}
              aria-describedby="inspector-speed-out-hint"
            />
          </label>
          <div className="inspector-speed-nudges" role="group" aria-label="Nudge loop count">
            <button
              type="button"
              className="btn-secondary kf-btn"
              title="−1 loop"
              disabled={loopCountValue <= MIN_CLIP_LOOP_COUNT}
              onClick={() => setLoopCount(loopCountValue - 1)}
            >
              −1
            </button>
            <button
              type="button"
              className="btn-secondary kf-btn"
              title="+1 loop"
              disabled={loopCountValue >= MAX_CLIP_LOOP_COUNT}
              onClick={() => setLoopCount(loopCountValue + 1)}
            >
              +1
            </button>
          </div>
          <div className="inspector-speed-presets">
            {[1, 2, 4, 8].map((preset) => (
              <button
                key={preset}
                type="button"
                className={`btn-secondary kf-btn${loopCountValue === preset ? ' is-active' : ''}`}
                onClick={() => setLoopCount(preset)}
              >
                {preset}×
              </button>
            ))}
            <button
              type="button"
              className="btn-secondary kf-btn"
              disabled={loopCountValue === 1}
              onClick={() => setLoopCount(1)}
            >
              Reset 1×
            </button>
          </div>
        </div>

        {clip.bpmEstimate != null && clip.bpmEstimate > 0 && (
          <div className="inspector-speed-row inspector-speed-beats">
            <label
              className="inspector-speed-field"
              title="Stretch/compress so the clip spans exactly this many beats at the clip BPM."
            >
              Fit to beats
              <input
                type="number"
                min="1"
                step="1"
                value={fitBeatCount}
                onChange={(e) => setFitBeatCount(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn-secondary kf-btn"
              onClick={() => {
                const beats = Math.max(1, Math.round(parseNumber(fitBeatCount, 8)));
                const next = playbackRateToFitBeats(
                  trimmedSourceDuration,
                  clip.bpmEstimate!,
                  beats,
                );
                if (next != null) {
                  setFitBeatCount(String(beats));
                  setPlaybackRate(next);
                }
              }}
            >
              Apply @ {Math.round(clip.bpmEstimate)} BPM
            </button>
            <span className="inspector-speed-meta">
              Now ≈ {beatsSpannedByDuration(outputSpeedDuration, clip.bpmEstimate).toFixed(2)} beats
            </span>
          </div>
        )}

        <div className="inspector-speed-presets">
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((preset) => (
            <button
              key={preset}
              type="button"
              className={`btn-secondary kf-btn${
                Math.abs(playbackRateValue - preset) < 0.001 ? ' is-active' : ''
              }`}
              onClick={() => setPlaybackRate(preset)}
            >
              {preset}×
            </button>
          ))}
          <button
            type="button"
            className="btn-secondary kf-btn"
            disabled={Math.abs(playbackRateValue - 1) < 1e-6}
            onClick={() => setPlaybackRate(1)}
          >
            Reset 1×
          </button>
        </div>
        <BeatmatchPanel
          clip={clip}
          playbackRate={playbackRateValue}
          onPlaybackRateChange={setPlaybackRate}
        />

        <p className="inspector-hint">
          Lip-sync tip: set <em>Fit to duration</em> to the music phrase length, then nudge ±0.01
          while previewing. For cinematic ramps, add a Speed automation curve (Inspector or
          selected timeline clip). Variable remaps keep pitch via WSOLA; constant rate uses
          atempo on export.
        </p>
      </div>
      {onAutomationChange && (
        <details className="inspector-details" open={(clip.automation?.volume?.length ?? 0) > 0 || (clip.automation?.pan?.length ?? 0) > 0 || (clip.automation?.playbackRate?.length ?? 0) > 0}>
          <summary className="inspector-group-label">Audio / speed automation</summary>
          <div className="inspector-fields" style={{ marginTop: '0.5rem' }}>
            <KeyframeMiniEditor
              label="Volume"
              duration={getClipDuration(clip)}
              currentTime={clipLocalTime}
              keyframes={clip.automation?.volume}
              defaultValue={volumeValue}
              min={0}
              max={2}
              step={0.01}
              onChange={(track) => {
                const next: ClipAutomation = { ...(clip.automation ?? {}) };
                if (track?.length) next.volume = track;
                else delete next.volume;
                onAutomationChange(
                  Object.keys(next).length > 0 ? next : undefined,
                );
              }}
            />
            <KeyframeMiniEditor
              label="Pan"
              duration={getClipDuration(clip)}
              currentTime={clipLocalTime}
              keyframes={clip.automation?.pan}
              defaultValue={DEFAULT_CLIP_PAN}
              min={MIN_CLIP_PAN}
              max={MAX_CLIP_PAN}
              step={0.01}
              onChange={(track) => {
                const next: ClipAutomation = { ...(clip.automation ?? {}) };
                if (track?.length) next.pan = track;
                else delete next.pan;
                onAutomationChange(
                  Object.keys(next).length > 0 ? next : undefined,
                );
              }}
            />
            <KeyframeMiniEditor
              label="Speed (time remap)"
              duration={getClipDuration(clip)}
              currentTime={clipLocalTime}
              keyframes={clip.automation?.playbackRate}
              defaultValue={playbackRateValue}
              min={MIN_CLIP_PLAYBACK_RATE}
              max={MAX_CLIP_PLAYBACK_RATE}
              step={0.01}
              formatValue={(v) => `${v.toFixed(2)}×`}
              valueFieldLabel="rate"
              hitSizePx={32}
              onChange={(track) => {
                const next: ClipAutomation = { ...(clip.automation ?? {}) };
                if (track?.length) next.playbackRate = track;
                else delete next.playbackRate;
                onAutomationChange(
                  Object.keys(next).length > 0 ? next : undefined,
                );
              }}
            />
            <p className="inspector-hint">
              Speed keyframe times are output-local clip seconds; source time is the area under
              the rate curve (∫ rate dt). Export / preview share the same OfflineAudioContext
              premix when automation is present.
            </p>
          </div>
        </details>
      )}
      {onExtractAudio && (
        <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>Audio extraction</div>
      )}
      {onExtractAudio && (
        <button
          type="button"
          className="btn-secondary"
          style={{ marginTop: '0.25rem' }}
          onClick={onExtractAudio}
          title={
            clip.kind === 'audio'
              ? 'Convert this audio clip to a WAV file (PCM 44.1 kHz stereo). If a remote storage endpoint is configured, the WAV will also be uploaded there.'
              : 'Extract audio from this video clip to a WAV file. If a remote storage endpoint is configured, the WAV will also be uploaded there.'
          }
        >
          🎵 Extract Audio to WAV
        </button>
      )}
      {clip.remoteAudioUrl && (
        <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.25rem', wordBreak: 'break-all' }}>
          Remote WAV: <a href={clip.remoteAudioUrl} target="_blank" rel="noreferrer">{clip.remoteAudioUrl}</a>
        </div>
      )}
    </>
  );
}
