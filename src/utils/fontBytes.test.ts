import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidBundledFontBytes, isValidFontBytes } from './fontBytes';
import { BUNDLED_FONTS } from './textOverlay';

describe('fontBytes', () => {
  it('accepts TrueType magic bytes', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);
    expect(isValidFontBytes(bytes)).toBe(true);
    expect(() => assertValidBundledFontBytes(bytes, 'test.ttf')).not.toThrow();
  });

  it('rejects HTML masquerading as a font', () => {
    const bytes = new TextEncoder().encode('\n\n\n\n<!DOCTYPE html><html>');
    expect(isValidFontBytes(bytes)).toBe(false);
    expect(() => assertValidBundledFontBytes(bytes, 'Roboto-Regular.ttf')).toThrow(
      /HTML instead of a font file/,
    );
  });
});

describe('bundled font files on disk', () => {
  for (const font of BUNDLED_FONTS) {
    it(`${font.fileName} is a valid TTF/OTF`, () => {
      const path = join(process.cwd(), 'public/fonts', font.fileName);
      const bytes = new Uint8Array(readFileSync(path));
      assertValidBundledFontBytes(bytes, font.fileName);
    });
  }
});
