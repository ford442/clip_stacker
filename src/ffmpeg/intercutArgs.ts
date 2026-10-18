/**
 * Pure FFmpeg argv builders for the intercut generator (what the tests cover);
 * `intercutGenerator.ts` runs them. See AGENTS.md "Intercut generator" for why
 * the render is one frame-grid filter graph plus pre-spliced PCM.
 */

import type { Clip } from '../types';
import { isStillImageClip } from './core';
import {
  INTERCUT_AUDIO_CHANNELS,
  INTERCUT_AUDIO_SAMPLE_RATE,
  INTERCUT_OUTPUT_FPS,
} from '../utils/intercutRender';

function secondsArg(sec: number): string {
  return String(Number(sec.toFixed(6)));
}

/**
 * Input args for one intercut source. Video seeks to its trim start so the
 * source's frame 0 (after `fps`) is the trim origin the frame plan counts from;
 * stills loop at the output rate.
 */
export function buildIntercutSourceInputArgs(
  clip: Clip,
  inputName: string,
  trimStart: number,
  durationSec: number,
): string[] {
  const duration = ['-t', secondsArg(Math.max(1 / INTERCUT_OUTPUT_FPS, durationSec))];
  if (isStillImageClip(clip)) {
    return ['-loop', '1', '-framerate', String(INTERCUT_OUTPUT_FPS), ...duration, '-i', inputName];
  }
  const seek = trimStart > 0 ? ['-ss', secondsArg(trimStart)] : [];
  return [...seek, ...duration, '-i', inputName];
}

/**
 * Decode one source's audio (from its trim start) to 16-bit stereo PCM.
 * `aresample=async=1:first_pts=0` pads a late-starting or gappy stream so
 * sample N is always source time trimStart + N / 44100.
 */
export function buildIntercutAudioExtractArgs(
  inputName: string,
  outputName: string,
  trimStart: number,
  durationSec: number,
): string[] {
  const seek = trimStart > 0 ? ['-ss', secondsArg(trimStart)] : [];
  return [
    ...seek,
    '-t',
    secondsArg(durationSec),
    '-i',
    inputName,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    `aresample=${INTERCUT_AUDIO_SAMPLE_RATE}:async=1:first_pts=0`,
    '-ac',
    String(INTERCUT_AUDIO_CHANNELS),
    '-ar',
    String(INTERCUT_AUDIO_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    outputName,
  ];
}

export interface IntercutAudioTrackInput {
  name: string;
  /** Stream title written into the MP4 (`metadata:s:a:N title=`). */
  title: string;
}

export interface IntercutRenderArgsOptions {
  /** Per-source input args, in input-index order (see `buildIntercutSourceInputArgs`). */
  sourceInputs: string[][];
  /** Pre-spliced PCM soundtrack (last input) when `audioTracks` is omitted. */
  audioName?: string;
  /**
   * Continuous beds muxed as separate AAC streams. The first track is the
   * default (what the library player plays). Used by `steadyStreams`.
   */
  audioTracks?: IntercutAudioTrackInput[];
  filterGraph: string;
  totalFrames: number;
  outputName: string;
}

/**
 * Single encode: the frame-grid video graph plus one or more WAVs that are
 * exactly `totalFrames` long, so nothing is left for the muxer to guess.
 */
export function buildIntercutRenderArgs(options: IntercutRenderArgsOptions): string[] {
  const tracks = options.audioTracks?.length
    ? options.audioTracks
    : [{ name: options.audioName ?? 'intercut-audio.wav', title: 'Audio' }];
  const firstAudioIndex = options.sourceInputs.length;
  const audioArgs: string[] = [];
  tracks.forEach((track, i) => {
    audioArgs.push('-map', `${firstAudioIndex + i}:a:0`);
    audioArgs.push(`-metadata:s:a:${i}`, `title=${track.title}`);
    audioArgs.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');
  });
  return [
    ...options.sourceInputs.flat(),
    ...tracks.flatMap((track) => ['-i', track.name]),
    '-filter_complex',
    options.filterGraph,
    '-map',
    '[vout]',
    ...audioArgs,
    '-frames:v',
    String(options.totalFrames),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(INTERCUT_OUTPUT_FPS),
    '-vsync',
    'cfr',
    '-bf',
    '0',
    '-c:a',
    'aac',
    '-ar',
    String(INTERCUT_AUDIO_SAMPLE_RATE),
    '-ac',
    String(INTERCUT_AUDIO_CHANNELS),
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    options.outputName,
  ];
}
