import { describe, expect, it } from 'vitest';
import {
  buildBurnCaptionsArgs,
  buildSoftSubtitleArgs,
  captionsToSrtBlob,
  CAPTION_ASS_NAME,
  CAPTION_SRT_NAME,
} from './captions';
import type { CaptionEntry } from '../types';

const CAPTIONS: CaptionEntry[] = [
  { id: 'a', startSec: 1, endSec: 2, text: 'Hello' },
  { id: 'b', startSec: 3, endSec: 4, text: 'World' },
];

/** Read the value that follows `flag` in an argv array. */
function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('buildBurnCaptionsArgs', () => {
  const args = buildBurnCaptionsArgs({
    inputName: 'in.mp4',
    outputName: 'out.mp4',
    subtitleName: CAPTION_ASS_NAME,
    crf: 20,
    preset: 'fast',
  });

  it('renders the ASS document through libass', () => {
    expect(argAfter(args, '-vf')).toBe(`ass=${CAPTION_ASS_NAME}:fontsdir=.`);
  });

  it('points libass at the working directory where fonts are written', () => {
    // This core has no fontconfig, so a fonts directory is the only way it can
    // resolve the family names in the generated Style: rows.
    expect(argAfter(args, '-vf')).toContain('fontsdir=.');
  });

  it('re-encodes video with the requested x264 settings', () => {
    expect(argAfter(args, '-c:v')).toBe('libx264');
    expect(argAfter(args, '-crf')).toBe('20');
    expect(argAfter(args, '-preset')).toBe('fast');
    expect(argAfter(args, '-pix_fmt')).toBe('yuv420p');
  });

  it('copies audio rather than re-encoding it', () => {
    expect(argAfter(args, '-c:a')).toBe('copy');
  });

  it('writes a faststart MP4 to the output name', () => {
    expect(argAfter(args, '-movflags')).toBe('+faststart');
    expect(args[args.length - 1]).toBe('out.mp4');
    expect(argAfter(args, '-i')).toBe('in.mp4');
  });
});

describe('buildSoftSubtitleArgs', () => {
  const args = buildSoftSubtitleArgs({
    inputName: 'in.mp4',
    outputName: 'out.mp4',
    subtitleName: CAPTION_SRT_NAME,
  });

  it('takes the video and the subtitle file as separate inputs', () => {
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args[args.indexOf('-i') + 1]).toBe('in.mp4');
    expect(args.lastIndexOf('-i')).toBeGreaterThan(args.indexOf('-i'));
    expect(args[args.lastIndexOf('-i') + 1]).toBe(CAPTION_SRT_NAME);
  });

  it('maps both inputs so the existing streams survive', () => {
    const maps = args.reduce<string[]>(
      (acc, arg, i) => (arg === '-map' ? [...acc, args[i + 1]] : acc),
      [],
    );
    expect(maps).toEqual(['0', '1']);
  });

  it('stream-copies everything but the subtitles, which become mov_text', () => {
    expect(argAfter(args, '-c')).toBe('copy');
    expect(argAfter(args, '-c:s')).toBe('mov_text');
    expect(args).not.toContain('libx264');
  });

  it('tags the subtitle track language, defaulting to eng', () => {
    expect(argAfter(args, '-metadata:s:s:0')).toBe('language=eng');
    const french = buildSoftSubtitleArgs({
      inputName: 'in.mp4',
      outputName: 'out.mp4',
      subtitleName: CAPTION_SRT_NAME,
      language: 'fra',
    });
    expect(argAfter(french, '-metadata:s:s:0')).toBe('language=fra');
  });
});

describe('captionsToSrtBlob', () => {
  it('serializes cues as a SubRip blob', async () => {
    const blob = captionsToSrtBlob(CAPTIONS);
    expect(blob.type).toContain('application/x-subrip');
    const text = await blob.text();
    expect(text).toContain('00:00:01,000 --> 00:00:02,000');
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });
});
