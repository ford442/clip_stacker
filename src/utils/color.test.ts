import { describe, it, expect } from "vitest";
import { isValidFfmpegColor, sanitizeFfmpegColor } from "./color";

describe("isValidFfmpegColor", () => {
  it("accepts named colors, case-insensitively", () => {
    expect(isValidFfmpegColor("white")).toBe(true);
    expect(isValidFfmpegColor("White")).toBe(true);
    expect(isValidFfmpegColor("SkyBlue")).toBe(true);
  });

  it("accepts #RRGGBB and #RRGGBBAA", () => {
    expect(isValidFfmpegColor("#ffcc00")).toBe(true);
    expect(isValidFfmpegColor("#ffcc00aa")).toBe(true);
    expect(isValidFfmpegColor("#FFCC00")).toBe(true);
  });

  it("accepts 0xRRGGBB and 0xRRGGBBAA", () => {
    expect(isValidFfmpegColor("0x000000")).toBe(true);
    expect(isValidFfmpegColor("0xFF0000AA")).toBe(true);
  });

  it("accepts an @alpha suffix as a float or hex byte", () => {
    expect(isValidFfmpegColor("black@0.5")).toBe(true);
    expect(isValidFfmpegColor("black@1")).toBe(true);
    expect(isValidFfmpegColor("#000000@0x80")).toBe(true);
    expect(isValidFfmpegColor("0x000000@80")).toBe(true);
  });

  it("rejects invalid colors", () => {
    expect(isValidFfmpegColor("notacolor")).toBe(false);
    expect(isValidFfmpegColor("#ff00")).toBe(false);
    expect(isValidFfmpegColor("#gggggg")).toBe(false);
    expect(isValidFfmpegColor("black@notanumber")).toBe(false);
    expect(isValidFfmpegColor("")).toBe(false);
    expect(isValidFfmpegColor("   ")).toBe(false);
  });
});

describe("sanitizeFfmpegColor", () => {
  it("returns the value unchanged when valid", () => {
    expect(sanitizeFfmpegColor("yellow", "#ffffff")).toBe("yellow");
  });

  it("falls back when invalid or non-string", () => {
    expect(sanitizeFfmpegColor("bogus", "#ffffff")).toBe("#ffffff");
    expect(sanitizeFfmpegColor(undefined, "#ffffff")).toBe("#ffffff");
    expect(sanitizeFfmpegColor(123, "#ffffff")).toBe("#ffffff");
  });
});
