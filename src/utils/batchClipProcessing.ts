import type { Clip, ExportSettings, VideoOutputFormat } from '../types';
import type { RifeBatchProgressEvent, RifeResult } from './huggingface';

export type BatchProcessingBackend = 'browser-ffmpeg' | 'hf-rife';

export interface BatchProcessingOptions {
  backend: BatchProcessingBackend;
  multiplier: 2 | 4;
  outputFormat: VideoOutputFormat;
  lightVideoCleanup: boolean;
  audioCleanup: boolean;
}

export interface BatchClipProcessingDeps {
  exportSettings: ExportSettings;
  extractTrimmedVideoClip: (clip: Clip, onStatus: (message: string) => void) => Promise<Blob>;
  processClipsWithRIFE?: (
    blobs: Blob[],
    multiplier: 2 | 4,
    mode: 'interpolation',
    onProgress: (event: RifeBatchProgressEvent) => void,
    outputFormat: VideoOutputFormat,
  ) => Promise<RifeResult[]>;
  muxProcessedVideoWithSourceAudio: (
    blob: Blob,
    clip: Clip,
    onStatus: (message: string) => void,
    outputFormat: VideoOutputFormat,
  ) => Promise<Blob>;
  finalizeRenderedVideo: (
    blob: Blob,
    settings: ExportSettings,
    onStatus: (message: string) => void,
  ) => Promise<Blob>;
  getMediaInfo: (file: File) => Promise<{ duration: number }>;
  onStatus: (message: string) => void;
}

export interface ProcessedBatchClip {
  clipId: string;
  sourceFile: File;
  file: File;
  duration: number;
  rifeProcessed: boolean;
}

export async function processClipBatch(
  clips: Clip[],
  options: BatchProcessingOptions,
  deps: BatchClipProcessingDeps,
): Promise<ProcessedBatchClip[]> {
  if (clips.length === 0) throw new Error('Select at least one video clip.');
  if (clips.some((clip) => clip.kind !== 'video')) {
    throw new Error('Batch processing supports video clips only.');
  }
  if (
    options.backend === 'browser-ffmpeg' &&
    !options.lightVideoCleanup &&
    !options.audioCleanup &&
    options.outputFormat !== 'prores'
  ) {
    throw new Error('Select cleanup or ProRes output for Browser FFmpeg processing.');
  }

  const settings: ExportSettings = {
    ...deps.exportSettings,
    outputFormat: options.outputFormat,
    lightVideoCleanup: options.lightVideoCleanup,
    audioCleanup: options.audioCleanup,
  };
  const extension = options.outputFormat === 'prores' ? 'mov' : 'mp4';
  const mimeType = options.outputFormat === 'prores' ? 'video/quicktime' : 'video/mp4';
  let processedBlobs: Blob[];

  if (options.backend === 'hf-rife') {
    const trimmed: Blob[] = [];
    for (const [index, clip] of clips.entries()) {
      deps.onStatus(`Preparing clip ${index + 1}/${clips.length} for RIFE…`);
      trimmed.push(await deps.extractTrimmedVideoClip(clip, deps.onStatus));
    }

    if (!deps.processClipsWithRIFE) throw new Error('RIFE batch processing is unavailable.');
    const rifeResults = await deps.processClipsWithRIFE(
      trimmed,
      options.multiplier,
      'interpolation',
      (event) => {
        deps.onStatus(
          `RIFE ${event.clipIndex + 1}/${event.clipCount}: ${event.message ?? event.stage}`,
        );
      },
      options.outputFormat,
    );
    if (rifeResults.length !== clips.length) {
      throw new Error('RIFE returned a different number of results than selected clips.');
    }

    processedBlobs = [];
    for (const [index, clip] of clips.entries()) {
      deps.onStatus(`Restoring audio for clip ${index + 1}/${clips.length}…`);
      const withAudio = await deps.muxProcessedVideoWithSourceAudio(
        rifeResults[index].blob,
        clip,
        deps.onStatus,
        options.outputFormat,
      );
      processedBlobs.push(
        options.lightVideoCleanup || options.audioCleanup
          ? await deps.finalizeRenderedVideo(withAudio, settings, deps.onStatus)
          : withAudio,
      );
    }
  } else {
    processedBlobs = [];
    for (const [index, clip] of clips.entries()) {
      deps.onStatus(`Processing clip ${index + 1}/${clips.length} with FFmpeg…`);
      processedBlobs.push(
        await deps.finalizeRenderedVideo(clip.file, settings, deps.onStatus),
      );
    }
  }

  const results: ProcessedBatchClip[] = [];
  for (const [index, clip] of clips.entries()) {
    const baseName = clip.file.name.replace(/\.[^.]+$/, '') || 'clip';
    const prefix = options.backend === 'hf-rife' ? `rife_${options.multiplier}x_` : 'processed_';
    const file = new File([processedBlobs[index]], `${prefix}${baseName}.${extension}`, {
      type: mimeType,
    });
    const { duration } = await deps.getMediaInfo(file);
    results.push({
      clipId: clip.id,
      sourceFile: clip.file,
      file,
      duration,
      rifeProcessed: options.backend === 'hf-rife',
    });
  }
  return results;
}
