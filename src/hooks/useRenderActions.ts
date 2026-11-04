import { selectTimelineClips } from '../store/selectors';
import { useCallback, useMemo, useRef, useState } from "react";
import type { Clip, ClipGroup, ClipTransition, TextOverlay, Track } from "../types";
import { editorStore } from "../store/editorStore";
import { resolveTargetResolution } from "../export/resolution";
import { formatEncoderPathLabel } from "../export/encoderPathLabel";
import { computeTotalDuration } from "../timeline/transitions";
import { normalizeError } from "../ffmpeg/ffmpegCommon";
import type { RenderProgressUpdate } from "../ffmpeg/ffmpegService";
import {
  isHighMemoryUsage,
} from "../utils/memory";

import { settingsStore } from "../store/settingsStore";
import {
  copyDebugInfo,
  loadDebugReport,
  loadFfmpegService,
  resetFfmpegForDebug,
  retryFfmpegLoad,
  runRemoteConcat,
  type FfmpegServiceModule,
} from "../actions/renderJob";
import { renderJobStore } from '../store/renderJobStore';

// The export pipeline (encoders, FFmpeg, mp4box demux, the GPU export
// compositor) is most of the app's code and none of it is needed to edit, so
// it loads on the first render / FFmpeg action instead of with the editor.
// Repeat calls resolve from the module cache.
const loadRenderPipeline = () =>
  Promise.all([
    loadFfmpegService(),
    import("../export/hybridEncoder"),
    import("../ffmpeg/captions"),
    import("../webgpu/exportCompositor"),
  ]);

type RenderActionsDeps = {
  clips: Clip[];
  /**
   * Timeline tracks. The render path resolves its clip list through them so the
   * export sees the same stacking order and placement times the preview does
   * (#168 Phase B) rather than the media pool's array order.
   */
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
};

export function useRenderActions(deps: RenderActionsDeps) {
  const {
    clips,
    tracks,
    clipGroups,
    transitions,
    textOverlays,
  } = deps;

  /** Clips as the tracks lay them out, carrying the derived placement fields. */
  const effectiveClips = useMemo(
    () => selectTimelineClips({ tracks, clips, clipGroups }),
    [tracks, clips, clipGroups],
  );

  const [renderFailureMessage, setRenderFailureMessage] = useState<string | null>(
    null,
  );
  const [lastRenderError, setLastRenderError] = useState<unknown>(null);
  const [showMemoryWarning, setShowMemoryWarning] = useState(false);
  const pendingRenderRef = useRef<(() => Promise<void>) | null>(null);

  const performRender = useCallback(async () => {
    // Resolve which clips are on the timeline (active variants for grouped clips)
    const timelineClips = effectiveClips;
    if (timelineClips.length === 0) {
      renderJobStore.getState().setStatus("Upload clips before rendering.");
      return;
    }

    let ffmpeg: FfmpegServiceModule | null = null;
    try {
      const {
        exportSettings,
        finishing,
        colorManagement,
        forceFFmpeg,
        useCanvasRenderer,
        audioReactive,
        forceReencode,
        captionExportMode,
      } = settingsStore.getState();
      const {
        outputUrl,
        setStatus,
        setFfmpegFailed,
        setEncoderPath,
        setRenderPlan,
        setOutputUrl,
        setIsRendering,
        setProgressStage,
        setProgressValue,
        setProgressIndeterminate,
      } = renderJobStore.getState();

      // Reset FFmpeg load-failure state on a new render attempt.
      setFfmpegFailed(false);

      // Clean up previous render output URL before starting a new render
      if (outputUrl) {
        URL.revokeObjectURL(outputUrl);
      }

      setEncoderPath("");
      setRenderPlan(null);
      setOutputUrl(null);
      setRenderFailureMessage(null);
      setLastRenderError(null);
      setIsRendering(true);
      setProgressStage("Preparing render");
      setProgressValue(0);
      setProgressIndeterminate(false);

      const [
        ffmpegService,
        { hybridMergeClips },
        { applyCaptionsToRenderedVideo },
        { isWebGpuExportAvailable },
      ] = await loadRenderPipeline();
      ffmpeg = ffmpegService;
      const { calculateRenderPlan, isFfmpegLoading } = ffmpegService;

      // Caption cues are drawn into the composite by the GPU (WebCodecs)
      // compositor when the export mode is burn-in — one pass instead of the
      // FFmpeg post-pass's extra full re-encode. Every other case still falls
      // through to `applyCaptionsToRenderedVideo` below: the soft mux (a
      // stream copy), the MediaRecorder canvas path, and FFmpeg itself, none
      // of which composite a plan. `result.captionsBurnedIn` says which
      // happened, so the post-pass never burns a second copy.
      const { captions, captionStyle } = editorStore.getState();
      const captionBurnIn =
        captionExportMode === 'burn' && captions.length > 0
          ? { captions, captionStyle }
          : null;

      // Calculate render plan before starting. Probing WebGPU availability up
      // front lets the pre-render estimate (`encoderIntent`, `overlayKeying`,
      // `ffmpegFinishingGaps`) match what the toolbar shows after encoding —
      // not just the FFmpeg concat/reencode strategy.
      const webGpuAvailable = await isWebGpuExportAvailable();
      const plan = calculateRenderPlan(
        timelineClips,
        transitions,
        textOverlays,
        exportSettings,
        {
          finishing,
          forceFFmpeg,
          useCanvasRenderer,
          webGpuAvailable,
          forceReencode,
          outputColor: colorManagement.outputColor,
          mediaRecorderAvailable: typeof MediaRecorder !== "undefined",
          captionMode: captions.length > 0 ? captionExportMode : undefined,
        },
      );
      setRenderPlan(plan);
      setStatus(`Render plan: ${plan.description} (${plan.reason})`);

      // Track FFmpeg loading phase via the exported helper so we don't couple to
      // status message strings.
      const trackFfmpegLoading = (msg: string) => {
        renderJobStore.getState().setStatus(msg);
        renderJobStore.getState().setFfmpegLoading(isFfmpegLoading());
      };

      const handleProgress = (update: RenderProgressUpdate) => {
        const actions = renderJobStore.getState();
        actions.setProgressStage(update.stage);
        actions.setProgressIndeterminate(update.indeterminate === true);
        if (typeof update.progress === "number") {
          actions.setProgressValue(Math.max(0, Math.min(1, update.progress)));
        } else {
          actions.setProgressValue(null);
        }
      };

      const result = await hybridMergeClips(
        timelineClips,
        transitions,
        exportSettings,
        trackFfmpegLoading,
        handleProgress,
        forceFFmpeg,
        textOverlays,
        useCanvasRenderer,
        audioReactive,
        forceReencode,
        plan,
        clipGroups,
        finishing,
        editorStore.getState().masterAudio,
        captionBurnIn,
        colorManagement,
      );
      // Captions the compositor could not burn are attached after the encode,
      // so every remaining encoder path gets the same result — see
      // `ffmpeg/captions.ts`.
      const { width, height } = resolveTargetResolution(
        timelineClips,
        exportSettings,
      );
      const captionedBlob = await applyCaptionsToRenderedVideo(
        result.blob,
        captions,
        {
          mode: result.captionsBurnedIn ? 'none' : captionExportMode,
          width,
          height,
          projectStyle: captionStyle,
          crf: exportSettings.crf,
          preset: exportSettings.preset,
          totalDuration: computeTotalDuration(timelineClips, transitions),
          onStatus: (message) => renderJobStore.getState().setStatus(message),
          onProgress: handleProgress,
        },
      );

      const { finalizeRenderedVideo } = ffmpegService;
      const renderedBlob = await finalizeRenderedVideo(
        captionedBlob,
        exportSettings,
        trackFfmpegLoading,
        handleProgress,
      );
      const url = URL.createObjectURL(renderedBlob);
      setOutputUrl(url);
      setEncoderPath(result.path);

      // Update render plan if available from FFmpeg path
      if (result.renderPlan) {
        setRenderPlan(result.renderPlan);
      }

      const pathLabel = formatEncoderPathLabel(result.path);
      const outputLabel = exportSettings.outputFormat === 'prores' ? 'ProRes MOV' : 'MP4';
      setStatus(`Render complete via ${pathLabel}. Download your merged ${outputLabel}.`);
      setProgressStage(`Render complete via ${pathLabel}`);
      setProgressValue(1);
      setProgressIndeterminate(false);
    } catch (error) {
      const actions = renderJobStore.getState();
      const errMsg = normalizeError(error);
      console.error("Render failed (full details):", error);
      const recentLogs = ffmpeg?.getLastFfmpegLogs(30).join("\n");
      if (recentLogs) {
        console.error("Last captured FFmpeg logs:\n" + recentLogs);
      }
      const message = /FFmpeg failed to/i.test(errMsg)
        ? errMsg
        : `Render failed: ${errMsg}`;
      actions.setStatus(message);
      setRenderFailureMessage(message);
      setLastRenderError(error);
      // Surface FFmpeg load failures separately so the retry button appears.
      if (ffmpeg?.isFfmpegLoadFailed()) {
        actions.setFfmpegFailed(true);
      }
      // Leave logs in buffer so user can click "Copy Debug Info" to grab them.
      void loadDebugReport().catch(() => undefined);
    } finally {
      const actions = renderJobStore.getState();
      actions.setFfmpegLoading(false);
      actions.setIsRendering(false);
      // Always clean up FFmpeg VFS after each render attempt (success or failure)
      // to prevent memory pressure from accumulated temporary files.
      ffmpeg?.aggressiveCleanupFFmpegVFS().catch((err) => {
        console.warn("Error during FFmpeg cleanup:", err);
      });
    }
  }, [
    effectiveClips,
    clips,
    clipGroups,
    transitions,
    textOverlays,
  ]);

  const handleMerge = useCallback(async () => {
    // Check if high memory usage is detected based on actual timeline clips
    const timelineClipsForMemoryCheck = effectiveClips;
    if (isHighMemoryUsage(timelineClipsForMemoryCheck)) {
      // Show warning modal; actual render happens in handleMemoryWarningConfirm
      pendingRenderRef.current = performRender;
      setShowMemoryWarning(true);
      return;
    }

    // Otherwise, proceed directly
    await performRender();
  }, [effectiveClips, performRender]);

  // Remote concat: offload resolution-normalization + concat to the
  // HuggingFace space. Each clip is trimmed in-browser (a stream copy from
  // the start of the file, a frame-accurate re-encode otherwise), then all
  // clips are uploaded and stitched end to end at one resolution on native
  // FFmpeg. There is no compositor or mixer on the other end, so it runs only
  // for a plain base-lane concat — an allow-list (`remoteConcatBlockers`):
  // anything else is refused rather than silently dropped.
  // Use the normal Render for those.
  const reportFailure = useCallback((message: string | null, error: unknown) => {
    setRenderFailureMessage(message);
    setLastRenderError(error);
  }, []);

  const handleGpuStitch = useCallback(
    () => runRemoteConcat({ clips, effectiveClips, transitions, textOverlays, onFailure: reportFailure }),
    [effectiveClips, clips, transitions, textOverlays, reportFailure],
  );

  const handleMemoryWarningConfirm = useCallback(() => {
    setShowMemoryWarning(false);
    if (pendingRenderRef.current) {
      void pendingRenderRef.current();
      pendingRenderRef.current = null;
    }
  }, []);

  const handleMemoryWarningCancel = useCallback(() => {
    setShowMemoryWarning(false);
    pendingRenderRef.current = null;
    renderJobStore.getState().setStatus("Render cancelled.");
  }, []);

  const handleCopyDebugInfo = useCallback(
    () => copyDebugInfo({ clips, clipGroups, transitions, textOverlays, error: lastRenderError }),
    [clips, clipGroups, transitions, textOverlays, lastRenderError],
  );

  const handleDebugResetFFmpeg = useCallback(() => resetFfmpegForDebug(), []);
  const handleRetryFfmpegLoad = useCallback(() => retryFfmpegLoad(), []);

  const handleToggleCanvasRenderer = useCallback((v: boolean) => {
    settingsStore.getState().setUseCanvasRenderer(v);
    if (v) settingsStore.getState().setForceFFmpeg(false); // canvas overrides CPU-only mode
  }, []);

  return {
    renderFailureMessage,
    setRenderFailureMessage,
    showMemoryWarning,
    performRender,
    handleMerge,
    handleGpuStitch,
    handleMemoryWarningConfirm,
    handleMemoryWarningCancel,
    handleCopyDebugInfo,
    handleDebugResetFFmpeg,
    handleRetryFfmpegLoad,
    handleToggleCanvasRenderer,
  };
}
