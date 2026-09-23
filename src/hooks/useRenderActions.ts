import { useCallback, useMemo, useRef, useState } from "react";
import type { Clip, ClipGroup, ClipTransition, ExportSettings, MasterAudio, TextOverlay, Track } from "../types";
import { editorStore } from "../store/editorStore";
import type { RenderPlan } from "../types";
import { getEffectiveTimelineClips } from "../utils/timelineClips";
import { resolveTargetResolution } from "../utils/resolution";
import { formatEncoderPathLabel } from "../utils/encoderPathLabel";
import { hybridMergeClips } from "../utils/hybrid-encoder";
import { applyCaptionsToRenderedVideo } from "../ffmpeg/captions";
import { computeTotalDuration } from "../utils/transitions";
import {
  extractTrimmedVideoClip,
  calculateRenderPlan,
  aggressiveCleanupFFmpegVFS,
  resetFFmpegInstance,
  getLastFfmpegLogs,
  isFfmpegLoadFailed,
  isFfmpegLoading,
  ensureFfmpeg,
  normalizeError,
  remuxStitchedMp4ForNle,
} from "../ffmpeg/ffmpegService";
import type { RenderProgressUpdate } from "../ffmpeg/ffmpegService";
import {
  isHighMemoryUsage,
  getMemoryStatus,
} from "../utils/memory";
import { generateDebugReport } from "../utils/debugReport";
import { isFinishingActive } from "../utils/finishing";
import type { FinishingSettings } from "../utils/finishing";
import { hasActiveTransitions } from "../utils/renderEligibility";
import { resolveLayerKey } from "../utils/overlayKey";
import { isWebGpuExportAvailable } from "../webgpu/exportCompositor";

import { settingsStore } from "../store/settingsStore";

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
    () => getEffectiveTimelineClips(tracks, clips, clipGroups),
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
      settingsStore.getState().setStatus("Upload clips before rendering.");
      return;
    }

    try {
      const { 
        exportSettings, 
        finishing, 
        forceFFmpeg, 
        useCanvasRenderer, 
        audioReactive, 
        forceReencode,
        captionExportMode,
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
        setFfmpegLoading
      } = settingsStore.getState();

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
          captionMode: captions.length > 0 ? captionExportMode : undefined,
        },
      );
      setRenderPlan(plan);
      setStatus(`Render plan: ${plan.description} (${plan.reason})`);

      // Track FFmpeg loading phase via the exported helper so we don't couple to
      // status message strings.
      const trackFfmpegLoading = (msg: string) => {
        settingsStore.getState().setStatus(msg);
        settingsStore.getState().setFfmpegLoading(isFfmpegLoading());
      };

      const handleProgress = (update: RenderProgressUpdate) => {
        const actions = settingsStore.getState();
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
          onStatus: (message) => settingsStore.getState().setStatus(message),
          onProgress: handleProgress,
        },
      );

      const url = URL.createObjectURL(captionedBlob);
      setOutputUrl(url);
      setEncoderPath(result.path);

      // Update render plan if available from FFmpeg path
      if (result.renderPlan) {
        setRenderPlan(result.renderPlan);
      }

      const pathLabel = formatEncoderPathLabel(result.path);
      setStatus(`Render complete via ${pathLabel}. Download your merged MP4.`);
      setProgressStage(`Render complete via ${pathLabel}`);
      setProgressValue(1);
      setProgressIndeterminate(false);
    } catch (error) {
      const actions = settingsStore.getState();
      const errMsg = normalizeError(error);
      console.error("Render failed (full details):", error);
      const recentLogs = getLastFfmpegLogs(30).join("\n");
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
      if (isFfmpegLoadFailed()) {
        actions.setFfmpegFailed(true);
      }
      // Leave logs in buffer so user can click "Copy Debug Info" to grab them.
    } finally {
      const actions = settingsStore.getState();
      actions.setFfmpegLoading(false);
      actions.setIsRendering(false);
      // Always clean up FFmpeg VFS after each render attempt (success or failure)
      // to prevent memory pressure from accumulated temporary files.
      aggressiveCleanupFFmpegVFS().catch((err) => {
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
  // HuggingFace space. Each clip is trimmed in-browser (cheap, lossless
  // copy), then all clips are uploaded and stitched end to end at one
  // resolution on native FFmpeg. There is no compositor on the other end —
  // it only sequences base-lane clips — so it refuses to run whenever the
  // timeline needs one: transitions, PiP/overlay lanes, finishing, chroma/
  // luma keys, captions, and text overlays would all be silently dropped.
  // Use the normal Render for those; this path is for a plain concat only.
  const handleGpuStitch = useCallback(async () => {
    const timelineClips = effectiveClips.filter((clip) => clip.kind === "video");
    if (clips.filter((c) => c.kind === "video").length === 0) {
      settingsStore.getState().setStatus("Add at least one video clip before remote concat.");
      return;
    }

    const { finishing } = settingsStore.getState();
    const { captions } = editorStore.getState();
    const hasNonBaseLane = effectiveClips.some((clip) => (clip.layerIndex ?? 0) > 0);
    const hasKeyedClip = effectiveClips.some((clip) => resolveLayerKey(clip) !== null);
    const skippedFeatures: string[] = [];
    if (hasNonBaseLane) skippedFeatures.push("PiP/overlay lanes");
    if (hasActiveTransitions(transitions)) skippedFeatures.push("transitions");
    if (textOverlays.length > 0) skippedFeatures.push("text overlays");
    if (isFinishingActive(finishing)) skippedFeatures.push("finishing");
    if (hasKeyedClip) skippedFeatures.push("chroma/luma keys");
    if (captions.length > 0) skippedFeatures.push("captions");
    if (skippedFeatures.length > 0) {
      settingsStore.getState().setStatus(
        `Remote concat ignores the timeline compositor and would drop ${skippedFeatures.join(", ")} — use Render instead.`,
      );
      return;
    }

    try {
      const {
        exportSettings,
        outputUrl,
        setStatus,
        setOutputUrl,
        setEncoderPath,
        setRenderPlan,
        setIsRendering,
        setProgressIndeterminate,
        setProgressValue,
        setProgressStage,
      } = settingsStore.getState();

      if (outputUrl) URL.revokeObjectURL(outputUrl);
      setOutputUrl(null);
      setEncoderPath("");
      setRenderPlan(null);
      setRenderFailureMessage(null);
      setLastRenderError(null);
      setIsRendering(true);
      setProgressIndeterminate(true);
      setProgressValue(null);
      setProgressStage("Remote concat");

      // Step 1: trim each clip in timeline order (FFmpeg lossless copy).
      const clipBlobs: Blob[] = [];
      for (let i = 0; i < timelineClips.length; i++) {
        setStatus(
          `Preparing clip ${i + 1}/${timelineClips.length} for remote concat…`,
        );
        clipBlobs.push(
          await extractTrimmedVideoClip(timelineClips[i], setStatus),
        );
      }

      // Step 2: upload + stitch at one resolution on the GPU.
      const { width, height } = resolveTargetResolution(
        timelineClips,
        exportSettings,
      );
      const resolution = `${width}x${height}`;
      const { stitchClipsOnGpu } = await import("../utils/huggingface");
      const { blob } = await stitchClipsOnGpu(
        clipBlobs,
        resolution,
        (event) => setStatus(event.message ?? `Remote concat: ${event.stage}…`),
      );

      const nleBlob = await remuxStitchedMp4ForNle(blob, setStatus);
      const url = URL.createObjectURL(nleBlob);
      setOutputUrl(url);
      setEncoderPath("gpu-stitch");
      setStatus(
        `✅ Remote concat complete at ${resolution}. Download your merged MP4.`,
      );
      setProgressStage("Remote concat complete");
      setProgressValue(1);
      setProgressIndeterminate(false);
    } catch (error) {
      const { setStatus } = settingsStore.getState();
      const errMsg = normalizeError(error);
      console.error("Remote concat error:", error);
      const recentLogs = getLastFfmpegLogs(30).join("\n");
      if (recentLogs) {
        console.error("Last captured FFmpeg logs:\n" + recentLogs);
      }
      // huggingface.ts still raises its own errors as "GPU stitch failed: …"
      // (the library predates the button's "Remote concat" rename) — accept
      // either prefix so this doesn't double up into "Remote concat failed:
      // GPU stitch failed: …".
      const message = /^(remote concat|gpu stitch) failed:/i.test(errMsg)
        ? errMsg
        : `Remote concat failed: ${errMsg}`;
      setStatus(message);
      setRenderFailureMessage(message);
      setLastRenderError(error);
    } finally {
      const { setIsRendering, setProgressIndeterminate } = settingsStore.getState();
      setIsRendering(false);
      setProgressIndeterminate(false);
      aggressiveCleanupFFmpegVFS().catch(() => {});
    }
  }, [
    effectiveClips,
    clips,
    transitions,
    textOverlays,
  ]);

  const handleMemoryWarningConfirm = useCallback(() => {
    setShowMemoryWarning(false);
    if (pendingRenderRef.current) {
      pendingRenderRef.current();
      pendingRenderRef.current = null;
    }
  }, []);

  const handleMemoryWarningCancel = useCallback(() => {
    setShowMemoryWarning(false);
    pendingRenderRef.current = null;
    settingsStore.getState().setStatus("Render cancelled.");
  }, []);

  /** Copy rich diagnostics (status + render plan + last FFmpeg logs + browser info) to clipboard. */
  const handleCopyDebugInfo = useCallback(async () => {
    const { status, renderPlan, encoderPath, exportSettings, setStatus } = settingsStore.getState();
    const text = generateDebugReport({
      status,
      renderPlan,
      encoderPath,
      clips,
      clipGroups,
      transitions,
      textOverlays,
      exportSettings,
      error: lastRenderError ?? undefined,
    });
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Debug report copied to clipboard (include in bug reports).");
    } catch {
      console.log(text);
      setStatus("Debug report logged to console (clipboard blocked).");
      window.alert(
        "Debug report in console. First 800 chars:\n\n" + text.slice(0, 800),
      );
    }
  }, [
    effectiveClips,
    clips,
    clipGroups,
    transitions,
    textOverlays,
    lastRenderError,
  ]);

  const handleDebugResetFFmpeg = useCallback(async () => {
    const { setStatus } = settingsStore.getState();
    setStatus("Resetting FFmpeg instance (debug action)...");
    try {
      await resetFFmpegInstance();
      const memoryStatus = getMemoryStatus();
      const message = memoryStatus
        ? `FFmpeg instance reset. Memory: ${memoryStatus}`
        : "FFmpeg instance reset.";
      setStatus(message);
    } catch (err) {
      setStatus(`Error resetting FFmpeg: ${(err as Error).message}`);
    }
  }, []);

  const handleRetryFfmpegLoad = useCallback(async () => {
    const { setStatus, setFfmpegFailed, setFfmpegLoading, setProgressStage, setProgressIndeterminate } = settingsStore.getState();
    setStatus("Resetting FFmpeg and retrying load...");
    setFfmpegFailed(false);
    setFfmpegLoading(true);
    try {
      await resetFFmpegInstance();
      await ensureFfmpeg(
        (msg) => settingsStore.getState().setStatus(msg),
        (update) => {
          settingsStore.getState().setProgressStage(update.stage);
          settingsStore.getState().setProgressIndeterminate(update.indeterminate === true);
        },
      );
      setStatus("FFmpeg loaded successfully. Click Render to start.");
    } catch (err) {
      const message = (err as Error).message;
      setStatus(message);
      setFfmpegFailed(true);
    } finally {
      setFfmpegLoading(false);
    }
  }, []);

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
