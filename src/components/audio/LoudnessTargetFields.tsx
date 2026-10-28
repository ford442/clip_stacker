import { editorActions, useEditorMasterBus } from '../../store';
import {
  DEFAULT_TRUE_PEAK_DB,
  LOUDNESS_LIMITS,
  LOUDNESS_PRESETS,
  type LoudnessTarget,
} from '../../utils/audioBus';
import { FxNumberField } from './FxNumberField';

const OFF = 'off';
const CUSTOM = 'custom';

/**
 * Export → Loudness: normalize the delivered mix to a delivery target. The
 * setting lives on the project's master bus (so it is saved and undoable);
 * the export applies it in two passes over the media engine's bus graph.
 */
export function LoudnessTargetFields() {
  const masterBus = useEditorMasterBus();
  const target = masterBus?.loudness;
  const preset = target ? (LOUDNESS_PRESETS.find((p) => p.targetLufs === target.targetLufs)?.id ?? CUSTOM) : OFF;

  const setTarget = (next: LoudnessTarget | undefined, coalesce = false) => {
    const { loudness: _previous, ...rest } = masterBus ?? {};
    editorActions.setMasterBus({ ...rest, ...(next ? { loudness: next } : {}) }, coalesce ? 'loudness' : undefined);
  };

  return (
    <>
      <label title="Measure the whole mix, then gain it to this integrated loudness and true-peak limit it.">
        Loudness target
        <select
          value={preset}
          onChange={(e) => {
            const id = e.target.value;
            const truePeakDb = target?.truePeakDb ?? DEFAULT_TRUE_PEAK_DB;
            if (id === OFF) setTarget(undefined);
            else if (id === CUSTOM) setTarget({ targetLufs: target?.targetLufs ?? -18, truePeakDb });
            else setTarget({ targetLufs: LOUDNESS_PRESETS.find((p) => p.id === id)!.targetLufs, truePeakDb });
          }}
        >
          <option value={OFF}>Off (the mix&apos;s own level)</option>
          {LOUDNESS_PRESETS.map((p) => (
            <option key={p.id} value={p.id} title={p.detail}>
              {p.label} {p.targetLufs} LUFS
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>
      {target && (
        <div className="inspector-fx-row">
          {preset === CUSTOM && (
            <FxNumberField
              label="Target (LUFS)"
              value={target.targetLufs}
              {...LOUDNESS_LIMITS.targetLufs}
              step={0.5}
              onCommit={(targetLufs) => setTarget({ ...target, targetLufs }, true)}
            />
          )}
          <FxNumberField
            label="True-peak ceiling (dBTP)"
            value={target.truePeakDb}
            {...LOUDNESS_LIMITS.truePeakDb}
            step={0.1}
            title="The final limiter's ceiling, measured 4x oversampled."
            onCommit={(truePeakDb) => setTarget({ ...target, truePeakDb }, true)}
          />
        </div>
      )}
      {preset !== OFF && preset !== CUSTOM && (
        <p className="inspector-hint">{LOUDNESS_PRESETS.find((p) => p.id === preset)!.detail}.</p>
      )}
      <p className="inspector-hint">
        {target
          ? 'Export runs the mix twice: once to measure integrated loudness (BS.1770, gated), then with the gain that lands it on the target and a true-peak limiter. Preview plays the mix un-normalized: open the LUFS meter on the Master row to see where it sits.'
          : 'Streaming services, podcasts and broadcast all normalize loudness; exporting at their target keeps the mix from being turned down or sounding weak next to everything else.'}
      </p>
    </>
  );
}
