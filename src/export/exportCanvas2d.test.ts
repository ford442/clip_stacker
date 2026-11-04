import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { exportCanvas2dSettings } from '../finishing/colorManagement';
import { DecoderTextOverlayPass } from './webcodecsCompositor';

describe('export 2D canvas colour space (Display P3 text)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is P3 for a P3 export and sRGB otherwise, never with alpha', () => {
    expect(exportCanvas2dSettings('display-p3')).toEqual({ colorSpace: 'display-p3', alpha: false });
    expect(exportCanvas2dSettings('rec709-sdr')).toEqual({ colorSpace: 'srgb', alpha: false });
    expect(exportCanvas2dSettings('hdr10')).toEqual({ colorSpace: 'srgb', alpha: false });
  });

  it('the decoder text pass asks for the export colour space', () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => ({}) as never);
    new DecoderTextOverlayPass([], [], [], [], DEFAULT_EXPORT_SETTINGS, 16, 9, {}, 'display-p3');
    expect(getContext).toHaveBeenLastCalledWith('2d', { colorSpace: 'display-p3', alpha: false });
    new DecoderTextOverlayPass([], [], [], [], DEFAULT_EXPORT_SETTINGS, 16, 9);
    expect(getContext).toHaveBeenLastCalledWith('2d', { colorSpace: 'srgb', alpha: false });
  });
});
