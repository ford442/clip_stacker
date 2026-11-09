import { describe, expect, it } from 'vitest';
import {
  clipDisplayPixelsToNormalized,
  clipLayoutToDisplayPixels,
  migratePixelClipLayout,
  migratePixelTextOverlay,
  pixelToNormX,
  pixelToNormY,
  snapPixelRect,
  textAnchorToNormalized,
} from './overlayCoords';

describe('overlayCoords', () => {
  const canvas = { width: 1280, height: 720 };

  it('round-trips clip layout between normalized storage and pixel display', () => {
    const pixels = { x: 100, y: 150, width: 320, height: 180 };
    const normalized = clipDisplayPixelsToNormalized(pixels, canvas);
    expect(normalized.x).toBeCloseTo(100 / 1280);
    expect(normalized.y).toBeCloseTo(150 / 720);
    expect(normalized.width).toBeCloseTo(320 / 1280);
    expect(normalized.height).toBeCloseTo(180 / 720);

    const display = clipLayoutToDisplayPixels(
      {
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
      },
      canvas,
    );
    expect(display).toEqual(pixels);
  });

  it('migrates legacy pixel coordinates to normalized values', () => {
    const migrated = migratePixelClipLayout(
      { x: 100, y: 200, width: 300, height: 150 },
      canvas,
    );
    expect(migrated.x).toBeCloseTo(pixelToNormX(100, canvas.width));
    expect(migrated.y).toBeCloseTo(pixelToNormY(200, canvas.height));

    const text = migratePixelTextOverlay({ x: 50, y: 650 }, canvas);
    expect(text.x).toBeCloseTo(50 / 1280);
    expect(text.y).toBeCloseTo(650 / 720);
  });

  it('snaps a rect to canvas center lines', () => {
    const rect = { x: 588, y: 320, width: 120, height: 80 };
    const { rect: snapped, guides } = snapPixelRect(rect, canvas, 12, false);
    expect(snapped.x + snapped.width / 2).toBeCloseTo(canvas.width / 2, 0);
    expect(snapped.y + snapped.height / 2).toBeCloseTo(canvas.height / 2, 0);
    expect(guides.length).toBeGreaterThan(0);
  });

  it('places text anchors in normalized space', () => {
    const bottomCenter = textAnchorToNormalized('bottom-center', 0.2, 0.08);
    expect(bottomCenter.x).toBeCloseTo(0.4, 1);
    expect(bottomCenter.y).toBeGreaterThan(0.8);
  });
});
