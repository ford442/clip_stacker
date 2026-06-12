/**
 * Unit tests for extractAudioToWav pre-flight logic and edge-case helpers.
 *
 * The full FFmpeg WASM pipeline cannot run in a unit-test environment, so
 * these tests focus on:
 *   - validateExtractAudioClip (pure, no FFmpeg dependency)
 *   - NO_AUDIO_STREAM_RE pattern matching
 *   - WAV_HEADER_MIN_BYTES constant correctness
 */
import { describe, it, expect } from "vitest";
import type { Clip } from "../types";
import {
  validateExtractAudioClip,
  NO_AUDIO_STREAM_RE,
  WAV_HEADER_MIN_BYTES,
} from "./ffmpegService";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "test-clip",
    file: new File([], "test.mp4"),
    objectUrl: "blob:test",
    title: "Test Clip",
    kind: "video",
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateExtractAudioClip
// ---------------------------------------------------------------------------

describe("validateExtractAudioClip", () => {
  it("returns null for a valid video clip (full duration)", () => {
    expect(validateExtractAudioClip(makeClip())).toBeNull();
  });

  it("returns null for a valid video clip with trim points", () => {
    expect(
      validateExtractAudioClip(makeClip({ trimStart: 2, trimEnd: 8 })),
    ).toBeNull();
  });

  it("returns null for an audio-only clip", () => {
    expect(
      validateExtractAudioClip(
        makeClip({ kind: "audio", file: new File([], "test.mp3") }),
      ),
    ).toBeNull();
  });

  it("returns null when trimEnd equals duration (no NaN)", () => {
    expect(validateExtractAudioClip(makeClip({ trimEnd: 10 }))).toBeNull();
  });

  it("returns an error string when trimStart equals trimEnd (zero duration)", () => {
    const msg = validateExtractAudioClip(
      makeClip({ trimStart: 5, trimEnd: 5 }),
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("zero or negative duration");
    expect(msg).toContain("Test Clip");
  });

  it("returns an error string when trimStart exceeds trimEnd", () => {
    const msg = validateExtractAudioClip(
      makeClip({ trimStart: 8, trimEnd: 4 }),
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("zero or negative duration");
  });

  it("returns an error string when clip duration is 0 and trimEnd is NaN", () => {
    const msg = validateExtractAudioClip(
      makeClip({ duration: 0, trimStart: 0 }),
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("zero or negative duration");
  });

  it("includes trimStart, trimEnd and duration values in the error message", () => {
    const msg = validateExtractAudioClip(
      makeClip({ trimStart: 5, trimEnd: 3, duration: 10 }),
    )!;
    expect(msg).toContain("trimStart=5");
    expect(msg).toContain("trimEnd=3");
    expect(msg).toContain("duration=10");
  });

  it('shows "end" for trimEnd when trimEnd is NaN', () => {
    const msg = validateExtractAudioClip(
      makeClip({ duration: 0, trimStart: 0, trimEnd: NaN }),
    )!;
    expect(msg).toContain("trimEnd=end");
  });
});

// ---------------------------------------------------------------------------
// NO_AUDIO_STREAM_RE — pattern matching
// ---------------------------------------------------------------------------

describe("NO_AUDIO_STREAM_RE", () => {
  it.each([
    "matches no streams",
    "Stream specifier 0:a:0 matches no streams",
    "does not contain any audio stream",
    "Output file does not contain any stream",
    "no audio stream",
    "Invalid audio stream",
    "MATCHES NO STREAMS", // case-insensitive
  ])("matches: %s", (msg) => {
    expect(NO_AUDIO_STREAM_RE.test(msg)).toBe(true);
  });

  it.each([
    "Encoding complete",
    "size=    2048kB time=00:00:10",
    "Stream mapping: 0:a:0 -> 0:0",
    "Output #0, wav",
  ])("does not match: %s", (msg) => {
    expect(NO_AUDIO_STREAM_RE.test(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WAV_HEADER_MIN_BYTES constant
// ---------------------------------------------------------------------------

describe("WAV_HEADER_MIN_BYTES", () => {
  it("is greater than the standard 44-byte RIFF/WAV header size", () => {
    // Standard PCM WAV header is exactly 44 bytes; any audio data pushes it above.
    expect(WAV_HEADER_MIN_BYTES).toBeGreaterThan(44);
  });

  it("is 45 (44-byte header + 1 byte of audio data minimum)", () => {
    expect(WAV_HEADER_MIN_BYTES).toBe(45);
  });
});
