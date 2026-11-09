import { describe, expect, it } from 'vitest';
import { testHarnessRequested } from './harnessBindings';
import { installTestHarness, testHarness } from './testHarness/harness';

describe('test harness gating', () => {
  it('is requested only by the ?test_harness parameter', () => {
    expect(testHarnessRequested('?test_harness')).toBe(true);
    expect(testHarnessRequested('?foo=1&test_harness=1')).toBe(true);
    expect(testHarnessRequested('')).toBe(false);
    expect(testHarnessRequested('?test_harnessx')).toBe(false);
    expect(testHarnessRequested('?legacy_preview_video')).toBe(false);
  });

  it('installs window.clipStacker.test without replacing other APIs', () => {
    const target = { clipStacker: { finishing: { apply: () => undefined } } } as unknown as Window;
    installTestHarness(target);
    expect(target.clipStacker?.test).toBe(testHarness);
    expect(target.clipStacker?.finishing).toBeDefined();
  });

  it('refuses to export before App binds its render action', async () => {
    await expect(testHarness.exportProject()).rejects.toThrow(/not bound/);
  });
});
