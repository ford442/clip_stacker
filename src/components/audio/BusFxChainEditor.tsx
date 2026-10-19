import {
  COMPRESSOR_LIMITS,
  DEFAULT_EQ_BAND,
  EQ_BAND_TYPES,
  EQ_LIMITS,
  LIMITER_LIMITS,
  type AudioEqBand,
  type AudioEqBandType,
} from '../../utils/audioEffects';
import {
  BUS_EFFECT_LABELS,
  createBusEffect,
  DEESSER_LIMITS,
  GATE_LIMITS,
  MAX_BUS_EFFECTS,
  MAX_BUS_EQ_BANDS,
  type BusEffect,
  type BusEffectKind,
} from '../../utils/audioBus';
import { FxNumberField } from './FxNumberField';

/**
 * Edit an ordered bus insert chain (a lane's or the master's): add, reorder,
 * bypass, remove, and every effect's parameters. Stateless — the chain lives
 * in the editor store, so undo restores it and the preview retunes live.
 *
 * `onChange`'s `coalesce` is true for parameter edits (a drag or typing is
 * folded into one undo step) and false for structural ones (each its own).
 */
export interface BusFxChainEditorProps {
  fx: BusEffect[] | undefined;
  disabled?: boolean;
  /** Prefix for accessible names ("Dialogue", "Master"). */
  label: string;
  onChange: (next: BusEffect[] | undefined, coalesce: boolean) => void;
}

const ADDABLE: BusEffectKind[] = ['eq', 'compressor', 'gate', 'deesser', 'limiter'];

export function BusFxChainEditor({ fx, disabled = false, label, onChange }: BusFxChainEditorProps) {
  const chain = fx ?? [];
  const commit = (next: BusEffect[], coalesce: boolean) => onChange(next.length > 0 ? next : undefined, coalesce);
  const replace = (index: number, next: BusEffect, coalesce = true) =>
    commit(
      chain.map((effect, i) => (i === index ? next : effect)),
      coalesce,
    );
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    [next[index], next[target]] = [next[target]!, next[index]!];
    commit(next, false);
  };

  return (
    <div className="bus-fx-chain">
      {chain.length === 0 ? (
        <p className="inspector-hint">No effects: this bus passes its audio through untouched.</p>
      ) : (
        <ol className="bus-fx-list" aria-label={`${label} effects, in processing order`}>
          {chain.map((effect, index) => {
            const name = BUS_EFFECT_LABELS[effect.kind];
            return (
              <li key={effect.id} className={`bus-fx-item${effect.enabled ? '' : ' is-bypassed'}`}>
                <div className="bus-fx-item-header">
                  <label className="inspector-checkbox-label" title="Bypass without losing the settings.">
                    <input
                      type="checkbox"
                      checked={effect.enabled}
                      disabled={disabled}
                      aria-label={`${name} ${index + 1} enabled`}
                      onChange={(e) => replace(index, { ...effect, enabled: e.target.checked }, false)}
                    />
                    {name}
                  </label>
                  <span className="bus-fx-item-actions">
                    <button
                      type="button"
                      className="btn-secondary kf-btn"
                      disabled={disabled || index === 0}
                      aria-label={`Move ${name} ${index + 1} earlier`}
                      title="Process earlier"
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn-secondary kf-btn"
                      disabled={disabled || index === chain.length - 1}
                      aria-label={`Move ${name} ${index + 1} later`}
                      title="Process later"
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn-secondary kf-btn"
                      disabled={disabled}
                      aria-label={`Remove ${name} ${index + 1}`}
                      title="Remove"
                      onClick={() =>
                        commit(
                          chain.filter((_, i) => i !== index),
                          false,
                        )
                      }
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <EffectFields effect={effect} disabled={disabled} onChange={(next, c) => replace(index, next, c)} />
              </li>
            );
          })}
        </ol>
      )}
      <label className="bus-fx-add">
        Add effect
        <select
          value=""
          disabled={disabled || chain.length >= MAX_BUS_EFFECTS}
          aria-label={`Add an effect to ${label}`}
          onChange={(e) => {
            const kind = e.target.value as BusEffectKind;
            if (kind) commit([...chain, createBusEffect(kind)], false);
          }}
        >
          <option value="">{chain.length >= MAX_BUS_EFFECTS ? `Up to ${MAX_BUS_EFFECTS} effects` : 'Choose…'}</option>
          {ADDABLE.map((kind) => (
            <option key={kind} value={kind}>
              {BUS_EFFECT_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

interface EffectFieldsProps<T extends BusEffect = BusEffect> {
  effect: T;
  disabled: boolean;
  onChange: (next: T, coalesce: boolean) => void;
}

function EffectFields({ effect, disabled, onChange }: EffectFieldsProps) {
  switch (effect.kind) {
    case 'eq':
      return <EqFields effect={effect} disabled={disabled} onChange={onChange} />;
    case 'compressor': {
      const set = (patch: Partial<typeof effect>) => onChange({ ...effect, ...patch }, true);
      return (
        <div className="inspector-fx-row">
          <FxNumberField label="Threshold (dB)" value={effect.thresholdDb} {...COMPRESSOR_LIMITS.thresholdDb} step={0.5} disabled={disabled} onCommit={(thresholdDb) => set({ thresholdDb })} />
          <FxNumberField label="Ratio (:1)" value={effect.ratio} {...COMPRESSOR_LIMITS.ratio} step={0.5} disabled={disabled} onCommit={(ratio) => set({ ratio })} />
          <FxNumberField label="Knee (dB)" value={effect.kneeDb} {...COMPRESSOR_LIMITS.kneeDb} step={0.5} disabled={disabled} onCommit={(kneeDb) => set({ kneeDb })} />
          <FxNumberField label="Attack (ms)" value={effect.attack} {...COMPRESSOR_LIMITS.attack} step={0.001} scale={1000} disabled={disabled} onCommit={(attack) => set({ attack })} />
          <FxNumberField label="Release (ms)" value={effect.release} {...COMPRESSOR_LIMITS.release} step={0.001} scale={1000} disabled={disabled} onCommit={(release) => set({ release })} />
          <FxNumberField label="Make-up (dB)" value={effect.makeupDb} {...COMPRESSOR_LIMITS.makeupDb} step={0.5} disabled={disabled} onCommit={(makeupDb) => set({ makeupDb })} />
        </div>
      );
    }
    case 'gate': {
      const set = (patch: Partial<typeof effect>) => onChange({ ...effect, ...patch }, true);
      return (
        <div className="inspector-fx-row">
          <FxNumberField label="Threshold (dB)" value={effect.thresholdDb} {...GATE_LIMITS.thresholdDb} step={0.5} disabled={disabled} onCommit={(thresholdDb) => set({ thresholdDb })} />
          <FxNumberField label="Range (dB)" value={effect.rangeDb} {...GATE_LIMITS.rangeDb} step={1} disabled={disabled} title="Attenuation while the gate is closed." onCommit={(rangeDb) => set({ rangeDb })} />
          <FxNumberField label="Attack (ms)" value={effect.attack} {...GATE_LIMITS.attack} step={0.001} scale={1000} disabled={disabled} onCommit={(attack) => set({ attack })} />
          <FxNumberField label="Hold (ms)" value={effect.hold} {...GATE_LIMITS.hold} step={0.001} scale={1000} disabled={disabled} onCommit={(hold) => set({ hold })} />
          <FxNumberField label="Release (ms)" value={effect.release} {...GATE_LIMITS.release} step={0.001} scale={1000} disabled={disabled} onCommit={(release) => set({ release })} />
        </div>
      );
    }
    case 'deesser': {
      const set = (patch: Partial<typeof effect>) => onChange({ ...effect, ...patch }, true);
      return (
        <div className="inspector-fx-row">
          <FxNumberField label="Frequency (Hz)" value={effect.frequency} {...DEESSER_LIMITS.frequency} step={100} disabled={disabled} title="Sibilance above this is detected and shelved down." onCommit={(frequency) => set({ frequency })} />
          <FxNumberField label="Threshold (dB)" value={effect.thresholdDb} {...DEESSER_LIMITS.thresholdDb} step={0.5} disabled={disabled} onCommit={(thresholdDb) => set({ thresholdDb })} />
          <FxNumberField label="Ratio (:1)" value={effect.ratio} {...DEESSER_LIMITS.ratio} step={0.5} disabled={disabled} onCommit={(ratio) => set({ ratio })} />
          <FxNumberField label="Range (dB)" value={effect.rangeDb} {...DEESSER_LIMITS.rangeDb} step={0.5} disabled={disabled} title="The most the shelf cuts." onCommit={(rangeDb) => set({ rangeDb })} />
        </div>
      );
    }
    case 'limiter': {
      const set = (patch: Partial<typeof effect>) => onChange({ ...effect, ...patch }, true);
      return (
        <div className="inspector-fx-row">
          <FxNumberField label="Ceiling (dBTP)" value={effect.ceilingDb} {...LIMITER_LIMITS.ceilingDb} step={0.1} disabled={disabled} title="True peak: neither samples nor the peaks between them exceed it." onCommit={(ceilingDb) => set({ ceilingDb })} />
          <FxNumberField label="Look-ahead (ms)" value={effect.lookahead} {...LIMITER_LIMITS.lookahead} step={0.0005} scale={1000} disabled={disabled} title="Adds this much delay; every lane is compensated." onCommit={(lookahead) => set({ lookahead })} />
          <FxNumberField label="Release (ms)" value={effect.release} {...LIMITER_LIMITS.release} step={0.001} scale={1000} disabled={disabled} onCommit={(release) => set({ release })} />
        </div>
      );
    }
  }
}

function EqFields({ effect, disabled, onChange }: EffectFieldsProps<Extract<BusEffect, { kind: 'eq' }>>) {
  const setBands = (bands: AudioEqBand[], coalesce: boolean) => onChange({ ...effect, bands }, coalesce);
  const update = (index: number, patch: Partial<AudioEqBand>, coalesce = true) =>
    setBands(
      effect.bands.map((band, i) => (i === index ? { ...band, ...patch } : band)),
      coalesce,
    );
  return (
    <div className="bus-fx-eq">
      {effect.bands.map((band, index) => (
        <div className="inspector-fx-band" key={index}>
          <div className="inspector-fx-band-header">
            <label className="inspector-checkbox-label" title="Bypass this band.">
              <input
                type="checkbox"
                checked={band.enabled}
                disabled={disabled}
                onChange={(e) => update(index, { enabled: e.target.checked }, false)}
              />
              Band {index + 1}
            </label>
            <select
              value={band.type}
              disabled={disabled}
              aria-label={`Band ${index + 1} type`}
              onChange={(e) => update(index, { type: e.target.value as AudioEqBandType }, false)}
            >
              {EQ_BAND_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary kf-btn"
              disabled={disabled || effect.bands.length <= 1}
              title={effect.bands.length <= 1 ? 'An EQ keeps at least one band (remove the EQ instead)' : 'Remove this band'}
              aria-label={`Remove band ${index + 1}`}
              onClick={() =>
                setBands(
                  effect.bands.filter((_, i) => i !== index),
                  false,
                )
              }
            >
              ✕
            </button>
          </div>
          <div className="inspector-fx-row">
            <FxNumberField label="Freq (Hz)" value={band.frequency} {...EQ_LIMITS.frequency} step={1} disabled={disabled} onCommit={(frequency) => update(index, { frequency })} />
            <FxNumberField label="Q" value={band.q} {...EQ_LIMITS.q} step={0.05} disabled={disabled} onCommit={(q) => update(index, { q })} />
            {band.type !== 'highPass' && band.type !== 'lowPass' && (
              <FxNumberField label="Gain (dB)" value={band.gainDb} {...EQ_LIMITS.gainDb} step={0.5} disabled={disabled} onCommit={(gainDb) => update(index, { gainDb })} />
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary kf-btn"
        disabled={disabled || effect.bands.length >= MAX_BUS_EQ_BANDS}
        title={`Up to ${MAX_BUS_EQ_BANDS} bands, applied in order.`}
        onClick={() => setBands([...effect.bands, { ...DEFAULT_EQ_BAND }], false)}
      >
        + Add band
      </button>
    </div>
  );
}
