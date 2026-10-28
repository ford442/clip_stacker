import { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip } from '../types';
import {
  editorActions,
  useEditorClips,
  useEditorMasterAudio,
  useEditorTracks,
} from '../store';
import { settingsStore } from '../store/settingsStore';
import {
  buildBeatmatchTargets,
  clipItemStartTime,
  downbeatStartTime,
  snapStartToTargetBeat,
} from '../utils/beatmatch';
import { sanitizeClipAdjustments } from '../utils/project';
import {
  confidenceLabel,
  getClipBpm,
  matchRate,
  tapTempo,
} from '../utils/tempo';

interface Props {
  clip: Clip;
  /** Current rate from the Speed panel's edit buffer. */
  playbackRate: number;
  /** Routes through the Speed panel so Out duration updates with the match. */
  onPlaybackRateChange: (rate: number) => void;
}

const MASTER_TARGET_ID = 'master';
/** Taps older than this start a fresh measurement. */
const TAP_RESET_SEC = 3;

function setStatus(message: string): void {
  settingsStore.getState().setStatus(message);
}

/** Move a clip's track item to a new timeline start time. */
function moveClipStart(clipId: string, startTime: number): void {
  editorActions.setTracks((tracks) =>
    tracks.map((track) => {
      if (!track.items.some((item) => item.clipId === clipId)) return track;
      return {
        ...track,
        items: track.items
          .map((item) => (item.clipId === clipId ? { ...item, startTime } : item))
          .sort((a, b) => a.startTime - b.startTime),
      };
    }),
  );
}

/**
 * Beatmatch controls for the selected clip: read/override its tempo, pick a
 * tempo reference (master audio or another clip) and match rate / downbeat.
 */
export function BeatmatchPanel({ clip, playbackRate, onPlaybackRateChange }: Props) {
  const clips = useEditorClips();
  const tracks = useEditorTracks();
  const masterAudio = useEditorMasterAudio();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState('');
  const tapsRef = useRef<number[]>([]);
  const [tapCount, setTapCount] = useState(0);
  const clipOverrideRef = useRef(clip.bpmOverride);
  clipOverrideRef.current = clip.bpmOverride;

  const targets = useMemo(
    () => buildBeatmatchTargets(masterAudio, clips, tracks, clip.id),
    [masterAudio, clips, tracks, clip.id],
  );

  // Default to the master track when it has a tempo, else the first candidate.
  const effectiveTargetId =
    targets.find((t) => t.id === targetId)?.id ??
    targets.find((t) => t.id === MASTER_TARGET_ID)?.id ??
    targets[0]?.id ??
    null;
  const target = targets.find((t) => t.id === effectiveTargetId) ?? null;

  const followerBpm = getClipBpm(clip);
  const detected = clip.bpmEstimate;

  // Reset the local edit buffers when the selection changes. The draft is not
  // resynced from the clip while editing, so a partially typed "0." survives.
  useEffect(() => {
    setOverrideDraft(clipOverrideRef.current != null ? String(clipOverrideRef.current) : '');
    tapsRef.current = [];
    setTapCount(0);
  }, [clip.id]);

  const updateClip = (mutate: (next: Clip) => void) => {
    editorActions.pushHistoryDebounced(`beatmatch:${clip.id}`);
    editorActions.setClips((prev) =>
      prev.map((c) => {
        if (c.id !== clip.id) return c;
        const next = { ...c };
        mutate(next);
        sanitizeClipAdjustments(next);
        return next;
      }),
    );
  };

  const commitOverride = (bpm: number | null) => {
    updateClip((next) => {
      if (bpm == null || !(bpm > 0)) delete next.bpmOverride;
      else next.bpmOverride = bpm;
    });
  };

  /** Set the override and mirror it into the input (tap / half / double / clear). */
  const setOverride = (bpm: number | null) => {
    setOverrideDraft(bpm == null ? '' : String(bpm));
    commitOverride(bpm);
  };

  const handleTap = () => {
    const now = Date.now() / 1000;
    const taps = tapsRef.current;
    const last = taps[taps.length - 1];
    if (last != null && now - last > TAP_RESET_SEC) taps.length = 0;
    taps.push(now);
    setTapCount(taps.length);

    const bpm = tapTempo(taps);
    if (bpm != null) {
      setOverride(Number(bpm.toFixed(1)));
      setStatus(`Tapped ${bpm.toFixed(1)} BPM.`);
    }
  };

  const handleReanalyze = () => {
    editorActions.pushHistory();
    editorActions.setClips((prev) =>
      prev.map((c) => {
        if (c.id !== clip.id) return c;
        const next = { ...c };
        delete next.beatTimestamps;
        delete next.bpmEstimate;
        delete next.bpmConfidence;
        return next;
      }),
    );
    setStatus('Re-analyzing clip beats…');
  };

  const handleMatch = (alignDownbeat: boolean) => {
    if (followerBpm == null || !target) return;
    const rate = matchRate(followerBpm, target.bpm);
    const tempoLabel = `${followerBpm.toFixed(1)} → ${target.bpm.toFixed(1)} BPM (${rate}× speed)`;

    if (!alignDownbeat) {
      onPlaybackRateChange(rate);
      setStatus(`Matched ${tempoLabel}.`);
      return;
    }

    // The clip's first beat lands where the *new* rate puts it, so plan the
    // move against `rate` rather than the rate currently stored on the clip.
    const itemStart = clipItemStartTime(tracks, clip.id);
    const nextStart = downbeatStartTime(clip, itemStart, rate, target);
    if (nextStart == null) {
      onPlaybackRateChange(rate);
      setStatus(`Matched ${tempoLabel} — no beat available to align downbeats.`);
      return;
    }
    // Snapshot before the move; the rate change pushes its own history entry.
    editorActions.pushHistory();
    moveClipStart(clip.id, nextStart);
    onPlaybackRateChange(rate);
    setStatus(`Matched ${tempoLabel} and moved the clip start to ${nextStart.toFixed(2)}s.`);
  };

  const handleSnapStart = () => {
    const itemStart = clipItemStartTime(tracks, clip.id);
    const snapped = snapStartToTargetBeat(itemStart, target);
    if (snapped == null) {
      setStatus('No target beats to snap to — load master audio or analyze a clip.');
      return;
    }
    editorActions.pushHistory();
    moveClipStart(clip.id, snapped);
    setStatus(`Snapped clip start to ${snapped.toFixed(2)}s (nearest ${target!.label} beat).`);
  };

  const matchDisabledReason =
    followerBpm == null
      ? 'No BPM for this clip (no detectable beats — type or tap one).'
      : !target
        ? 'No tempo target — load master audio or analyze another clip.'
        : null;

  const previewRate =
    followerBpm != null && target ? matchRate(followerBpm, target.bpm) : null;

  return (
    <div className="inspector-beatmatch">
      <div className="inspector-group-label">Beatmatch</div>

      <div className="inspector-speed-row">
        <span className="inspector-speed-meta">
          {detected != null && detected > 0 ? (
            <>
              Detected {detected.toFixed(1)} BPM
              <span className="beatmatch-confidence">
                {' '}
                · {confidenceLabel(clip.bpmConfidence)} confidence (
                {Math.round((clip.bpmConfidence ?? 0) * 100)}%)
              </span>
            </>
          ) : (
            <>No detected BPM</>
          )}
        </span>
        <button
          type="button"
          className="btn-secondary kf-btn"
          onClick={handleReanalyze}
          title="Clear beat metadata so offline analysis runs again"
        >
          Re-analyze
        </button>
      </div>

      <div className="inspector-speed-row">
        <label className="inspector-speed-field" title="Manual BPM. Overrides the detected value.">
          BPM override
          <input
            type="number"
            min="1"
            step="0.1"
            placeholder={detected != null ? detected.toFixed(1) : 'BPM'}
            value={overrideDraft}
            onChange={(e) => {
              setOverrideDraft(e.target.value);
              const value = Number(e.target.value);
              commitOverride(e.target.value === '' || !(value > 0) ? null : value);
            }}
          />
        </label>
        <div className="inspector-speed-nudges" role="group" aria-label="Tempo override">
          <button
            type="button"
            className="btn-secondary kf-btn"
            onClick={handleTap}
            title="Tap in time with the music (4 taps minimum)"
          >
            Tap{tapCount > 0 ? ` (${tapCount})` : ''}
          </button>
          <button
            type="button"
            className="btn-secondary kf-btn"
            disabled={followerBpm == null}
            onClick={() => followerBpm != null && setOverride(Number((followerBpm / 2).toFixed(1)))}
            title="Halve the clip BPM"
          >
            ½×
          </button>
          <button
            type="button"
            className="btn-secondary kf-btn"
            disabled={followerBpm == null}
            onClick={() => followerBpm != null && setOverride(Number((followerBpm * 2).toFixed(1)))}
            title="Double the clip BPM"
          >
            2×
          </button>
          <button
            type="button"
            className="btn-secondary kf-btn"
            disabled={clip.bpmOverride == null}
            onClick={() => setOverride(null)}
            title="Drop the manual BPM and use the detected value"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="inspector-speed-row">
        <label className="inspector-speed-field" title="Tempo reference to match against.">
          Target
          <select
            value={effectiveTargetId ?? ''}
            disabled={targets.length === 0}
            onChange={(e) => setTargetId(e.target.value || null)}
          >
            {targets.length === 0 && <option value="">No tempo targets</option>}
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} — {t.bpm.toFixed(1)} BPM
              </option>
            ))}
          </select>
        </label>
        <span className="inspector-speed-meta">
          {followerBpm != null ? `Clip ${followerBpm.toFixed(1)} BPM` : 'Clip BPM unknown'}
          {previewRate != null && (
            <>
              {' '}
              → {previewRate}× (now {playbackRate}×)
            </>
          )}
        </span>
      </div>

      <div className="inspector-speed-presets">
        <button
          type="button"
          className="btn-secondary kf-btn"
          disabled={matchDisabledReason != null}
          onClick={() => handleMatch(false)}
        >
          Match tempo
        </button>
        <button
          type="button"
          className="btn-secondary kf-btn"
          disabled={matchDisabledReason != null}
          onClick={() => handleMatch(true)}
        >
          Match tempo + downbeat
        </button>
        <button
          type="button"
          className="btn-secondary kf-btn"
          disabled={!target?.beatsAbs.length}
          onClick={handleSnapStart}
          title="Move this clip's start to the nearest target beat"
        >
          Snap start to beat
        </button>
      </div>

      {matchDisabledReason && (
        <p className="inspector-hint" role="status">
          {matchDisabledReason}
        </p>
      )}
    </div>
  );
}
