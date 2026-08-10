import { useCallback, useRef, useState } from "react";
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from "../types";
import type { RenderPlan } from "../types";
import { getTimelineClips } from "../utils/timelineClips";
import { resolveTargetResolution } from "../utils/resolution";
import { formatEncoderPathLabel } from "../utils/encoderPathLabel";
import { hybridMergeClips } from "../utils/hybrid-encoder";
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
} from "../ffmpeg/ffmpegService";
import type { RenderProgressUpdate } from "../ffmpeg/ffmpegService";
import {
  isHighMemoryUsage,
  getMemoryStatus,
} from "../utils/memory";
import { generateDebugReport } from "../utils/debugReport";
import type { FinishingSettings } from "../utils/finishing";

type RenderActionsDeps = {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings: ExportSettings;
  finishing: FinishingSettings;
  forceFFmpeg: boolean;
  useCanvasRenderer: boolean;
  audioReactive: boolean;
  forceReencode: boolean;
  outputUrl: string | null;
  status: string;
  renderPlan: RenderPlan | null;
  encoderPath: string;
  setStatus: (status: string) => void;
  setFinishing: (settings: FinishingSettings) => void;
  setForceFFmpeg: (v: boolean) => void;
  setUseCanvasRenderer: (v: boolean) => void;
  setAudioReactive: (v: boolean) => void;
  setForceReencode: (v: boolean) => void;
  setProgressStage: (stage: string) => void;
  setProgressValue: (value: number | null) => void;
  setProgressIndeterminate: (v: boolean) => void;
  setIsRendering: (v: boolean) => void;
  setFfmpegLoading: (v: boolean) => void;
  setFfmpegFailed: (v: boolean) => void;
  setOutputUrl: (url: string | null) => void;
  setEncoderPath: (path: string) => void;
  setRenderPlan: (plan: RenderPlan | null) => void;
};

export function useRenderActions(deps: RenderActionsDeps) {
  const {
    clips,
    clipGroups,
    transitions,
    textOverlays,
    exportSettings,
    finishing,
    forceFFmpeg,
    useCanvasRenderer,
    audioReactive,
    forceReencode,
    outputUrl,
    status,
    renderPlan,
    encoderPath,
    setStatus,
    setForceFFmpeg,
    setUseCanvasRenderer,
    setProgressStage,
    setProgressValue,
    setProgressIndeterminate,
    setIsRendering,
    setFfmpegLoading,
    setFfmpegFailed,
    setOutputUrl,
    setEncoderPath,
    setRenderPlan,
  } = deps;

  const [renderFailureMessage, setRenderFailureMessage] = useState<string | null>(
    null,
  );
  const [lastRenderError, setLastRenderError] = useState<unknown>(null);
  const [showMemoryWarning, setShowMemoryWarning] = useState(false);
  const pendingRenderRef = useRef<(() => Promise<void>) | null>(null);

  const performRender = useCallback(async () => {
    // Resolve which clips are on the timeline (active variants for grouped clips)
    const timelineClips = getTimelineClips(clips, clipGroups);
    if (timelineClips.length === 0) {
      setStatus("Upload clips before rendering.");
      return;
    }

    try {
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

      // Calculate render plan before starting
      const plan = calculateRenderPlan(
        timelineClips,
        transitions,
        textOverlays,
        exportSettings,
      );
      setRenderPlan(plan);
      setStatus(`Render plan: ${plan.description} (${plan.reason})`);

      // Track FFmpeg loading phase via the exported helper so we don't couple to
      // status message strings.
      const trackFfmpegLoading = (msg: string) => {
        setStatus(msg);
        setFfmpegLoading(isFfmpegLoading());
      };

      const handleProgress = (update: RenderProgressUpdate) => {
        setProgressStage(update.stage);
        setProgressIndeterminate(update.indeterminate === true);
        if (typeof update.progress === "number") {
          setProgressValue(Math.max(0, Math.min(1, update.progress)));
        } else {
          setProgressValue(null);
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
      );
      const url = URL.createObjectURL(result.blob);
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
      // Fixed "Render failed: undefined" by normalizing worker string errors.
      const errMsg = normalizeError(error);
      console.error("Render failed (full details):", error);
      const recentLogs = getLastFfmpegLogs(30).join("\n");
      if (recentLogs) {
        console.error("Last captured FFmpeg logs:\n" + recentLogs);
      }
      const message = /FFmpeg failed to/i.test(errMsg)
        ? errMsg
        : `Render failed: ${errMsg}`;
      setStatus(message);
      setRenderFailureMessage(message);
      setLastRenderError(error);
      // Surface FFmpeg load failures separately so the retry button appears.
      if (isFfmpegLoadFailed()) {
        setFfmpegFailed(true);
      }
      // Leave logs in buffer so user can click "Copy Debug Info" to grab them.
    } finally {
      setFfmpegLoading(false);
      setIsRendering(false);
      // Always clean up FFmpeg VFS after each render attempt (success or failure)
      // to prevent memory pressure from accumulated temporary files.
      aggressiveCleanupFFmpegVFS().catch((err) => {
        console.warn("Error during FFmpeg cleanup:", err);
      });
    }
  }, [
    clips,
    clipGroups,
    transitions,
    textOverlays,
    exportSettings,
    forceFFmpeg,
    useCanvasRenderer,
    audioReactive,
    forceReencode,
    outputUrl,
    finishing,
    setStatus,
    setFfmpegFailed,
    setEncoderPath,
    setRenderPlan,
    setOutputUrl,
    setIsRendering,
    setProgressStage,
    setProgressValue,
    setProgressIndeterminate,
    setFfmpegLoading,
  ]);

  const handleMerge = useCallback(async () => {
    // Check if high memory usage is detected based on actual timeline clips
    const timelineClipsForMemoryCheck = getTimelineClips(clips, clipGroups);
    if (isHighMemoryUsage(timelineClipsForMemoryCheck)) {
      // Show warning modal; actual render happens in handleMemoryWarningConfirm
      pendingRenderRef.current = performRender;
      setShowMemoryWarning(true);
      return;
    }

    // Otherwise, proceed directly
    await performRender();
  }, [clips, clipGroups, performRender]);

  // GPU stitch: offload resolution-normalization + concat to the HuggingFace
  // space. Each clip is trimmed in-browser (cheap, lossless copy), then all
  // clips are uploaded and stitched at one resolution on the GPU. This path
  // ignores fades/transitions/PiP/overlays — use the normal Render for those.
  const handleGpuStitch = useCallback(async () => {
    const timelineClips = getTimelineClips(clips, clipGroups).filter(
      (clip) => clip.kind === "video",
    );
    if (timelineClips.length === 0) {
      setStatus("Add at least one video clip before GPU stitching.");
      return;
    }

    try {
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      setOutputUrl(null);
      setEncoderPath("");
      setRenderPlan(null);
      setRenderFailureMessage(null);
      setLastRenderError(null);
      setIsRendering(true);
      setProgressIndeterminate(true);
      setProgressValue(null);
      setProgressStage("GPU stitch");

      // Step 1: trim each clip in timeline order (FFmpeg lossless copy).
      const clipBlobs: Blob[] = [];
      for (let i = 0; i < timelineClips.length; i++) {
        setStatus(
          `Preparing clip ${i + 1}/${timelineClips.length} for GPU stitch…`,
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
        (event) => setStatus(event.message ?? `GPU stitch: ${event.stage}…`),
      );

      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
      setEncoderPath("gpu-stitch");
      setStatus(
        `✅ GPU stitch complete at ${resolution}. Download your merged MP4.`,
      );
      setProgressStage("GPU stitch complete");
      setProgressValue(1);
      setProgressIndeterminate(false);
    } catch (error) {
      const errMsg = normalizeError(error);
      console.error("GPU stitch error:", error);
      const recentLogs = getLastFfmpegLogs(30).join("\n");
      if (recentLogs) {
        console.error("Last captured FFmpeg logs:\n" + recentLogs);
      }
      const message = errMsg.startsWith("GPU stitch failed:")
        ? errMsg
        : `GPU stitch failed: ${errMsg}`;
      setStatus(message);
      setRenderFailureMessage(message);
      setLastRenderError(error);
    } finally {
      setIsRendering(false);
      setProgressIndeterminate(false);
      aggressiveCleanupFFmpegVFS().catch(() => {});
    }
  }, [
    clips,
    clipGroups,
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
    setStatus("Render cancelled.");
  }, [setStatus]);

  /** Copy rich diagnostics (status + render plan + last FFmpeg logs + browser info) to clipboard. */
  const handleCopyDebugInfo = useCallback(async () => {
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
    status,
    renderPlan,
    encoderPath,
    clips,
    clipGroups,
    transitions,
    textOverlays,
    exportSettings,
    lastRenderError,
    setStatus,
  ]);

  const handleDebugResetFFmpeg = useCallback(async () => {
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
  }, [setStatus]);

  const handleRetryFfmpegLoad = useCallback(async () => {
    setStatus("Resetting FFmpeg and retrying load...");
    setFfmpegFailed(false);
    setFfmpegLoading(true);
    try {
      await resetFFmpegInstance();
      await ensureFfmpeg(
        (msg) => setStatus(msg),
        (update) => {
          setProgressStage(update.stage);
          setProgressIndeterminate(update.indeterminate === true);
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
  }, [
    setStatus,
    setFfmpegFailed,
    setFfmpegLoading,
    setProgressStage,
    setProgressIndeterminate,
  ]);

  const handleToggleCanvasRenderer = useCallback((v: boolean) => {
    setUseCanvasRenderer(v);
    if (v) setForceFFmpeg(false); // canvas overrides CPU-only mode
  }, [setUseCanvasRenderer, setForceFFmpeg]);

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
