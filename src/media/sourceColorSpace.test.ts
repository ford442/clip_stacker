import { describe, expect, it } from 'vitest';
import {
  SOURCE_COLOR_SPACE_OVERRIDES,
  colorSpaceForOverride,
  describeVideoColorSpace,
  isSourceColorSpaceOverride,
  sourceColorSpaceLine,
} from './sourceColorSpace';
import { HDR10_COLOR_SPACE } from '../finishing/colorManagement';

describe('source colour space', () => {
  it('names common file tags', () => {
    expect(describeVideoColorSpace(HDR10_COLOR_SPACE as VideoColorSpaceInit)).toBe('Rec.2020 PQ');
    expect(
      describeVideoColorSpace({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' }),
    ).toBe('Rec.709');
    expect(
      describeVideoColorSpace({ primaries: 'smpte432', transfer: 'iec61966-2-1' } as unknown as VideoColorSpaceInit),
    ).toBe('Display P3');
    expect(describeVideoColorSpace({ primaries: 'bt2020', transfer: 'hlg' } as unknown as VideoColorSpaceInit)).toBe(
      'Rec.2020 HLG',
    );
    expect(describeVideoColorSpace({ primaries: 'smpte170m', transfer: 'smpte170m' })).toBe('Rec.601');
    expect(describeVideoColorSpace(null)).toBe('untagged (shown as Rec.709)');
    expect(describeVideoColorSpace({ fullRange: true })).toBe('untagged (shown as Rec.709)');
  });

  it('writes the Inspector line for file tags and overrides', () => {
    expect(sourceColorSpaceLine(HDR10_COLOR_SPACE as VideoColorSpaceInit, undefined)).toBe(
      'Source: Rec.2020 PQ (from file)',
    );
    expect(sourceColorSpaceLine(null, 'rec2020-hlg')).toBe(
      'Source: Rec.2020 HLG (override; file: untagged (shown as Rec.709))',
    );
  });

  it('gives complete decoder tags for every override (Chromium drops partial ones)', () => {
    for (const def of SOURCE_COLOR_SPACE_OVERRIDES) {
      const cs = colorSpaceForOverride(def.id);
      expect(cs.primaries).toBeTruthy();
      expect(cs.transfer).toBeTruthy();
      expect(cs.matrix).toBeTruthy();
      expect(typeof cs.fullRange).toBe('boolean');
      expect(describeVideoColorSpace(cs)).toBe(def.label);
    }
  });

  it('accepts only known override ids', () => {
    expect(isSourceColorSpaceOverride('display-p3')).toBe(true);
    expect(isSourceColorSpaceOverride('aces')).toBe(false);
    expect(isSourceColorSpaceOverride(undefined)).toBe(false);
  });
});
