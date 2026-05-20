import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { Clip, ExportSettings, ClipTransition } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { getClipDuration } from '../utils/project';
import { buildTransitionFilterComplex } from '../utils/transitions';

const DEFAULT_VIDEO_SIZE = '1280x720';

let ffmpegInstance: FFmpeg | null = null;

export type StatusCallback = (message: string) => void;

function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === 'audio') return true;
  return clip.videoFadeIn > 0 || clip.videoFadeOut > 0 || clip.audioFadeIn > 0 || clip.audioFadeOut > 0;
}

function getSafeExtension(fileName: string, defaultExtension: string): string {
  const match = /\.([^.]+)$/.exec(fileName);
  const raw = match?.[1]?.toLowerCase();
  return raw && /^[a-z0-9]+$/.test(raw) ? raw : defaultExtension;
}

function buildSingleClipFilter(clip: Clip): string {
  const duration = getClipDuration(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const safeVideoOut = Math.max(0, duration - clip.videoFadeOut);
  const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);
  const parts: string[] = [];

  if (clip.kind === 'video') {
    let v = `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;
    if (clip.videoFadeIn > 0) v += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
    if (clip.videoFadeOut > 0) v += `,fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut}`;
    parts.push(`${v}[vout]`);

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    parts.push(`${a}[aout]`);
  } else {
    // Synthesize a black video track for audio-only clips.
    parts.push(`color=c=black:s=${DEFAULT_VIDEO_SIZE}:d=${duration}[vsrc]`);
    let v = `[vsrc]`;
    if (clip.videoFadeIn > 0) v += `fade=t=in:st=0:d=${clip.videoFadeIn},`;
    if (clip.videoFadeOut > 0) v += `fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut},`;
    parts.push(`${v}format=yuv420p[vout]`);

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    parts.push(`${a}[aout]`);
  }

  return parts.join(';');
}

/**
 * Load a URL as a blob with retry logic for network resilience.
 * Retries up to 3 times with exponential backoff.
 */
async function toBlobURLWithRetry(url: string, mimeType: string): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await toBlobURL(url, mimeType);
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to load ${url} after ${maxRetries} retries: ${(error as Error).message}`);
      }
      const delayMs = Math.pow(2, attempt) * 1000; // exponential backoff: 2s, 4s, 8s
      console.warn(
        `Failed to load ${url} (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('toBlobURLWithRetry: Unexpected exit - this should never happen');
}

export async function ensureFfmpeg(onStatus: StatusCallback): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;

  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    if (message.includes('time=')) onStatus(`Rendering... ${message}`);
  });

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
  onStatus('Loading FFmpeg core (this may take a moment)...');
  
  try {
    await ffmpeg.load({
      coreURL: await toBlobURLWithRetry(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURLWithRetry(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
  } catch (error) {
    throw new Error(`FFmpeg load failed: ${(error as Error).message}`);
  }

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

// Lossless path: all clips are clean video — use the concat demuxer with -c copy.
async function mergeClipsLossless(ffmpeg: FFmpeg, clips: Clip[], onStatus: StatusCallback): Promise<void> {
  const listLines = clips.map((clip) => {
    const lines = [`file '${clip.inputName}'`];
    if (clip.trimStart > 0) lines.push(`inpoint ${clip.trimStart}`);
    if (Number.isFinite(clip.trimEnd)) lines.push(`outpoint ${clip.trimEnd}`);
    return lines.join('\n');
  });
  await ffmpeg.writeFile('concat_list.txt', listLines.join('\n'));

  onStatus('Concatenating (lossless)...');
  await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', 'stacked.mp4']);
  await ffmpeg.deleteFile('concat_list.txt');
}

// Pass 1: produce one intermediate mp4 per clip.
async function processClipPass1(
  ffmpeg: FFmpeg,
  clip: Clip,
  index: number,
  total: number,
  settings: ExportSettings,
  onStatus: StatusCallback,
): Promise<string> {
  const outName = `intermediate-${index}.mp4`;

  if (clipNeedsEffects(clip)) {
    onStatus(`Pass 1 [${index + 1}/${total}]: Encoding "${clip.title}"...`);
    await ffmpeg.exec([
      '-i', clip.inputName!,
      '-filter_complex', buildSingleClipFilter(clip),
      '-map', '[vout]',
      '-map', '[aout]',
      '-r', '30',
      '-c:v', 'libx264',
      '-crf', String(settings.crf),
      '-preset', settings.preset,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      outName,
    ]);
  } else {
    // -ss before -i triggers a fast container-level seek; -t is duration from that point.
    onStatus(`Pass 1 [${index + 1}/${total}]: Trimming "${clip.title}" (lossless)...`);
    const args: string[] = [];
    if (clip.trimStart > 0) args.push('-ss', String(clip.trimStart));
    args.push('-i', clip.inputName!);
    if (Number.isFinite(clip.trimEnd)) args.push('-t', String(clip.trimEnd - clip.trimStart));
    args.push('-c', 'copy', outName);
    await ffmpeg.exec(args);
  }

  return outName;
}

// Pass 2: concatenate all intermediate files produced by Pass 1.
async function mergeClipsPass2(
  ffmpeg: FFmpeg,
  intermediateNames: string[],
  onStatus: StatusCallback,
): Promise<void> {
  const concatList = intermediateNames.map((n) => `file '${n}'`).join('\n');
  await ffmpeg.writeFile('concat_list.txt', concatList);

  onStatus('Pass 2: Final concatenation...');
  await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', 'stacked.mp4']);

  await ffmpeg.deleteFile('concat_list.txt');
  for (const name of intermediateNames) {
    await ffmpeg.deleteFile(name);
  }
}

/** Render all clips using a single filter_complex with xfade/acrossfade transitions. */
async function mergeClipsWithTransitions(
  ffmpeg: FFmpeg,
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  filterComplex: string,
  onStatus: StatusCallback,
): Promise<void> {
  onStatus('Building transition render...');

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push('-i', clip.inputName!);
  }

  await ffmpeg.exec([
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-r', '30',
    '-c:v', 'libx264',
    '-crf', String(settings.crf),
    '-preset', settings.preset,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    'stacked.mp4',
  ]);
}

export async function mergeClips(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  onStatus: StatusCallback,
): Promise<Blob> {
  if (clips.length === 0) throw new Error('Upload clips before rendering.');

  const ffmpeg = await ensureFfmpeg(onStatus);
  onStatus('Preparing media...');

  // Clean up leftover files from a previous run.
  for (const entry of await ffmpeg.listDir('/')) {
    if (entry.isDir) continue;
    if (
      entry.name.startsWith('input-') ||
      entry.name.startsWith('intermediate-') ||
      entry.name === 'stacked.mp4' ||
      entry.name === 'concat_list.txt'
    ) {
      await ffmpeg.deleteFile(entry.name);
    }
  }

  // Assign input file names and write to WASM virtual filesystem.
  const workingClips = clips.map((clip, index) => ({
    ...clip,
    inputName: `input-${index}.${getSafeExtension(clip.file.name, clip.kind === 'video' ? 'mp4' : 'mp3')}`,
  }));

  for (const clip of workingClips) {
    await ffmpeg.writeFile(clip.inputName!, await fetchFile(clip.file));
  }

  const activeTransitions = transitions.filter((t) => t.type !== 'none' && t.duration > 0);
  const effectClips = workingClips.filter(clipNeedsEffects);
  const transitionFilterComplex =
    activeTransitions.length > 0 ? buildTransitionFilterComplex(workingClips, activeTransitions) : null;

  if (transitionFilterComplex) {
    // Single-pass filter_complex render covering all clips + transitions
    await mergeClipsWithTransitions(
      ffmpeg,
      workingClips,
      activeTransitions,
      settings,
      transitionFilterComplex,
      onStatus,
    );
  } else if (effectClips.length === 0) {
    await mergeClipsLossless(ffmpeg, workingClips, onStatus);
  } else {
    const titles = effectClips.map((c) => `"${c.title}"`).join(', ');
    onStatus(
      `Note: Re-encoding ${titles} with CRF ${settings.crf} (${settings.preset} preset). Starting export...`,
    );
    await new Promise((r) => setTimeout(r, 1500));

    const intermediates: string[] = [];
    for (const [index, clip] of workingClips.entries()) {
      intermediates.push(await processClipPass1(ffmpeg, clip, index, workingClips.length, settings, onStatus));
    }
    await mergeClipsPass2(ffmpeg, intermediates, onStatus);
  }

  for (const clip of workingClips) {
    if (clip.inputName) {
      try { await ffmpeg.deleteFile(clip.inputName); } catch { /* ignore */ }
    }
  }

  const output = (await ffmpeg.readFile('stacked.mp4')) as Uint8Array;
  // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
  // whether FFmpeg's backing buffer is a SharedArrayBuffer.
  const plain = new Uint8Array(output).buffer as ArrayBuffer;
  return new Blob([plain], { type: 'video/mp4' });
}

