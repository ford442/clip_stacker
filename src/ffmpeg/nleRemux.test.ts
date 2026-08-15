import { describe, expect, it } from 'vitest';
import {
  GPU_STITCH_NLE_NAME,
  GPU_STITCH_RAW_NAME,
  NLE_VIDEO_TIMESCALE,
  buildPreserveAudioNleRemuxArgs,
  buildSilentAudioNleRemuxArgs,
} from './nleRemux';

describe('nle remux argv', () => {
  it('preserves video and re-encodes existing audio as stereo AAC with faststart', () => {
    const args = buildPreserveAudioNleRemuxArgs(GPU_STITCH_RAW_NAME, GPU_STITCH_NLE_NAME);
    expect(args[args.indexOf('-i') + 1]).toBe(GPU_STITCH_RAW_NAME);
    expect(args).toContain('0:v:0');
    expect(args).toContain('0:a:0');
    expect(args).not.toContain('0:a:0?');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-ar') + 1]).toBe('44100');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args).toContain('+faststart');
    expect(args[args.indexOf('-video_track_timescale') + 1]).toBe(
      String(NLE_VIDEO_TIMESCALE),
    );
    expect(args.at(-1)).toBe(GPU_STITCH_NLE_NAME);
  });

  it('muxes a looped silent AAC unit when the stitch has no audio', () => {
    const args = buildSilentAudioNleRemuxArgs(GPU_STITCH_RAW_NAME, GPU_STITCH_NLE_NAME);
    expect(args).toContain('-stream_loop');
    expect(args).toContain('silent_unit.m4a');
    expect(args).toContain('1:a:0');
    expect(args).not.toContain('-an');
    expect(args).not.toContain('anullsrc');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).toContain('+faststart');
  });
});
