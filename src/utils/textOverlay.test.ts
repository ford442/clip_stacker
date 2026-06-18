import { describe, it, expect } from "vitest";
import {
  clampScrollSpeed,
  estimateScrollCrossingSeconds,
  buildScrollXExpression,
  resolveScrollingX,
  escapeDrawtext,
  buildDrawtextFilter,
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

describe("resolveScrollingX", () => {
  it("matches the FFmpeg expression w+tw-(t*w*fraction)", () => {
    // scrollSpeed 20 -> fraction 0.2; at t=0 the text starts off the right edge.
    expect(resolveScrollingX(20, 0, 1280, 40)).toBe(1320);
    expect(resolveScrollingX(20, 1, 1280, 40)).toBe(1320 - 256);
  });

  it("defaults textWidth to 0 (width-agnostic approximation)", () => {
    expect(resolveScrollingX(20, 1, 1280)).toBe(1280 - 256);
  });

  it("clamps the scroll speed before computing", () => {
    expect(resolveScrollingX(0, 1, 1000, 0)).toBe(
      1000 - 1000 * (MIN_SCROLL_SPEED / 100),
    );
  });
});

describe("escapeDrawtext", () => {
  it("escapes backslashes, quotes, colons, commas, and percent signs", () => {
    expect(escapeDrawtext(`He said 'hi': a,b\\end%`)).toBe(
      "He said \\'hi\\'\\: a\\,b\\\\end\\%",
    );
  });

  it("escapes newlines as drawtext C-style sequences", () => {
    expect(escapeDrawtext("line1\nline2")).toBe("line1\\nline2");
    expect(escapeDrawtext("line1\r\nline2")).toBe("line1\\nline2");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeDrawtext("Hello world")).toBe("Hello world");
  });
});

describe("buildDrawtextFilter", () => {
  it("embeds escaped user text in the filter graph", () => {
    const filter = buildDrawtextFilter({
      id: "overlay-1",
      text: `News: it's 50% off, now\\today`,
      fontsize: 24,
      fontcolor: "white",
      x: 10,
      y: 20,
      scrolling: false,
      scrollSpeed: 20,
      box: false,
      boxColor: "black@0.5",
    });

    expect(filter).toContain("text='News\\: it\\'s 50\\% off\\, now\\\\today'");
    expect(filter).not.toContain("textfile=");
  });

  it("throws for invalid font colors before building the filter", () => {
    expect(() =>
      buildDrawtextFilter({
        id: "overlay-1",
        text: "Hello",
        fontsize: 24,
        fontcolor: "not-a-color",
        x: 0,
        y: 0,
        scrolling: false,
        scrollSpeed: 20,
        box: false,
        boxColor: "black@0.5",
      }),
    ).toThrow(/invalid font color/i);
  });
});
