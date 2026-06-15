import { describe, it, expect } from "vitest";
import {
  clampScrollSpeed,
  estimateScrollCrossingSeconds,
  buildScrollXExpression,
  DEFAULT_SCROLL_SPEED,
  MIN_SCROLL_SPEED,
  MAX_SCROLL_SPEED,
} from "./textOverlay";

describe("clampScrollSpeed", () => {
  it("passes through values within range", () => {
    expect(clampScrollSpeed(20)).toBe(20);
    expect(clampScrollSpeed(100)).toBe(100);
  });

  it("clamps values below the minimum", () => {
    expect(clampScrollSpeed(0)).toBe(MIN_SCROLL_SPEED);
    expect(clampScrollSpeed(-5)).toBe(MIN_SCROLL_SPEED);
  });

  it("clamps values above the maximum", () => {
    expect(clampScrollSpeed(500)).toBe(MAX_SCROLL_SPEED);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampScrollSpeed(NaN)).toBe(DEFAULT_SCROLL_SPEED);
    expect(clampScrollSpeed(Infinity)).toBe(DEFAULT_SCROLL_SPEED);
  });
});

describe("estimateScrollCrossingSeconds", () => {
  it("computes crossing time as 100 / scrollSpeed", () => {
    expect(estimateScrollCrossingSeconds(20)).toBeCloseTo(5);
    expect(estimateScrollCrossingSeconds(100)).toBeCloseTo(1);
  });

  it("clamps before computing", () => {
    expect(estimateScrollCrossingSeconds(0)).toBeCloseTo(
      100 / MIN_SCROLL_SPEED,
    );
  });
});

describe("buildScrollXExpression", () => {
  it("produces an expression using the dynamic frame width w", () => {
    expect(buildScrollXExpression(20)).toBe("w+tw-(t*w*0.2000)");
  });

  it("produces a resolution-independent fraction for other speeds", () => {
    expect(buildScrollXExpression(50)).toBe("w+tw-(t*w*0.5000)");
    expect(buildScrollXExpression(100)).toBe("w+tw-(t*w*1.0000)");
  });
});
