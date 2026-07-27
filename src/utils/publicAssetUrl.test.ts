import { describe, expect, it } from 'vitest';
import { getFontPublicUrl } from './textOverlay';

describe('resolvePublicAssetUrl via getFontPublicUrl', () => {
  it('returns a URL containing the font filename', () => {
    const url = getFontPublicUrl({
      id: 'roboto',
      label: 'Roboto Regular',
      familyName: 'Roboto',
      fileName: 'Roboto-Regular.ttf',
      virtualName: 'roboto.ttf',
    });
    expect(url).toContain('Roboto-Regular.ttf');
    expect(url).toMatch(/fonts\/Roboto-Regular\.ttf$/);
  });
});
