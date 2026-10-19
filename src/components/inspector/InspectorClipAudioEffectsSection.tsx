import { useEffect, useRef, useState } from 'react';
import {
  COMPRESSOR_LIMITS,
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ_BAND,
  EQ_BAND_TYPES,
  EQ_LIMITS,
  MAX_EQ_BANDS,
  type AudioCompressorSettings,
  type AudioEqBand,
  type AudioEqBandType,
  type ClipAudioEffects,
} from '../../utils/audioEffects';
import { getMediaEngineLoadFailure, isMediaEngineMixEnabled } from '../../wasm/mediaEngine';

/**
 * A drag rebuilds the clip's processed preview buffer (a full C++ pass), so
 * slider moves commit after this much idle time instead of per input event.
 */
export const AUDIO_EFFECTS_COMMIT_DEBOUNCE_MS = 150;

interface InspectorClipAudioEffectsSectionProps {
  clipId: string;
  effects: ClipAudioEffects | undefined;
  onChange: (clipId: string, effects: ClipAudioEffects | undefined) => void;
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Display scale (e.g. 1000 shows seconds as ms). */
  scale?: number;
  title?: string;
  onCommit: (value: number) => void;
}

/**
 * Typing is free-form; only in-range values commit, and the field snaps back
 * to the stored value on blur — so "5" on the way to "500 Hz" is not clamped
 * to the 20 Hz minimum mid-keystroke.
 */
function NumberField({ label, value, min, max, step, scale = 1, title, onCommit }: NumberFieldProps) {
  const shown = Number((value * scale).toFixed(4));
  const [text, setText] = useState(String(shown));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(shown));
  }, [shown]);
  return (
    <label className="inspector-fx-field" title={title}>
      {label}
      <input
        type="number"
        min={min * scale}
        max={max * scale}
        step={step * scale}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(shown));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number(e.target.value) / scale;
          if (e.target.value.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onCommit(parsed);
          }
        }}
      />
    </label>
  );
}

export function InspectorClipAudioEffectsSection({
  clipId,
  effects,
  onChange,
}: InspectorClipAudioEffectsSectionProps) {
  const [draft, setDraft] = useState<ClipAudioEffects | undefined>(effects);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Carries its own clip id: a commit still pending when the selection moves
  // must land on the clip it was made for.
  const pending = useRef<{ clipId: string; effects: ClipAudioEffects | undefined } | null>(null);

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) onChangeRef.current(next.clipId, next.effects);
  };

  // Mirror store changes (undo, load, another clip) unless a commit is pending.
  useEffect(() => {
    if (pending.current === null) setDraft(effects);
  }, [effects]);
  useEffect(() => {
    setDraft(effects);
    return flush;
    // Only on selection change; `effects` is handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  const commit = (next: ClipAudioEffects | undefined, immediate = false) => {
    setDraft(next);
    pending.current = { clipId, effects: next };
    if (timer.current !== null) clearTimeout(timer.current);
    if (immediate) {
      flush();
    } else {
      timer.current = setTimeout(flush, AUDIO_EFFECTS_COMMIT_DEBOUNCE_MS);
    }
  };

  const bands = draft?.eq ?? [];
  const compressor = draft?.compressor;

  const setBands = (eq: AudioEqBand[], immediate = false) => {
    commit({ ...(eq.length > 0 ? { eq } : {}), ...(compressor ? { compressor } : {}) }, immediate);
  };
  const updateBand = (index: number, patch: Partial<AudioEqBand>, immediate = false) => {
    setBands(
      bands.map((band, i) => (i === index ? { ...band, ...patch } : band)),
      immediate,
    );
  };
  const setCompressor = (next: AudioCompressorSettings | undefined, immediate = false) => {
    commit({ ...(bands.length > 0 ? { eq: bands } : {}), ...(next ? { compressor: next } : {}) }, immediate);
  };
  const updateCompressor = (patch: Partial<AudioCompressorSettings>, immediate = false) => {
    setCompressor({ ...(compressor ?? DEFAULT_COMPRESSOR), ...patch }, immediate);
  };

  const engineOff = !isMediaEngineMixEnabled();
  const engineFailure = getMediaEngineLoadFailure();

  return (
    <>
      <div className="inspector-group-label">Audio effects</div>
      <div className="inspector-fx-panel">
        {bands.map((band, index) => (
          <div className="inspector-fx-band" key={index}>
            <div className="inspector-fx-band-header">
              <label className="inspector-checkbox-label" title="Bypass this band without losing its settings.">
                <input
                  type="checkbox"
                  checked={band.enabled}
                  onChange={(e) => updateBand(index, { enabled: e.target.checked }, true)}
                />
                EQ {index + 1}
              </label>
              <select
                value={band.type}
                aria-label={`EQ ${index + 1} type`}
                onChange={(e) => updateBand(index, { type: e.target.value as AudioEqBandType }, true)}
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
                title="Remove this band"
                onClick={() => setBands(bands.filter((_, i) => i !== index), true)}
              >
                ✕
              </button>
            </div>
            <div className="inspector-fx-row">
              <NumberField
                label="Freq (Hz)"
                value={band.frequency}
                min={EQ_LIMITS.frequency.min}
                max={EQ_LIMITS.frequency.max}
                step={1}
                onCommit={(frequency) => updateBand(index, { frequency })}
              />
              <NumberField
                label="Q"
                value={band.q}
                min={EQ_LIMITS.q.min}
                max={EQ_LIMITS.q.max}
                step={0.05}
                onCommit={(q) => updateBand(index, { q })}
              />
            </div>
            {band.type !== 'highPass' && band.type !== 'lowPass' && (
              <label className="inspector-volume-slider">
                Gain {band.gainDb > 0 ? '+' : ''}
                {band.gainDb.toFixed(1)} dB
                <input
                  type="range"
                  min={EQ_LIMITS.gainDb.min}
                  max={EQ_LIMITS.gainDb.max}
                  step="0.5"
                  value={band.gainDb}
                  onChange={(e) => updateBand(index, { gainDb: Number(e.target.value) })}
                  onPointerUp={flush}
                />
              </label>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary kf-btn"
          disabled={bands.length >= MAX_EQ_BANDS}
          title={`Up to ${MAX_EQ_BANDS} bands, applied in order before the compressor.`}
          onClick={() => setBands([...bands, { ...DEFAULT_EQ_BAND }], true)}
        >
          + Add EQ band
        </button>

        <label className="inspector-checkbox-label" title="Feed-forward soft-knee compressor, stereo linked.">
          <input
            type="checkbox"
            checked={Boolean(compressor?.enabled)}
            onChange={(e) => updateCompressor({ enabled: e.target.checked }, true)}
          />
          Compressor
        </label>
        {compressor?.enabled && (
          <>
            <label className="inspector-volume-slider">
              Threshold {compressor.thresholdDb.toFixed(1)} dB
              <input
                type="range"
                min={COMPRESSOR_LIMITS.thresholdDb.min}
                max={COMPRESSOR_LIMITS.thresholdDb.max}
                step="0.5"
                value={compressor.thresholdDb}
                onChange={(e) => updateCompressor({ thresholdDb: Number(e.target.value) })}
                onPointerUp={flush}
              />
            </label>
            <div className="inspector-fx-row">
              <NumberField
                label="Ratio (:1)"
                value={compressor.ratio}
                min={COMPRESSOR_LIMITS.ratio.min}
                max={COMPRESSOR_LIMITS.ratio.max}
                step={0.5}
                onCommit={(ratio) => updateCompressor({ ratio })}
              />
              <NumberField
                label="Knee (dB)"
                value={compressor.kneeDb}
                min={COMPRESSOR_LIMITS.kneeDb.min}
                max={COMPRESSOR_LIMITS.kneeDb.max}
                step={0.5}
                onCommit={(kneeDb) => updateCompressor({ kneeDb })}
              />
            </div>
            <div className="inspector-fx-row">
              <NumberField
                label="Attack (ms)"
                value={compressor.attack}
                min={COMPRESSOR_LIMITS.attack.min}
                max={COMPRESSOR_LIMITS.attack.max}
                step={0.001}
                scale={1000}
                onCommit={(attack) => updateCompressor({ attack })}
              />
              <NumberField
                label="Release (ms)"
                value={compressor.release}
                min={COMPRESSOR_LIMITS.release.min}
                max={COMPRESSOR_LIMITS.release.max}
                step={0.001}
                scale={1000}
                onCommit={(release) => updateCompressor({ release })}
              />
              <NumberField
                label="Make-up (dB)"
                value={compressor.makeupDb}
                min={COMPRESSOR_LIMITS.makeupDb.min}
                max={COMPRESSOR_LIMITS.makeupDb.max}
                step={0.5}
                onCommit={(makeupDb) => updateCompressor({ makeupDb })}
              />
            </div>
          </>
        )}
        {engineOff || engineFailure ? (
          <p className="inspector-warning">
            {engineOff
              ? 'Media engine disabled (?no_media_engine): effects are bypassed in preview and export.'
              : `Media engine unavailable (${engineFailure}): effects are bypassed.`}
          </p>
        ) : (
          <p className="inspector-hint">
            EQ, then compression, before the clip&apos;s volume, fades and pan. Preview and export run the
            same media-engine DSP.
          </p>
        )}
      </div>
    </>
  );
}
