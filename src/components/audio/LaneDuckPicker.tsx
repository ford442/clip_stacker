import { DEFAULT_LANE_DUCK, DUCK_LIMITS, type LaneDuck, type LaneDuckSettings } from '../../utils/audioBus';
import { FxNumberField } from './FxNumberField';

export interface DuckCandidate {
  id: string;
  label: string;
}

export interface LaneDuckPickerProps {
  /** Lane label for accessible names. */
  label: string;
  /** Audio lanes have the legacy step; video lanes never ducked before buses. */
  isAudioLane: boolean;
  duck: LaneDuck | undefined;
  /** Lanes this one may key off (not itself, not titles lanes). */
  candidates: DuckCandidate[];
  disabled?: boolean;
  onChange: (next: LaneDuck | undefined, coalesce: boolean) => void;
}

const LEGACY = 'legacy';
const OFF = 'off';
const KEY = 'key:';

/**
 * "Duck under …": key this lane's level off another lane (sidechain), turn
 * ducking off, or keep the legacy fixed step on an audio lane.
 */
export function LaneDuckPicker({ label, isAudioLane, duck, candidates, disabled = false, onChange }: LaneDuckPickerProps) {
  const sidechain: LaneDuckSettings | null = typeof duck === 'object' ? duck : null;
  const value = sidechain ? `${KEY}${sidechain.sourceTrackId}` : duck === 'off' || !isAudioLane ? OFF : LEGACY;
  const keyMissing = sidechain !== null && !candidates.some((c) => c.id === sidechain.sourceTrackId);
  const set = (patch: Partial<LaneDuckSettings>) => onChange({ ...sidechain!, ...patch }, true);

  return (
    <div className="bus-duck">
      <label>
        Duck under
        <select
          value={value}
          disabled={disabled}
          aria-label={`${label} ducking`}
          onChange={(e) => {
            const next = e.target.value;
            if (next === LEGACY) onChange(undefined, false);
            else if (next === OFF) onChange(isAudioLane ? 'off' : undefined, false);
            else onChange({ ...DEFAULT_LANE_DUCK, ...(sidechain ?? {}), sourceTrackId: next.slice(KEY.length) }, false);
          }}
        >
          {isAudioLane && <option value={LEGACY}>Auto step (legacy): −9 dB while video lanes play</option>}
          <option value={OFF}>Nothing (no ducking)</option>
          {candidates.map((c) => (
            <option key={c.id} value={`${KEY}${c.id}`}>
              {c.label} (sidechain)
            </option>
          ))}
          {keyMissing && <option value={value}>(removed lane)</option>}
        </select>
      </label>
      {keyMissing && (
        <p className="inspector-warning">The key lane was removed: this duck is ignored until you pick another.</p>
      )}
      {sidechain && (
        <div className="inspector-fx-row">
          <FxNumberField label="Depth (dB)" value={sidechain.depthDb} {...DUCK_LIMITS.depthDb} step={0.5} disabled={disabled} title="How far this lane drops while the key plays." onCommit={(depthDb) => set({ depthDb })} />
          <FxNumberField label="Threshold (dB)" value={sidechain.thresholdDb} {...DUCK_LIMITS.thresholdDb} step={0.5} disabled={disabled} title="The key lane counts as playing above this peak level." onCommit={(thresholdDb) => set({ thresholdDb })} />
          <FxNumberField label="Attack (ms)" value={sidechain.attack} {...DUCK_LIMITS.attack} step={0.001} scale={1000} disabled={disabled} title="Time to reach the full depth." onCommit={(attack) => set({ attack })} />
          <FxNumberField label="Hold (ms)" value={sidechain.hold} {...DUCK_LIMITS.hold} step={0.001} scale={1000} disabled={disabled} title="Stays down this long after the key stops (bridges pauses between words)." onCommit={(hold) => set({ hold })} />
          <FxNumberField label="Release (ms)" value={sidechain.release} {...DUCK_LIMITS.release} step={0.001} scale={1000} disabled={disabled} title="Time to come back up." onCommit={(release) => set({ release })} />
        </div>
      )}
      <p className="inspector-hint">
        {sidechain
          ? 'A sidechain envelope follows the key lane: it ramps down while the key plays and back up after it stops — no stepping.'
          : 'Muted lanes key nothing.'}
      </p>
    </div>
  );
}
