import { useCallback, useEffect, useState } from 'react';
import { audioFxStore, useAudioFxMeters, useAudioFxPreview } from '../../store/audioFxStore';
import { useEditorMasterBus } from '../../store';
import { getAudioPlaybackManager } from '../../audio/playbackManager';

const STORAGE_KEY = 'clip_stacker.loudnessMeter.v1';
/** Bar scale: -36 LUFS (empty) to 0 (full). */
const FLOOR_LUFS = -36;

function loadOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'open';
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // View state only: a private window simply forgets it.
  }
}

/** Whether the loudness meter is shown (per browser, view state). */
export function useLoudnessMeterOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(loadOpen);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      saveOpen(!prev);
      return !prev;
    });
  }, []);
  return [open, toggle];
}

export function formatLufs(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? value.toFixed(1) : '−∞';
}

function barPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, ((value - FLOOR_LUFS) / -FLOOR_LUFS) * 100));
}

export function LoudnessMeterToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`timeline-lane-toggle loudness-meter-toggle${open ? ' is-active' : ''}`}
      aria-pressed={open}
      onClick={onToggle}
      title="Loudness meter (ITU-R BS.1770 / EBU mode) on the preview output"
    >
      LUFS
    </button>
  );
}

/**
 * EBU-mode loudness readout on the preview output: momentary, short-term and
 * integrated loudness, loudness range and true peak, from the same BS.1770
 * meter the export uses. Mounted, it keeps the preview's bus graph running
 * (as a pure meter on a project with no FX).
 */
export function LoudnessMeterReadout() {
  const meters = useAudioFxMeters();
  const preview = useAudioFxPreview();
  const target = useEditorMasterBus()?.loudness;

  useEffect(() => audioFxStore.getState().requestMeter(), []);

  const unavailable =
    preview.state === 'failed' ? preview.reason : preview.state === 'disabled' ? '?no_audio_fx' : null;
  if (unavailable) {
    return <span className="loudness-meter-note">Loudness meter unavailable ({unavailable})</span>;
  }
  const overCeiling = target && meters && Number.isFinite(meters.truePeak) && meters.truePeak > target.truePeakDb;
  return (
    <div className="loudness-meter" role="group" aria-label="Loudness meter">
      <span className="loudness-meter-bar" title="Momentary loudness" aria-hidden="true">
        <span className="loudness-meter-bar-fill" style={{ width: `${barPercent(meters?.momentary)}%` }} />
        {target && (
          <span
            className="loudness-meter-target"
            style={{ left: `${barPercent(target.targetLufs)}%` }}
            title={`Export target ${target.targetLufs} LUFS`}
          />
        )}
      </span>
      <span className="loudness-meter-readouts">
        <span title="Momentary loudness (400 ms)">M {formatLufs(meters?.momentary)}</span>
        <span title="Short-term loudness (3 s)">S {formatLufs(meters?.shortTerm)}</span>
        <span title="Integrated programme loudness since the last reset" className="loudness-meter-integrated">
          I {formatLufs(meters?.integrated)} LUFS
        </span>
        <span title="Loudness range (EBU Tech 3342)">LRA {(meters?.range ?? 0).toFixed(1)} LU</span>
        <span
          title="Highest true peak since the last reset (4x oversampled)"
          className={overCeiling ? 'loudness-meter-over' : undefined}
        >
          TP {formatLufs(meters?.truePeak)} dBTP
        </span>
      </span>
      <button
        type="button"
        className="btn-secondary kf-btn"
        onClick={() => getAudioPlaybackManager().resetBusMeter()}
        title="Restart the integrated, range and peak measurement"
      >
        Reset
      </button>
      {!meters && <span className="loudness-meter-note">Play to measure</span>}
      {target && (
        <span className="loudness-meter-note">
          Preview is un-normalized; export lands on {target.targetLufs} LUFS.
        </span>
      )}
    </div>
  );
}
