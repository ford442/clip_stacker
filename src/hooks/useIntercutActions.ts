import { useCallback } from 'react';
import type { Clip } from '../types';
import { createClipId, getMediaInfo, MIN_CLIP_DURATION } from '../utils/media';
import { planAddClip } from '../utils/planAddClip';
import { editorStore } from '../store';
import { settingsStore } from '../store/settingsStore';
import type { UseEditHistoryResult } from './useEditHistory';
import type { IntercutGeneratorConfig } from '../ffmpeg/intercutGenerator';

type IntercutActionDeps = Pick<
  UseEditHistoryResult,
  'pushHistory' | 'setSelectedClipId'
>;

export function useIntercutActions({
  pushHistory,
  setSelectedClipId,
}: IntercutActionDeps) {
  const handleGenerateIntercut = useCallback(
    async (config: IntercutGeneratorConfig): Promise<boolean> => {
      const {
        isRendering,
        rifeProcessingClipId,
        intercutProcessing,
        setIntercutProcessing,
        setStatus,
        setProgressStage,
        setProgressValue,
        setProgressIndeterminate,
        setOutputUrl,
      } = settingsStore.getState();

      if (isRendering || rifeProcessingClipId || intercutProcessing) {
        setStatus('Wait for the current FFmpeg job to finish before generating an intercut.');
        return false;
      }

      setIntercutProcessing(true);
      setProgressIndeterminate(true);
      setProgressStage('Intercut');
      setProgressValue(null);
      setStatus('Generating intercut clip…');

      try {
        const { generateIntercutClip } = await import('../ffmpeg/ffmpegService');
        const result = await generateIntercutClip(config, setStatus, (update) => {
          const actions = settingsStore.getState();
          actions.setProgressStage(update.stage);
          actions.setProgressValue(
            typeof update.progress === 'number' ? update.progress : null,
          );
          actions.setProgressIndeterminate(update.indeterminate === true);
        });

        const titleA = config.clipA.title.replace(/\.[^.]+$/, '');
        const titleB = config.clipB.title.replace(/\.[^.]+$/, '');
        const titleC = config.clipC?.title.replace(/\.[^.]+$/, '');
        const file = new File(
          [result.blob],
          titleC
            ? `intercut-${titleA}-x-${titleB}-x-${titleC}.mp4`
            : `intercut-${titleA}-x-${titleB}.mp4`,
          { type: 'video/mp4' },
        );
        if (file.size < 32) {
          throw new Error(
            `Intercut output is empty (${file.size} bytes). FFmpeg may have aborted mid-encode.`,
          );
        }

        let duration = result.outputDurationSec;
        let objectUrl = URL.createObjectURL(file);
        let videoWidth =
          config.clipA.videoWidth ?? config.clipB.videoWidth ?? config.clipC?.videoWidth;
        let videoHeight =
          config.clipA.videoHeight ?? config.clipB.videoHeight ?? config.clipC?.videoHeight;
        let hasAudio: boolean | undefined =
          config.audioPolicy === 'silent' ? false : undefined;

        try {
          const info = await getMediaInfo(file);
          URL.revokeObjectURL(objectUrl);
          duration = info.duration;
          objectUrl = info.objectUrl;
          videoWidth = info.videoWidth ?? videoWidth;
          videoHeight = info.videoHeight ?? videoHeight;
          if (info.hasAudio !== undefined) hasAudio = info.hasAudio;
        } catch (probeErr) {
          // Planned duration + source dimensions keep the clip usable when the
          // browser probe is flaky; still surface a console warning.
          console.warn(
            'Intercut: browser could not probe output metadata; using planned duration.',
            probeErr,
          );
        }

        const newClip: Clip = {
          id: createClipId(),
          file,
          objectUrl,
          title: file.name,
          kind: 'video',
          duration: Math.max(MIN_CLIP_DURATION, duration || result.outputDurationSec),
          videoWidth,
          videoHeight,
          ...(hasAudio !== undefined
            ? { hasAudio }
            : { hasAudio: config.audioPolicy !== 'silent' }),
          trimStart: 0,
          trimEnd: NaN,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
        };

        pushHistory();
        const { clips, tracks, clipGroups } = editorStore.getState();
        const plan = planAddClip(clips, tracks, clipGroups, newClip);
        editorStore.setState({
          clips: plan.clips,
          ...(plan.tracks ? { tracks: plan.tracks } : {}),
          ...(plan.clipGroups ? { clipGroups: plan.clipGroups } : {}),
        });
        setSelectedClipId(newClip.id);
        setOutputUrl(null);

        const mode = result.usedStreamCopy ? 'stream copy' : 're-encode';
        const norm = result.didNormalize ? ', sources normalized' : '';
        setStatus(
          `Intercut clip added (${result.slices.length} slices, ${result.outputDurationSec.toFixed(2)}s, ${mode}${norm}).`,
        );
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        settingsStore.getState().setStatus(`Intercut failed: ${message}`);
        console.error('Intercut generation error:', err);
        return false;
      } finally {
        const actions = settingsStore.getState();
        actions.setIntercutProcessing(false);
        actions.setProgressIndeterminate(false);
        actions.setProgressValue(null);
      }
    },
    [pushHistory, setSelectedClipId],
  );

  return { handleGenerateIntercut };
}
