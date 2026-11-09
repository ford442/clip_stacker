import { useCallback } from 'react';
import type { Clip } from '../types';
import { editorStore } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import type { BatchProcessingOptions } from '../remote/batchClipProcessing';
import type { UseEditHistoryResult } from './useEditHistory';
import { renderJobStore } from '../store/renderJobStore';

type BatchClipProcessingDeps = Pick<
  UseEditHistoryResult,
  'setClips' | 'pushHistory'
> & {
  clips: Clip[];
};

const BATCH_PROCESSING_ID = '__clip_batch_processing__';

export function useBatchClipProcessing({
  clips,
  setClips,
  pushHistory,
}: BatchClipProcessingDeps) {
  const handleBatchProcess = useCallback(
    async (clipIds: string[], options: BatchProcessingOptions): Promise<boolean> => {
      const selectedIds = new Set(clipIds);
      const selectedClips = clips.filter(
        (clip) => selectedIds.has(clip.id) && clip.kind === 'video',
      );
      if (selectedClips.length === 0) {
        renderJobStore.getState().setStatus('Select at least one video clip to process.');
        return false;
      }

      const state = renderJobStore.getState();
      if (state.rifeProcessingClipId || state.isRendering || state.intercutProcessing) return false;
      if (
        options.backend === 'browser-ffmpeg' &&
        !options.lightVideoCleanup &&
        !options.audioCleanup &&
        options.outputFormat !== 'prores'
      ) {
        state.setStatus('Choose cleanup or ProRes output for Browser FFmpeg processing.');
        return false;
      }

      state.setRifeProcessingClipId(BATCH_PROCESSING_ID);
      state.setStatus(
        options.backend === 'hf-rife'
          ? `Preparing ${selectedClips.length} clips for RIFE…`
          : `Preparing ${selectedClips.length} clips for FFmpeg…`,
      );

      const objectUrls: string[] = [];
      let committed = false;
      try {
        const [ffmpeg, batchProcessing, media] = await Promise.all([
          import('../ffmpeg/ffmpegService'),
          import('../remote/batchClipProcessing'),
          import('../media/media'),
        ]);
        const rife = options.backend === 'hf-rife'
          ? await import('../remote/huggingface')
          : null;
        const results = await batchProcessing.processClipBatch(
          selectedClips,
          options,
          {
            exportSettings: settingsStore.getState().exportSettings,
            extractTrimmedVideoClip: ffmpeg.extractTrimmedVideoClip,
            ...(rife ? { processClipsWithRIFE: rife.processClipsWithRIFE } : {}),
            muxProcessedVideoWithSourceAudio: ffmpeg.muxProcessedVideoWithSourceAudio,
            finalizeRenderedVideo: ffmpeg.finalizeRenderedVideo,
            getMediaInfo: media.getMediaInfo,
            onStatus: (message) => renderJobStore.getState().setStatus(message),
          },
        );

        const liveClips = new Map(editorStore.getState().clips.map((clip) => [clip.id, clip]));
        if (results.some((result) => liveClips.get(result.clipId)?.file !== result.sourceFile)) {
          throw new Error('A selected clip changed during processing. No results were imported.');
        }

        const outputs = new Map(
          results.map((result) => {
            const objectUrl = URL.createObjectURL(result.file);
            objectUrls.push(objectUrl);
            return [result.clipId, { ...result, objectUrl }] as const;
          }),
        );
        pushHistory();
        setClips((previous) =>
          previous.map((clip) => {
            const result = outputs.get(clip.id);
            if (!result) return clip;
            const next: Clip = {
              ...clip,
              file: result.file,
              objectUrl: result.objectUrl,
              duration: result.duration,
              proxy: undefined,
            };
            if (result.rifeProcessed) {
              next.trimStart = 0;
              next.trimEnd = Number.NaN;
              next.rifeProcessed = true;
              next.rifeMultiplier = options.multiplier;
              next.rifeMode = 'interpolation';
            }
            return next;
          }),
        );
        committed = true;
        renderJobStore.getState().setStatus(
          `Processed ${results.length} clips. Results are in the library and ready to download.`,
        );
        return true;
      } catch (error) {
        if (!committed) objectUrls.forEach((url) => URL.revokeObjectURL(url));
        const message = error instanceof Error ? error.message : String(error);
        renderJobStore.getState().setStatus(`Batch processing failed: ${message}`);
        console.error('Batch clip processing error:', error);
        return false;
      } finally {
        if (renderJobStore.getState().rifeProcessingClipId === BATCH_PROCESSING_ID) {
          renderJobStore.getState().setRifeProcessingClipId(null);
        }
      }
    },
    [clips, pushHistory, setClips],
  );

  return { handleBatchProcess };
}
