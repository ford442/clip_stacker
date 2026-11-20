import { describe, expect, it } from 'vitest';
import { framePeakLevel, planExpectsPicture } from './timelineFrameSession';
import type { PreviewCompositionPlan } from '../composition/previewCompositionTypes';

/** One plane of `width` × `height` samples of `bytesPerSample`, row stride padded by 8 bytes. */
function plane(width: number, height: number, bytesPerSample: number) {
  const stride = width * bytesPerSample + 8;
  return { data: new Uint8Array(stride * height), layout: { offset: 0, stride } };
}

describe('framePeakLevel', () => {
  it('reads the max R/G/B of an RGB frame, ignoring alpha and row padding', () => {
    const { data, layout } = plane(4, 2, 4);
    data[3] = 255; // alpha only
    data[layout.stride - 1] = 255; // padding past the row
    expect(framePeakLevel('RGBA', data, layout, 4, 2)).toBe(0);
    data[layout.stride + 4 + 1] = 200; // G of (1, 1)
    expect(framePeakLevel('BGRX', data, layout, 4, 2)).toBe(200);
  });

  it('maps an 8-bit Y plane from limited range', () => {
    const { data, layout } = plane(4, 2, 1);
    data.fill(16, 0, 4);
    data.fill(16, layout.stride, layout.stride + 4);
    expect(framePeakLevel('I420', data, layout, 4, 2)).toBe(0);
    data[layout.stride + 2] = 235;
    expect(framePeakLevel('NV12', data, layout, 4, 2)).toBe(255);
  });

  it('maps a 10-bit Y plane from limited range (little-endian samples)', () => {
    const { data, layout } = plane(4, 2, 2);
    const view = new DataView(data.buffer);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) view.setUint16(y * layout.stride + x * 2, 64, true);
    expect(framePeakLevel('I420P10', data, layout, 4, 2)).toBe(0);
    view.setUint16(layout.stride + 6, 940, true);
    expect(framePeakLevel('I420P10', data, layout, 4, 2)).toBe(255);
  });

  it('does not judge a format it cannot read', () => {
    const { data, layout } = plane(2, 2, 4);
    expect(framePeakLevel('RGBAF16', data, layout, 2, 2)).toBeNull();
    expect(framePeakLevel(null, data, layout, 2, 2)).toBeNull();
  });
});

describe('planExpectsPicture', () => {
  const plan = (layers: unknown[]) => ({ layers }) as unknown as PreviewCompositionPlan;

  it('expects a picture only from a clip layer at least half visible', () => {
    expect(planExpectsPicture(plan([]))).toBe(false);
    expect(planExpectsPicture(plan([{ kind: 'text', opacity: 1 }]))).toBe(false);
    expect(planExpectsPicture(plan([{ kind: 'base', opacity: 0.2 }]))).toBe(false);
    expect(planExpectsPicture(plan([{ kind: 'pip', opacity: 0.8 }]))).toBe(true);
  });
});
