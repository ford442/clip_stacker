import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FINISHING,
  DEFAULT_GRAIN,
  isFinishingActive,
  type FinishingSettings,
} from './finishing';
import {
  DEFAULT_FINISHING_PREVIEW_VIEW,
  FINISHING_STACK_PASSES,
  applyFinishingPreviewView,
  isFinishingViewActive,
  isPassContributing,
  isPassEnabled,
  passAmount,
  setPassAmount,
  setPassEnabled,
  toggleBefore,
} from './finishingStack';

const sharpened: FinishingSettings = {
  ...DEFAULT_FINISHING,
  sharpen: { ...DEFAULT_FINISHING.sharpen!, enabled: true, amount: 0.6 },
  grain: { ...DEFAULT_GRAIN, enabled: true, amount: 0.5 },
};

describe('finishingStack', () => {
  it('lists the seven passes in chain order', () => {
    expect(FINISHING_STACK_PASSES.map((p) => p.key)).toEqual([
      'noiseReduction',
      'primaryColor',
      'secondaryColor',
      'lut',
      'sharpen',
      'chromaticAberration',
      'grain',
    ]);
  });

  it('toggles a pass without touching the others, and creates a missing slot', () => {
    const off = setPassEnabled(sharpened, 'sharpen', false);
    expect(isPassEnabled(off, 'sharpen')).toBe(false);
    expect(off.grain).toBe(sharpened.grain);
    expect(sharpened.sharpen!.enabled).toBe(true);

    const fromEmpty = setPassEnabled({}, 'lut', true);
    expect(fromEmpty.lut?.enabled).toBe(true);
  });

  it('reads and writes amount (the LUT uses intensity), clamped to 0..1', () => {
    expect(passAmount(sharpened, 'sharpen')).toBe(0.6);
    expect(setPassAmount(sharpened, 'sharpen', 2).sharpen?.amount).toBe(1);
    expect(setPassAmount(sharpened, 'grain', -1).grain?.amount).toBe(0);
    const lut = setPassAmount({}, 'lut', 0.4);
    expect(lut.lut?.intensity).toBe(0.4);
    expect(passAmount(lut, 'lut')).toBe(0.4);
  });

  it('amount 0 means the pass no longer contributes', () => {
    expect(isPassContributing(sharpened, 'sharpen')).toBe(true);
    expect(isPassContributing(setPassAmount(sharpened, 'sharpen', 0), 'sharpen')).toBe(false);
  });

  it('flags an enabled pass that cannot change pixels yet', () => {
    const lutNoFile = setPassEnabled({}, 'lut', true);
    expect(isPassEnabled(lutNoFile, 'lut')).toBe(true);
    expect(isPassContributing(lutNoFile, 'lut')).toBe(false);
  });

  describe('preview view', () => {
    it('is the same object when nothing is hidden', () => {
      expect(applyFinishingPreviewView(sharpened, DEFAULT_FINISHING_PREVIEW_VIEW)).toBe(sharpened);
      // "before" on a pass that is already off changes nothing.
      expect(
        applyFinishingPreviewView(sharpened, toggleBefore(DEFAULT_FINISHING_PREVIEW_VIEW, 'lut')),
      ).toBe(sharpened);
    });

    it('bypass-all drops the whole chain but leaves the settings intact', () => {
      const out = applyFinishingPreviewView(sharpened, { bypassAll: true, before: [] });
      expect(out).toBeUndefined();
      expect(isFinishingActive(sharpened)).toBe(true);
      expect(sharpened.sharpen!.enabled).toBe(true);
    });

    it('show-before skips only the chosen pass', () => {
      const out = applyFinishingPreviewView(sharpened, toggleBefore(DEFAULT_FINISHING_PREVIEW_VIEW, 'sharpen'))!;
      expect(out.sharpen!.enabled).toBe(false);
      expect(out.grain!.enabled).toBe(true);
      expect(sharpened.sharpen!.enabled).toBe(true);
    });

    it('toggles passes in and out of the before list', () => {
      const once = toggleBefore(DEFAULT_FINISHING_PREVIEW_VIEW, 'grain');
      expect(once.before).toEqual(['grain']);
      expect(isFinishingViewActive(once)).toBe(true);
      const twice = toggleBefore(once, 'grain');
      expect(twice.before).toEqual([]);
      expect(isFinishingViewActive(twice)).toBe(false);
    });

    it('passes undefined settings through', () => {
      expect(applyFinishingPreviewView(undefined, { bypassAll: false, before: ['grain'] })).toBeUndefined();
    });
  });
});
