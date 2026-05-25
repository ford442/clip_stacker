import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { Clip, ExportSettings, ClipTransition, TextOverlay } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { getClipDuration } from '../utils/project';
import { buildTransitionFilterComplex } from '../utils/transitions';

const DEFAULT_VIDEO_SIZE = '1280x720';
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;

/**
 * CDN URL for Roboto Regular TTF.
 * FFmpeg WASM has no system fonts, so we fetch this at render time and write
 * it to the virtual filesystem as 'roboto.ttf'.
 */
const FONT_CDN_URL =
  'https://cdn.jsdelivr.net/gh/google/fonts@main/apache/roboto/static/Roboto-Regular.ttf';
const FONT_VIRTUAL_NAME = 'roboto.ttf';

let ffmpegInstance: FFmpeg | null = null;
let fontLoaded = false;

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
 * Retries up to 3 times with exponential backoff (2s, 4s delays between attempts).
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
      const delayMs = Math.pow(2, attempt) * 1000; // exponential backoff: 2s (attempt 1), 4s (attempt 2)
      console.warn(
        `Failed to load ${url} (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // TypeScript requires this for control flow analysis: while we know the loop either returns
  // or throws on the final attempt, TypeScript can't verify this without an explicit statement here.
  throw new Error('toBlobURLWithRetry: Unexpected - loop should always return or throw');
}

export async function ensureFfmpeg(onStatus: StatusCallback): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;

  // Reset font state whenever a new FFmpeg instance is created.
  fontLoaded = false;

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

/**
 * Fetch the Roboto Regular TTF font and write it to the FFmpeg virtual filesystem.
 * Called automatically before any render that uses text overlays.
 * Subsequent calls are no-ops once the font is loaded for the current FFmpeg instance.
 */
async function ensureFont(ffmpeg: FFmpeg, onStatus: StatusCallback): Promise<void> {
  if (fontLoaded) return;
  onStatus('Loading font for text overlays...');
  try {
    const fontData = await fetchFile(FONT_CDN_URL);
    await ffmpeg.writeFile(FONT_VIRTUAL_NAME, fontData);
    fontLoaded = true;
  } catch (err) {
    throw new Error(`Failed to load font for text overlays: ${(err as Error).message}`);
  }
}

/**
 * Build a single `drawtext=...` filter expression for one TextOverlay.
 * The overlay's text is written to a named temp file to avoid escaping issues.
 */
function buildDrawtextFilter(overlay: TextOverlay): string {
  const x = overlay.scrolling
    ? `w+tw-(t*${overlay.scrollSpeed})`
    : String(overlay.x);

  const parts: string[] = [
    `fontfile=${FONT_VIRTUAL_NAME}`,
    `textfile=tol_${overlay.id}.txt`,
    `x=${x}`,
    `y=${overlay.y}`,
    `fontsize=${overlay.fontsize}`,
    `fontcolor=${overlay.fontcolor}`,
  ];

  if (overlay.box) {
    parts.push(`box=1`, `boxcolor=${overlay.boxColor}`);
  }

  return `drawtext=${parts.join(':')}`;
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

/**
 * Build the filter_complex string for a PiP / multi-layer compositing render.
 *
 * Clips with layerIndex === 0 (the default) form the base layer and are
 * concatenated sequentially.  Clips with layerIndex >= 1 are scaled, optionally
 * made semi-transparent, and overlaid on top of the base video at their (x, y)
 * position.  Overlay clips are stacked in ascending layerIndex order.
 *
 * Audio from all clips (base and overlay) is mixed together.
 */
export function buildPipFilterComplex(clips: Clip[]): string {
  const parts: string[] = [];

  // ── Phase 1: per-clip pre-processing ────────────────────────────────────────
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = getClipDuration(clip);
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const isBase = (clip.layerIndex ?? 0) === 0;
    const safeVOut = Math.max(0, dur - clip.videoFadeOut);
    const safeAOut = Math.max(0, dur - clip.audioFadeOut);

    if (clip.kind === 'video') {
      let vf = `[${i}:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;

      if (isBase) {
        // Normalise to output canvas size
        vf += `,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`;
        vf += `,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
      } else {
        // Scale overlay to requested dimensions (0 means keep original)
        const w = clip.width ?? 0;
        const h = clip.height ?? 0;
        if (w > 0 && h > 0) {
          vf += `,scale=${w}:${h}`;
        } else if (w > 0) {
          vf += `,scale=${w}:-2`;
        } else if (h > 0) {
          vf += `,scale=-2:${h}`;
        }
        // Apply opacity when < 1
        const opacity = clip.opacity ?? 1;
        if (opacity < 1) {
          vf += `,format=rgba,colorchannelmixer=aa=${opacity.toFixed(4)}`;
        }
      }

      if (clip.videoFadeIn > 0) vf += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
      if (clip.videoFadeOut > 0) vf += `,fade=t=out:st=${safeVOut}:d=${clip.videoFadeOut}`;
      parts.push(`${vf}[v${i}]`);
    } else {
      // Audio-only: synthesise a black video track
      parts.push(`color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:d=${dur},format=yuv420p[v${i}]`);
    }

    // Audio
    let af = `[${i}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) af += `,afade=t=out:st=${safeAOut}:d=${clip.audioFadeOut}`;
    parts.push(`${af}[a${i}]`);
  }

  // ── Phase 2: concatenate base-layer clips ────────────────────────────────────
  const baseIndices = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.layerIndex ?? 0) === 0)
    .map(({ i }) => i);

  if (baseIndices.length === 0) {
    throw new Error('PiP compositing requires at least one base-layer clip (layerIndex = 0).');
  }

  let currentV: string;
  let baseAudio: string;

  if (baseIndices.length === 1) {
    currentV = `v${baseIndices[0]}`;
    baseAudio = `a${baseIndices[0]}`;
  } else {
    // concat expects interleaved [v0][a0][v1][a1]...
    const segInputs = baseIndices.map((i) => `[v${i}][a${i}]`).join('');
    parts.push(`${segInputs}concat=n=${baseIndices.length}:v=1:a=1[vbase][abase]`);
    currentV = 'vbase';
    baseAudio = 'abase';
  }

  // ── Phase 3: overlay each PiP clip in layerIndex order ──────────────────────
  const overlayEntries = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.layerIndex ?? 0) > 0)
    .sort((a, b) => (a.c.layerIndex ?? 0) - (b.c.layerIndex ?? 0));

  const audioStreams: string[] = [baseAudio];

  for (let o = 0; o < overlayEntries.length; o++) {
    const { c: clip, i: idx } = overlayEntries[o];
    const x = clip.x ?? 0;
    const y = clip.y ?? 0;
    const isLast = o === overlayEntries.length - 1;
    const outV = isLast ? 'vout' : `vcomp${o}`;

    parts.push(`[${currentV}][v${idx}]overlay=${x}:${y}:eof_action=pass[${outV}]`);
    currentV = outV;
    audioStreams.push(`a${idx}`);
  }

  // When there are no overlay clips the base video is already the final output
  if (overlayEntries.length === 0) {
    parts.push(`[${currentV}]null[vout]`);
  }

  // ── Phase 4: mix audio ───────────────────────────────────────────────────────
  if (audioStreams.length === 1) {
    parts.push(`[${audioStreams[0]}]anull[aout]`);
  } else {
    const audioInputs = audioStreams.map((s) => `[${s}]`).join('');
    parts.push(`${audioInputs}amix=inputs=${audioStreams.length}:normalize=0[aout]`);
  }

  return parts.join(';');
}

/** Render all clips using a filter_complex that composites PiP/overlay layers. */
async function mergeClipsWithCompositing(
  ffmpeg: FFmpeg,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
): Promise<void> {
  onStatus('Building PiP/compositing render...');

  const filterComplex = buildPipFilterComplex(clips);

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

export async function extractAudioToWav(clip: Clip, onStatus: StatusCallback): Promise<Blob> {
  const ffmpeg = await ensureFfmpeg(onStatus);

  const ext = getSafeExtension(clip.file.name, 'mp4');
  const inputName = `audio-extract-input.${ext}`;
  const outputName = 'audio-extract-output.wav';

  // Clean up any leftover files from a previous extraction run.
  for (const name of [inputName, outputName]) {
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }

  onStatus(`Extracting audio from "${clip.title}"...`);
  await ffmpeg.writeFile(inputName, await fetchFile(clip.file));

  const args: string[] = [];

  // Seek before input for fast container-level seek when trimStart is set.
  if (clip.trimStart > 0) args.push('-ss', String(clip.trimStart));
  args.push('-i', inputName);
  if (Number.isFinite(clip.trimEnd)) {
    args.push('-t', String(clip.trimEnd - clip.trimStart));
  }

  args.push(
    '-vn',                  // drop video stream
    '-acodec', 'pcm_s16le', // PCM 16-bit little-endian (WAV)
    '-ar', '44100',         // 44.1 kHz sample rate
    '-ac', '2',             // stereo
    outputName,
  );

  await ffmpeg.exec(args);

  const output = (await ffmpeg.readFile(outputName)) as Uint8Array;
  // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
  // whether FFmpeg's backing buffer is a SharedArrayBuffer.
  const plain = new Uint8Array(output).buffer as ArrayBuffer;

  // Clean up extraction files.
  try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
  try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }

  onStatus('Audio extraction complete.');
  return new Blob([plain], { type: 'audio/wav' });
}

export async function mergeClips(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  onStatus: StatusCallback,
  textOverlays: TextOverlay[] = [],
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
      entry.name.startsWith('tol_') ||
      entry.name === 'stacked.mp4' ||
      entry.name === 'stacked_final.mp4' ||
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
  const hasPipClips = workingClips.some((c) => (c.layerIndex ?? 0) > 0);
  const transitionFilterComplex =
    activeTransitions.length > 0 ? buildTransitionFilterComplex(workingClips, activeTransitions) : null;

  if (hasPipClips) {
    // PiP / compositing path — overlay clips on top of the base layer
    await mergeClipsWithCompositing(ffmpeg, workingClips, settings, onStatus);
  } else if (transitionFilterComplex) {
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

  // ── Text overlay post-processing ──────────────────────────────────────────
  // Apply drawtext filters on top of the composed stacked.mp4 when overlays exist.
  let finalFileName = 'stacked.mp4';

  if (textOverlays.length > 0) {
    await ensureFont(ffmpeg, onStatus);

    // Write each overlay's text to a dedicated temp file to avoid escaping issues.
    for (const overlay of textOverlays) {
      await ffmpeg.writeFile(`tol_${overlay.id}.txt`, overlay.text);
    }

    const vfFilter = textOverlays.map(buildDrawtextFilter).join(',');
    onStatus('Applying text overlays...');

    await ffmpeg.exec([
      '-i', 'stacked.mp4',
      '-vf', vfFilter,
      '-c:v', 'libx264',
      '-crf', String(settings.crf),
      '-preset', settings.preset,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      'stacked_final.mp4',
    ]);

    // Clean up temp text files.
    for (const overlay of textOverlays) {
      try { await ffmpeg.deleteFile(`tol_${overlay.id}.txt`); } catch { /* ignore */ }
    }

    try { await ffmpeg.deleteFile('stacked.mp4'); } catch { /* ignore */ }
    finalFileName = 'stacked_final.mp4';
  }

  const output = (await ffmpeg.readFile(finalFileName)) as Uint8Array;
  try { await ffmpeg.deleteFile(finalFileName); } catch { /* ignore */ }
  // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
  // whether FFmpeg's backing buffer is a SharedArrayBuffer.
  const plain = new Uint8Array(output).buffer as ArrayBuffer;
  return new Blob([plain], { type: 'video/mp4' });
}

