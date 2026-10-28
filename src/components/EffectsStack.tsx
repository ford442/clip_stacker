import { memo, useState } from 'react';
import { useStore } from 'zustand';
import { layoutActions, settingsActions, settingsStore, uiActions, useFinishingView } from '../store';
import {
  FINISHING_STACK_PASSES,
  isFinishingViewActive,
  isPassContributing,
  isPassEnabled,
  passAmount,
  setPassAmount,
  setPassEnabled,
  type FinishingPassKey,
} from '../utils/finishingStack';
import { loadSectionState, revealSection, saveSectionOpen, isSectionOpen } from '../utils/sectionState';
import {
  applyFinishingPresetDocument,
  finishingPresetStore,
  listFinishingPresets,
} from '../store/finishingPresetStore';

const DETAILS_SECTION_ID = 'preview.effectsStack';
const FINISHING_SECTION_ID = 'export.finishing';

/** Open the detailed Finishing controls in the Inspector's Export tab. */
function editPass() {
  layoutActions.setSideCollapsed('inspector', false);
  uiActions.requestInspectorTab('export');
  revealSection(FINISHING_SECTION_ID);
}

/**
 * Compact finishing stack docked under the preview: toggle every pass on or
 * off, scale it, bypass the whole chain, or show one pass "before" while
 * watching the image. Enable and amount edits are real project edits (the same
 * `FinishingSettings` the detailed panels edit); bypass and "before" are
 * preview-only view state and never reach an export.
 */
function EffectsStackImpl() {
  const finishing = useStore(settingsStore, (s) => s.finishing);
  const userPresets = useStore(finishingPresetStore, (s) => s.presets);
  const presets = listFinishingPresets(userPresets);
  const view = useFinishingView();
  const [detailsOpen, setDetailsOpen] = useState(() =>
    isSectionOpen(DETAILS_SECTION_ID, false, loadSectionState()),
  );
  const { setFinishing } = settingsActions;
  const viewActive = isFinishingViewActive(view);
  const enabledCount = FINISHING_STACK_PASSES.filter((p) => isPassEnabled(finishing, p.key)).length;

  const toggleDetails = () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    saveSectionOpen(DETAILS_SECTION_ID, next);
  };

  return (
    <section className="effects-stack" aria-label="Finishing effects stack">
      <div className="effects-stack-bar">
        <span className="effects-stack-title">Effects</span>
        <div className="effects-stack-chips" role="group" aria-label="Finishing passes">
          {FINISHING_STACK_PASSES.map((pass) => {
            const enabled = isPassEnabled(finishing, pass.key);
            const noEffect = enabled && !isPassContributing(finishing, pass.key);
            return (
              <label
                key={pass.key}
                className={`effects-chip${enabled ? ' is-on' : ''}${noEffect ? ' is-idle' : ''}`}
                title={
                  noEffect
                    ? `${pass.label}: on, but nothing to apply yet — open Edit to set it up`
                    : `${pass.label}: ${enabled ? 'on' : 'off'}`
                }
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setFinishing(setPassEnabled(finishing, pass.key, e.target.checked))}
                />
                {pass.chip}
              </label>
            );
          })}
        </div>
        <select
          className="effects-preset-select"
          aria-label="Apply a finishing preset"
          title="Apply a saved finishing preset (one undo step). Manage presets under Edit."
          value=""
          onChange={(e) => {
            const preset = presets.find((p) => p.key === e.target.value);
            if (preset) applyFinishingPresetDocument(preset.doc);
          }}
        >
          <option value="">Preset…</option>
          {presets.map((p) => (
            <option key={p.key} value={p.key}>
              {p.doc.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`effects-bypass${view.bypassAll ? ' is-active' : ''}`}
          aria-pressed={view.bypassAll}
          onClick={() => uiActions.setFinishingBypassAll(!view.bypassAll)}
          title="Show the raw composite in the preview. Settings are kept and exports still apply the chain."
        >
          Bypass all
        </button>
        <button
          type="button"
          className="effects-details-toggle"
          aria-expanded={detailsOpen}
          onClick={toggleDetails}
        >
          {detailsOpen ? 'Hide details' : `Details (${enabledCount} on)`}
        </button>
      </div>

      {detailsOpen && (
        <ul className="effects-stack-list">
          {FINISHING_STACK_PASSES.map((pass) => {
            const enabled = isPassEnabled(finishing, pass.key);
            const before = view.before.includes(pass.key);
            return (
              <li key={pass.key} className={`effects-row${enabled ? '' : ' is-off'}`}>
                <label className="effects-row-name">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setFinishing(setPassEnabled(finishing, pass.key, e.target.checked))}
                  />
                  {pass.label}
                </label>
                <label className="effects-row-amount" title="Strength: 0 turns the pass's effect off without disabling it">
                  <span className="visually-hidden">{pass.label} amount</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={passAmount(finishing, pass.key)}
                    disabled={!enabled}
                    onChange={(e) =>
                      setFinishing(setPassAmount(finishing, pass.key, Number(e.target.value)))
                    }
                  />
                  <output>{Math.round(passAmount(finishing, pass.key) * 100)}%</output>
                </label>
                <button
                  type="button"
                  className={`effects-before${before ? ' is-active' : ''}`}
                  aria-pressed={before}
                  disabled={!enabled}
                  onClick={() => uiActions.toggleFinishingBefore(pass.key as FinishingPassKey)}
                  title="Show the preview without this pass (compare before / after)"
                >
                  Before
                </button>
                <button type="button" className="effects-edit" onClick={editPass}>
                  Edit
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {viewActive && (
        <p className="effects-stack-note" role="status">
          Preview only — {view.bypassAll ? 'all finishing bypassed' : 'some passes shown before'}.
          Exports still apply the full chain.{' '}
          <button type="button" className="effects-reset" onClick={uiActions.resetFinishingView}>
            Reset
          </button>
        </p>
      )}
    </section>
  );
}

export const EffectsStack = memo(EffectsStackImpl);
