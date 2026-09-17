/**
 * Drives auto-captioning: pick a provider, mix the audio in scope, transcribe,
 * and put the cues on the CC lane.
 *
 * The write goes through `pushHistory()` + `setCaptions`, so a transcription is
 * one undo step like any other caption edit, and a cancelled run never touches
 * the track — the cues are only applied once the provider resolves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { CaptionEntry } from '../types';
import { editorStore } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { uiActions } from '../store/uiStore';
import {
  getCaptionProvider,
  listAvailableCaptionProviders,
  type CaptionProvider,
} from '../utils/captionProvider';
import { mergeCaptions } from '../utils/captionSegments';
import { renderAutoCaptionAudio } from '../utils/autoCaptionAudio';
import { getWhisperUnavailableReason } from '../wasm/whisperCaptionProvider';

export interface AutoCaptionProviderOption {
  id: string;
  label: string;
}

export interface UseAutoCaptionResult {
  /** Providers whose `isAvailable()` resolved true, for the picker. */
  providers: AutoCaptionProviderOption[];
  /** Still probing `isAvailable()`. */
  probing: boolean;
  /** One-line reason no provider can run, for the disabled button's hint. */
  unavailableReason: string | null;
  running: boolean;
  progress: number | null;
  stage: string;
  /** Re-probe availability (e.g. after the endpoint setting changes). */
  refresh: () => void;
  run: () => Promise<void>;
  cancel: () => void;
}

const NO_PROVIDER_REASON =
  'No transcription backend available — deploy the Whisper WASM build or set a transcription endpoint below.';

export function useAutoCaption(): UseAutoCaptionResult {
  const [providers, setProviders] = useState<AutoCaptionProviderOption[]>([]);
  const [probing, setProbing] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState('');
  const [probeToken, setProbeToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const endpoint = useStore(settingsStore, (s) => s.autoCaptionEndpoint);

  useEffect(() => {
    let cancelledProbe = false;
    setProbing(true);
    void listAvailableCaptionProviders().then((available) => {
      if (cancelledProbe) return;
      setProviders(available.map(({ id, label }) => ({ id, label })));
      setUnavailableReason(
        available.length > 0
          ? null
          : (getWhisperUnavailableReason() ?? NO_PROVIDER_REASON),
      );
      setProbing(false);
    });
    return () => {
      cancelledProbe = true;
    };
  }, [probeToken, endpoint]);

  const refresh = useCallback(() => setProbeToken((n) => n + 1), []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    if (abortRef.current) return;
    const settings = settingsStore.getState();
    const { setStatus } = settings;

    const provider: CaptionProvider | undefined = settings.autoCaptionProviderId
      ? getCaptionProvider(settings.autoCaptionProviderId)
      : ((await listAvailableCaptionProviders())[0] ?? undefined);
    if (!provider) {
      setStatus(unavailableReason ?? NO_PROVIDER_REASON);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setProgress(null);
    setStage('Mixing audio…');

    try {
      const editor = editorStore.getState();
      const { audio, timeOffsetSec, durationSec } = await renderAutoCaptionAudio({
        clips: editor.clips,
        groups: editor.clipGroups,
        transitions: editor.transitions,
        tracks: editor.tracks,
        scope: settings.autoCaptionScope,
        clipId: editor.selectedClipId,
      });
      if (controller.signal.aborted) return;

      setStatus(
        `Transcribing ${durationSec.toFixed(1)}s of audio with ${provider.label}…`,
      );
      const cues = await provider.transcribe(audio, {
        language: settings.autoCaptionLanguage || undefined,
        timeOffsetSec,
        signal: controller.signal,
        onProgress: (event) => {
          setProgress(event.progress);
          setStage(event.stage);
        },
      });
      if (controller.signal.aborted) return;

      applyCues(cues, settings.autoCaptionMerge);
      setStatus(
        cues.length === 0
          ? 'Transcription finished but found no speech in the audio.'
          : `Added ${cues.length} caption${cues.length === 1 ? '' : 's'} from ${provider.label}.`,
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        setStatus('Auto-caption cancelled — the caption track is unchanged.');
      } else {
        setStatus(`Auto-caption failed: ${(err as Error)?.message || String(err)}`);
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
      setStage('');
    }
  }, [unavailableReason]);

  return {
    providers,
    probing,
    unavailableReason,
    running,
    progress,
    stage,
    refresh,
    run,
    cancel,
  };
}

/** Replace or merge the caption track in a single undo step. */
function applyCues(cues: CaptionEntry[], merge: boolean): void {
  if (cues.length === 0) return;
  const { pushHistory, setCaptions, captions } = editorStore.getState();
  pushHistory();
  setCaptions(merge ? mergeCaptions(captions, cues) : cues);
  uiActions.setSelectedCaptionId(null);
}
