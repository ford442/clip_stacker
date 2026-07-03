import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Clip,
  ClipGroup,
  ClipKeyframes,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  RenderPlan,
} from "./types";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import { getMediaInfo, createClipId, MIN_CLIP_DURATION } from "./utils/media";
import { createKenBurnsKeyframes } from "./utils/animatedLayout";
import { resolveClipLocalTimeAtGlobal } from "./utils/previewComposition";
import { computeTotalDuration } from "./utils/transitions";
import {
  sanitizeClipAdjustments,
  serializeProjectWithMedia,
  applyProjectData,
  loadRemoteProject,
  downloadRemoteMedia,
  getClipDuration,
  ContaboStorageManagerClient,
  type RemoteProjectLoadProgressEvent,
  type MediaLibraryItem,
} from "./utils/project";
import { clampClipVolume } from "./utils/audioVolume";
import { findMatchingClipIndex } from "./utils/clipMatching";
import { DEFAULT_SCROLL_SPEED } from "./utils/textOverlay";
import { reindexTransitions, shiftTransitionsForInsert } from "./utils/transitions";
import {
  isMorphTransition,
  shouldRegenerateMorph,
} from "./utils/morphTransition";
import {
  duplicateClip,
  removeClipFromGroups,
  splitClipAt,
} from "./utils/clipOperations";
import { hybridMergeClips } from "./utils/hybrid-encoder";
import {
  extractAudioToWav,
  extractTrimmedVideoClip,
  muxProcessedVideoWithSourceAudio,
  calculateRenderPlan,
  aggressiveCleanupFFmpegVFS,
  resetFFmpegInstance,
  getLastFfmpegLogs,
  clearFfmpegLogs,
  isFfmpegLoadFailed,
  isFfmpegLoading,
  ensureFfmpeg,
  normalizeError,
} from "./ffmpeg/ffmpegService";
import type { RenderProgressUpdate } from "./ffmpeg/ffmpegService";
import {
  isHighMemoryUsage,
  getMemoryStatus,
  formatBytes,
} from "./utils/memory";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { Toolbar } from "./components/Toolbar";
import { StorageRow } from "./components/StorageRow";
import { MediaLibraryPanel } from "./components/MediaLibraryPanel";
import { ClipLibrary } from "./components/ClipLibrary";
import { Inspector } from "./components/Inspector";
import type { ClipValues } from "./components/Inspector";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { TextOverlayPanel } from "./components/TextOverlayPanel";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { MemoryWarningModal } from "./components/MemoryWarningModal";
import { RecoveryModal } from "./components/RecoveryModal";
import { RenderFailurePanel } from "./components/RenderFailurePanel";
import { useProjectSaveLoad } from "./hooks/useProjectSaveLoad";
import { useRenderState } from "./hooks/useRenderState";
import { useEditHistory } from "./hooks/useEditHistory";
import { useAutoSave } from "./hooks/useAutoSave";
import { getTimelineClips } from "./utils/timelineClips";
import { resolveTargetResolution } from "./utils/resolution";
import {
  readStorageAuthToken,
  writeStorageAuthToken,
} from "./utils/storageAuth";
import { generateDebugReport } from "./utils/debugReport";

function formatSkippedClipMessage(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, and ${names.length - 3} more`;
}

type RemoteUploadItem = {
  clipId: string;
  fileName: string;
  index: number;
  total: number;
  progress: number;
  status: "pending" | "uploading" | "uploaded" | "failed" | "skipped";
  error?: string;
};

type PendingRemoteUploadError = {
  fileName: string;
  index: number;
  total: number;
  error: string;
};

export function App() {
  const {
    clips,
    clipGroups,
    transitions,
    textOverlays,
    selectedClipId,
    setClips,
    setClipGroups,
    setTransitions,
    setTextOverlays,
    setSelectedClipId,
    pushHistory,
    pushHistoryDebounced,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
  } = useEditHistory();
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [showMemoryWarning, setShowMemoryWarning] = useState(false);
  const [previewPlayheadTime, setPreviewPlayheadTime] = useState<number | null>(null);
  const pendingRenderRef = useRef<(() => Promise<void>) | null>(null);

  const {
    exportSettings,
    setExportSettings,
    colorGrade,
    setColorGrade,
    forceFFmpeg,
    setForceFFmpeg,
    useCanvasRenderer,
    setUseCanvasRenderer,
    audioReactive,
    setAudioReactive,
    forceReencode,
    setForceReencode,
    status,
    setStatus,
    progressStage,
    setProgressStage,
    progressValue,
    setProgressValue,
    progressIndeterminate,
    setProgressIndeterminate,
    isRendering,
    setIsRendering,
    ffmpegLoading,
    setFfmpegLoading,
    ffmpegFailed,
    setFfmpegFailed,
    outputUrl,
    setOutputUrl,
    encoderPath,
    setEncoderPath,
    renderPlan,
    setRenderPlan,
    rifeProcessingClipId,
    setRifeProcessingClipId,
  } = useRenderState();

  const [renderFailureMessage, setRenderFailureMessage] = useState<string | null>(
    null,
  );
  const [lastRenderError, setLastRenderError] = useState<unknown>(null);

  const {
    handleSaveProject,
    handleLoadProject,
    handleSaveRemote,
    handleLoadRemote,
    isRemoteSaving,
    isRemoteLoading,
    remoteLoadStage,
    remoteLoadProgress,
    remoteLoadIndeterminate,
    remoteUploadItems,
    pendingRemoteUploadError,
    resolveRemoteUploadError,
  } = useProjectSaveLoad({
    clips,
    clipGroups,
    transitions,
    textOverlays,
    colorGrade,
    setColorGrade,
    setClips,
    setClipGroups,
    setSelectedClipId,
    setTransitions,
    setTextOverlays,
    setStatus,
    resetHistory,
  });

  const {
    recoveryOffer,
    isRecovering,
    handleRecover,
    handleDiscardRecovery,
  } = useAutoSave({
    clips,
    clipGroups,
    transitions,
    textOverlays,
    selectedClipId,
    exportSettings,
    setExportSettings,
    resetHistory,
    setStatus,
    enabled: !isRendering,
  });

  // Ref to access Toolbar's triggerLoadDialog
  const toolbarRef = useRef<{ triggerLoadDialog: () => void }>(null);

  /** Toggle canvas renderer; canvas and forceFFmpeg are mutually exclusive. */
  const handleToggleCanvasRenderer = useCallback((v: boolean) => {
    setUseCanvasRenderer(v);
    if (v) setForceFFmpeg(false); // canvas overrides CPU-only mode
  }, []);
  const [storageEndpoint, setStorageEndpoint] = useState(
    "https://storage.noahcohn.com/webhook/clip-stacker",
  );
  const [storageAuthToken, setStorageAuthToken] = useState(readStorageAuthToken);
  const handleStorageAuthTokenChange = useCallback((value: string) => {
    setStorageAuthToken(value);
    writeStorageAuthToken(value);
  }, []);
  const pendingRemoteUploadResolver = useRef<
    ((action: "retry" | "skip" | "abort") => void) | null
  >(null);
  const isRemoteLoadingRef = useRef(false);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  useEffect(() => {
    if (!selectedClip) {
      setPreviewPlayheadTime(null);
      return;
    }
    setPreviewPlayheadTime(selectedClip.trimStart);
  }, [selectedClip?.id, selectedClip?.trimStart]);

  // ---------------------------------------------------------------------------
  // Clip management helpers
  // ---------------------------------------------------------------------------

  /** Add a new clip to the state and set up A/B grouping if a matching clip exists. */
  const addClipToState = useCallback((newClip: Clip) => {
    setClips((prevClips) => {
      const existingNames = prevClips.map((c) => c.file.name);
      const matchIndex = findMatchingClipIndex(
        existingNames,
        newClip.file.name,
      );

      if (matchIndex >= 0) {
        // Found a match — assign to existing group as variant B
        const matchedClip = prevClips[matchIndex];
        const groupId = matchedClip.groupId ?? createClipId();

        setClipGroups((prevGroups) => {
          const existingGroup = prevGroups.find((g) => g.id === groupId);
          if (existingGroup) {
            // Update existing group
            return prevGroups.map((g) =>
              g.id === groupId
                ? {
                    ...g,
                    variants: {
                      ...g.variants,
                      B: { ...newClip, groupId, groupVariant: "B" },
                    },
                  }
                : g,
            );
          }
          // Create new group from matched clip + new clip
          return [
            ...prevGroups,
            {
              id: groupId,
              variants: {
                A: { ...matchedClip, groupId, groupVariant: "A" },
                B: { ...newClip, groupId, groupVariant: "B" },
              },
              activeVariant: "A", // keep the original on the timeline by default
            },
          ];
        });

        // Tag the matched clip with its group
        const taggedMatch = {
          ...matchedClip,
          groupId,
          groupVariant: "A" as const,
        };
        const taggedNew = { ...newClip, groupId, groupVariant: "B" as const };

        return prevClips
          .map((c, i) => (i === matchIndex ? taggedMatch : c))
          .concat(taggedNew);
      }

      // No match — just append
      return [...prevClips, newClip];
    });
  }, []);

  const insertClipAfter = useCallback(
    (index: number, newClip: Clip) => {
      setClips((prev) => {
        const next = [...prev];
        next.splice(index + 1, 0, newClip);
        return next;
      });
      setTransitions((prev) => shiftTransitionsForInsert(prev, index + 1));
    },
    [setClips, setTransitions],
  );

  const handleDuplicateClip = useCallback(() => {
    if (!selectedClipId) {
      setStatus("Select a clip to duplicate.");
      return;
    }

    const index = clips.findIndex((clip) => clip.id === selectedClipId);
    if (index < 0) return;

    pushHistory();
    const source = clips[index];
    const copy = duplicateClip(source);
    insertClipAfter(index, copy);
    setSelectedClipId(copy.id);
    setPreviewPlayheadTime(copy.trimStart);
    setOutputUrl(null);
    setStatus(`Duplicated "${source.title}".`);
  }, [
    clips,
    selectedClipId,
    pushHistory,
    insertClipAfter,
    setSelectedClipId,
    setStatus,
    setOutputUrl,
  ]);

  const handleSplitClip = useCallback(() => {
    if (!selectedClipId) {
      setStatus("Select a clip to split.");
      return;
    }
    if (previewPlayheadTime === null) {
      setStatus("Move the preview playhead before splitting.");
      return;
    }

    const index = clips.findIndex((clip) => clip.id === selectedClipId);
    if (index < 0) return;

    const source = clips[index];
    const split = splitClipAt(source, previewPlayheadTime);
    if (!split) {
      setStatus(
        "Cannot split here — place the playhead at least 0.1s inside the trimmed region.",
      );
      return;
    }

    pushHistory();
    const [left, right] = split;
    setClips((prev) => {
      const next = [...prev];
      next.splice(index, 1, left, right);
      return next;
    });
    setTransitions((prev) => shiftTransitionsForInsert(prev, index + 1));
    if (source.groupId) {
      setClipGroups((prev) => removeClipFromGroups(prev, source));
    }
    setSelectedClipId(right.id);
    setPreviewPlayheadTime(right.trimStart);
    setOutputUrl(null);
    setStatus(
      `Split "${source.title}" at ${previewPlayheadTime.toFixed(2)}s.`,
    );
  }, [
    clips,
    selectedClipId,
    previewPlayheadTime,
    pushHistory,
    setClipGroups,
    setSelectedClipId,
    setStatus,
    setOutputUrl,
  ]);

  const handleAddClips = useCallback(
    async (files: File[]) => {
      setStatus("Importing clips...");
      let added = 0;
      let pushedHistory = false;

      for (const file of files) {
        const isVideo =
          file.type.startsWith("video/") ||
          file.name.toLowerCase().endsWith(".mp4");
        const isAudio =
          file.type.startsWith("audio/") || /\.(wav|mp3)$/i.test(file.name);
        const isImage =
          file.type.startsWith("image/") ||
          /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name);
        if (!isVideo && !isAudio && !isImage) continue;

        try {
          const { duration, objectUrl, videoWidth, videoHeight } =
            await getMediaInfo(file);
          const newClip: Clip = {
            id: createClipId(),
            file,
            objectUrl,
            title: file.name,
            kind: isAudio ? "audio" : "video",
            duration: Math.max(MIN_CLIP_DURATION, duration),
            videoWidth,
            videoHeight,
            trimStart: 0,
            trimEnd: NaN,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            ...(isImage ? { stillImage: true } : {}),
          };
          if (!pushedHistory) {
            pushHistory();
            pushedHistory = true;
          }
          addClipToState(newClip);
          setSelectedClipId(newClip.id);
          added++;
        } catch (error) {
          setStatus(
            `Failed to import ${file.name}: ${(error as Error).message}`,
          );
        }
      }

      if (added > 0) {
        setOutputUrl(null);
        setStatus(`${added} clip(s) imported.`);
      } else {
        setStatus(
          "No media files could be imported. Check that files are valid MP4/WAV/MP3/JPEG/PNG.",
        );
      }
    },
    [addClipToState, pushHistory],
  );

  const handleAddLibraryClip = useCallback(
    async (item: MediaLibraryItem) => {
      setStatus(`Downloading ${item.name} from media library...`);
      try {
        const blob = await downloadRemoteMedia(item.url);
        const file = new File([blob], item.name, { type: blob.type });
        const isAudio =
          file.type.startsWith("audio/") || /\.(wav|mp3)$/i.test(file.name);
        const { duration, objectUrl, videoWidth, videoHeight } =
          await getMediaInfo(file);
        const newClip: Clip = {
          id: createClipId(),
          file,
          objectUrl,
          title: file.name,
          kind: isAudio ? "audio" : "video",
          duration: Math.max(MIN_CLIP_DURATION, duration),
          videoWidth,
          videoHeight,
          trimStart: 0,
          trimEnd: NaN,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          remoteSourceUrl: item.url,
        };
        pushHistory();
        addClipToState(newClip);
        setSelectedClipId(newClip.id);
        setOutputUrl(null);
        setStatus(`Added "${item.name}" from media library.`);
      } catch (error) {
        setStatus(
          `Could not add "${item.name}" from media library: ${(error as Error).message}`,
        );
      }
    },
    [addClipToState, pushHistory],
  );

  // ---------------------------------------------------------------------------
  // A/B group toggle
  // ---------------------------------------------------------------------------

  const handleToggleVariant = useCallback(
    (groupId: string, variant: "A" | "B") => {
      pushHistory();
      setClipGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, activeVariant: variant } : g,
        ),
      );
      setClips((prevClips) => {
        // Find the group
        // We need the latest groups state — use functional update pattern
        // The newly selected variant clip becomes the one on the timeline
        return prevClips.map((c) => {
          if (c.groupId !== groupId) return c;
          // The clip that matches the chosen variant stays, the other is "background"
          return c;
        });
      });
    },
    [pushHistory],
  );

  // ---------------------------------------------------------------------------
  // Render / merge
  // ---------------------------------------------------------------------------

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
        colorGrade,
      );
      const url = URL.createObjectURL(result.blob);
      setOutputUrl(url);
      setEncoderPath(result.path);

      // Update render plan if available from FFmpeg path
      if (result.renderPlan) {
        setRenderPlan(result.renderPlan);
      }

      const pathLabel =
        result.path === "canvas"
          ? "🎨 Canvas (audio-reactive)"
          : result.path === "webcodecs"
            ? "⚡ GPU (WebCodecs)"
            : "🖥 FFmpeg";
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
      const { stitchClipsOnGpu } = await import("./utils/huggingface");
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
  }, [clips, clipGroups, exportSettings, outputUrl]);

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
  }, []);

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
  }, []);

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
  }, []);

  // ---------------------------------------------------------------------------
  // Project save / load
  // ---------------------------------------------------------------------------
  const handleExtractAudio = useCallback(async () => {
    if (!selectedClip) return;

    // Capture id and filename at the start so they remain stable across awaits.
    const clipId = selectedClip.id;
    const baseName = selectedClip.file.name.replace(/\.[^.]+$/, "");
    const wavFileName = `${baseName}.wav`;

    try {
      const wavBlob = await extractAudioToWav(selectedClip, setStatus);

      let remoteUrl: string | undefined;
      if (storageEndpoint) {
        try {
          setStatus("Uploading WAV to remote storage...");
          const client = new ContaboStorageManagerClient(
            storageEndpoint,
            storageAuthToken,
          );
          remoteUrl = await client.uploadMedia(wavFileName, wavBlob);
        } catch (uploadError) {
          setStatus(
            `Audio extracted but upload failed: ${(uploadError as Error).message}. Downloading locally.`,
          );
        }
      }

      // Update clip state after all async operations complete.
      if (remoteUrl) {
        setClips((prev) =>
          prev.map((c) =>
            c.id === clipId ? { ...c, remoteAudioUrl: remoteUrl } : c,
          ),
        );
      }

      // Always trigger a local download of the WAV.
      const url = URL.createObjectURL(wavBlob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = wavFileName;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }

      if (remoteUrl) {
        setStatus(
          `Audio extracted and uploaded as "${wavFileName}". Remote URL stored in clip.`,
        );
      } else if (!storageEndpoint) {
        setStatus(`Audio extracted and downloaded as "${wavFileName}".`);
      } else {
        setStatus(`Audio extracted as "${wavFileName}".`);
      }
    } catch (error) {
      const err = error as Error;
      console.error("Audio extraction failed (full details):", err);
      const recentLogs = getLastFfmpegLogs(20).join("\n");
      if (recentLogs)
        console.error("Last FFmpeg logs for extract:\n" + recentLogs);
      setStatus(`Audio extraction failed: ${err.message}`);
    }
  }, [selectedClip, storageEndpoint, storageAuthToken]);

  // ---------------------------------------------------------------------------
  // Inspector
  // ---------------------------------------------------------------------------

  const handleInspectorChange = useCallback(
    (values: ClipValues) => {
      if (selectedClipId) {
        pushHistoryDebounced(`inspector:${selectedClipId}`);
      }
      setClips((prev) =>
        prev.map((clip) => {
          if (clip.id !== selectedClipId) return clip;
          const updated: Clip = {
            ...clip,
            title: values.title.trim() || clip.file.name,
            trimStart: Number(values.trimStart || 0),
            trimEnd: values.trimEnd === "" ? NaN : Number(values.trimEnd),
            videoFadeIn: Number(values.videoFadeIn || 0),
            videoFadeOut: Number(values.videoFadeOut || 0),
            audioFadeIn: Number(values.audioFadeIn || 0),
            audioFadeOut: Number(values.audioFadeOut || 0),
            layerIndex: Math.max(0, Math.round(Number(values.layerIndex || 0))),
            x: Number(values.x || 0),
            y: Number(values.y || 0),
            width: Math.max(0, Number(values.width || 0)),
            height: Math.max(0, Number(values.height || 0)),
            opacity: Math.min(1, Math.max(0, Number(values.opacity ?? 1))),
            volume: clampClipVolume(Number(values.volume ?? 1)),
          };
          sanitizeClipAdjustments(updated);
          return updated;
        }),
      );
    },
    [selectedClipId, pushHistoryDebounced],
  );

  const handleClipKeyframesChange = useCallback(
    (keyframes: ClipKeyframes | undefined) => {
      if (!selectedClipId) return;
      pushHistoryDebounced(`keyframes:${selectedClipId}`);
      setClips((prev) =>
        prev.map((clip) =>
          clip.id === selectedClipId ? { ...clip, keyframes } : clip,
        ),
      );
    },
    [selectedClipId, pushHistoryDebounced],
  );

  const handleApplyKenBurns = useCallback(() => {
    if (!selectedClipId) return;
    pushHistory();
    setClips((prev) =>
      prev.map((clip) => {
        if (clip.id !== selectedClipId) return clip;
        return {
          ...clip,
          keyframes: createKenBurnsKeyframes(getClipDuration(clip)),
        };
      }),
    );
    setStatus("Ken Burns keyframes applied.");
  }, [selectedClipId, pushHistory, setStatus]);

  const handleRife = useCallback(
    async (mode: "interpolation" | "boomerang", multiplier: 2 | 4) => {
      if (!selectedClip || selectedClip.kind !== "video") return;
      if (rifeProcessingClipId) return; // Already processing

      // Capture the clip's current state (including originalFps if already set)
      // before any async work so we have a stable snapshot.
      const clipSnapshot = selectedClip;

      pushHistory();
      setRifeProcessingClipId(clipSnapshot.id);
      setStatus("Preparing trimmed clip for RIFE…");

      try {
        // Step 1: Export the trimmed segment via FFmpeg (lossless copy).
        // RIFE must operate on the trimmed portion only — running it on the
        // merged video would cause morphing artifacts across scene cuts.
        const trimmedBlob = await extractTrimmedVideoClip(
          clipSnapshot,
          setStatus,
        );

        // Step 2: Dynamically import to keep initial bundle lean
        const { processClipWithRIFE } = await import("./utils/huggingface");

        setStatus("Sending trimmed clip to RIFE (HuggingFace)…");
        const { blob } = await processClipWithRIFE(
          trimmedBlob,
          multiplier,
          mode,
          (event) => {
            setStatus(event.message ?? `RIFE: ${event.stage}…`);
          },
        );
        const blobWithAudio = await muxProcessedVideoWithSourceAudio(
          blob,
          clipSnapshot,
          setStatus,
        );

        const modeLabel = mode === "boomerang" ? "boomerang" : `${multiplier}x`;
        const processedFile = new File(
          [blobWithAudio],
          `rife_${modeLabel}_${clipSnapshot.file.name}`,
          { type: blobWithAudio.type },
        );
        const processedUrl = URL.createObjectURL(processedFile);
        const { duration } = await getMediaInfo(processedFile);

        setClips((prev) =>
          prev.map((c) => {
            if (c.id !== clipSnapshot.id) return c;
            // Revoke old object URL to free memory
            URL.revokeObjectURL(c.objectUrl);
            return {
              ...c,
              file: processedFile,
              objectUrl: processedUrl,
              duration,
              // The processed file is already the trimmed segment — reset trim to full.
              trimStart: 0,
              trimEnd: NaN,
              rifeProcessed: true,
              rifeMultiplier: multiplier,
              rifeMode: mode,
              // Preserve originalFps if it was already set (e.g. from a previous run)
              originalFps: c.originalFps,
            };
          }),
        );

        const modeDisplay =
          mode === "boomerang" ? "Boomerang" : `${multiplier}×`;
        setStatus(`✨ RIFE ${modeDisplay} applied to "${clipSnapshot.title}".`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`RIFE failed: ${message}`);
        console.error("RIFE processing error:", err);
      } finally {
        setRifeProcessingClipId(null);
      }
    },
    [selectedClip, rifeProcessingClipId, pushHistory],
  );

  // ---------------------------------------------------------------------------
  // Timeline reorder
  // ---------------------------------------------------------------------------

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    pushHistory();
    setClips((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index - 1, index));
  }, [pushHistory]);

  const handleMoveDown = useCallback((index: number) => {
    pushHistory();
    setClips((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index, index + 1));
  }, [pushHistory]);

  /**
   * Drag-and-drop reorder: move clip at `fromIndex` to be inserted before
   * position `insertBefore` in the original array (0 = before first clip,
   * clips.length = after last clip).  Transitions stay positional (slots).
   */
  const handleReorder = useCallback(
    (fromIndex: number, insertBefore: number) => {
      // No-op when the clip would remain in its current position:
      // insertBefore === fromIndex means "insert before itself",
      // insertBefore === fromIndex + 1 means "insert after itself" — both are identity moves.
      if (insertBefore === fromIndex || insertBefore === fromIndex + 1) return;
      pushHistory();
      setClips((prev) => {
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        const target =
          insertBefore > fromIndex ? insertBefore - 1 : insertBefore;
        next.splice(target, 0, moved);
        return next;
      });
      // Transitions are positional (slot-based) so no index remapping is needed.
    },
    [pushHistory],
  );

  // ---------------------------------------------------------------------------
  // Clip deletion
  // ---------------------------------------------------------------------------

  const handleDeleteClip = useCallback(
    (clipId: string) => {
      // Find the clip
      const clipIndex = clips.findIndex((c) => c.id === clipId);
      if (clipIndex < 0) return;
      const clipToDelete = clips[clipIndex];

      // Confirm deletion
      const clipTitle = clipToDelete.title || clipToDelete.file.name;
      if (!window.confirm(`Delete clip "${clipTitle}"?`)) {
        return;
      }

      pushHistory();

      // Get the timeline index before removing the clip (for transition reindexing)
      const timelineClipsBeforeDeletion = getTimelineClips(clips, clipGroups);
      const timelineIndex = timelineClipsBeforeDeletion.findIndex(
        (c) => c.id === clipId,
      );

      // Remove the clip from the clips array
      setClips((prev) => prev.filter((c) => c.id !== clipId));

      // Handle A/B group cleanup
      if (clipToDelete.groupId) {
        setClipGroups((prev) =>
          prev
            .map((group) => {
              if (group.id !== clipToDelete.groupId) return group;
              // Set the variant to null
              const updated =
                clipToDelete.groupVariant === "A"
                  ? { ...group, variants: { ...group.variants, A: null } }
                  : { ...group, variants: { ...group.variants, B: null } };
              return updated;
            })
            // Remove groups where both variants are now null
            .filter((g) => g.variants.A !== null || g.variants.B !== null),
        );
      }

      // Clear selection if the deleted clip was selected
      if (selectedClipId === clipId) {
        setSelectedClipId(null);
      }

      // Reindex transitions if the clip was on the timeline
      if (timelineIndex >= 0) {
        setTransitions((prev) => reindexTransitions(prev, timelineIndex));
      }

      setStatus(`Deleted "${clipTitle}".`);
    },
    [clips, clipGroups, selectedClipId, pushHistory],
  );

  // ---------------------------------------------------------------------------
  // Transition management
  // ---------------------------------------------------------------------------

  const [morphProcessingIndex, setMorphProcessingIndex] = useState<number | null>(
    null,
  );

  const handleTransitionUpdate = useCallback(
    (updated: ClipTransition) => {
      pushHistoryDebounced(`transition:${updated.afterClipIndex}`);
      let previous: ClipTransition | undefined;
      setTransitions((prev) => {
        previous = prev.find(
          (t) => t.afterClipIndex === updated.afterClipIndex,
        );
        const exists = previous !== undefined;
        if (exists) {
          return prev.map((t) =>
            t.afterClipIndex === updated.afterClipIndex ? updated : t,
          );
        }
        return [...prev, updated];
      });

      if (
        isMorphTransition(updated) &&
        shouldRegenerateMorph(previous, updated) &&
        morphProcessingIndex === null
      ) {
        setMorphProcessingIndex(updated.afterClipIndex);
        const clipsForMorph = getTimelineClips(clips, clipGroups);
        void (async () => {
          const { requestMorphSegment } = await import("./utils/morphGeneration");
          await requestMorphSegment(
            updated,
            clipsForMorph,
            setStatus,
            (next) => {
              setTransitions((prev) =>
                prev.map((t) =>
                  t.afterClipIndex === next.afterClipIndex ? next : t,
                ),
              );
            },
          );
          setMorphProcessingIndex(null);
        })();
      }
    },
    [
      pushHistoryDebounced,
      morphProcessingIndex,
      clips,
      clipGroups,
      setStatus,
    ],
  );

  // ---------------------------------------------------------------------------
  // Text overlay management
  // ---------------------------------------------------------------------------

  const handleAddTextOverlay = useCallback((): string => {
    pushHistory();
    const newOverlay: TextOverlay = {
      id: createClipId(),
      text: "Add your text here",
      fontsize: 40,
      fontcolor: "#ffffff",
      x: 50,
      y: 650,
      scrolling: false,
      scrollSpeed: DEFAULT_SCROLL_SPEED,
      box: true,
      boxColor: "black@0.5",
    };
    setTextOverlays((prev) => [...prev, newOverlay]);
    return newOverlay.id;
  }, [pushHistory]);

  const handleUpdateTextOverlay = useCallback((overlay: TextOverlay) => {
    pushHistoryDebounced(`text-overlay:${overlay.id}`);
    setTextOverlays((prev) =>
      prev.map((o) => (o.id === overlay.id ? overlay : o)),
    );
  }, [pushHistoryDebounced]);

  const handleDeleteTextOverlay = useCallback((id: string) => {
    pushHistory();
    setTextOverlays((prev) => prev.filter((o) => o.id !== id));
  }, [pushHistory]);

  // Helper functions for keyboard shortcuts
  // Memoize timeline clips computation to avoid unnecessary recalculation during re-renders
  const timelineClips = useMemo(
    () => getTimelineClips(clips, clipGroups),
    [clips, clipGroups],
  );

  const selectedClipLocalTime = useMemo(() => {
    if (!selectedClipId) return 0;
    if (previewPlayheadTime === null) return 0;
    const resolved = resolveClipLocalTimeAtGlobal(
      clips,
      clipGroups,
      transitions,
      selectedClipId,
      previewPlayheadTime,
    );
    return resolved?.localTime ?? 0;
  }, [
    clips,
    clipGroups,
    transitions,
    selectedClipId,
    previewPlayheadTime,
  ]);

  const previewTotalDuration = useMemo(
    () => computeTotalDuration(timelineClips, transitions),
    [timelineClips, transitions],
  );

  const handleMoveSelectedLeft = useCallback(() => {
    const index = timelineClips.findIndex((c) => c.id === selectedClipId);
    if (index > 0) handleReorder(index, index - 1);
  }, [selectedClipId, timelineClips, handleReorder]);

  const handleMoveSelectedRight = useCallback(() => {
    const index = timelineClips.findIndex((c) => c.id === selectedClipId);
    if (index >= 0 && index < timelineClips.length - 1) {
      // Move one position to the right
      handleReorder(index, index + 2);
    }
  }, [selectedClipId, timelineClips, handleReorder]);

  const handleDeleteSelectedClip = useCallback(() => {
    if (selectedClipId) handleDeleteClip(selectedClipId);
  }, [selectedClipId, handleDeleteClip]);

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    undo();
    setStatus("Undid last edit.");
  }, [canUndo, undo, setStatus]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    redo();
    setStatus("Redid last edit.");
  }, [canRedo, redo, setStatus]);

  // Set up keyboard shortcuts with memoization to avoid unnecessary re-renders
  const shortcutsMap = useMemo(
    () => ({
      r: handleMerge,
      "ctrl+s": handleSaveProject,
      s: handleSplitClip,
      "ctrl+d": handleDuplicateClip,
      l: () => toolbarRef.current?.triggerLoadDialog(),
      delete: handleDeleteSelectedClip,
      backspace: handleDeleteSelectedClip,
      "ctrl+z": handleUndo,
      "ctrl+shift+z": handleRedo,
      "ctrl+arrowleft": handleMoveSelectedLeft,
      "ctrl+arrowright": handleMoveSelectedRight,
      "meta+arrowleft": handleMoveSelectedLeft,
      "meta+arrowright": handleMoveSelectedRight,
      "?": () => setShowKeyboardShortcuts(true),
    }),
    [
      handleMerge,
      handleSaveProject,
      handleSplitClip,
      handleDuplicateClip,
      handleDeleteSelectedClip,
      handleMoveSelectedLeft,
      handleMoveSelectedRight,
      handleUndo,
      handleRedo,
    ],
  );

  useKeyboardShortcuts(shortcutsMap, true);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>clip_stacker</h1>
        <p>Upload, trim, reorder, fade, and merge clips into one MP4.</p>
        {encoderPath && (
          <span className="encoder-used-badge">
            Last render:{" "}
            {encoderPath === "canvas"
              ? "🎨 Canvas (audio-reactive)"
              : encoderPath === "webcodecs"
                ? "⚡ GPU (WebCodecs)"
                : "🖥 FFmpeg"}
          </span>
        )}
      </header>

      <section className="panel">
        <Toolbar
          ref={toolbarRef}
          onAddClips={handleAddClips}
          onMerge={handleMerge}
          onGpuStitch={handleGpuStitch}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
          onShowKeyboardShortcuts={() => setShowKeyboardShortcuts(true)}
          onDebugResetFFmpeg={handleDebugResetFFmpeg}
          onRetryFfmpegLoad={handleRetryFfmpegLoad}
          ffmpegLoading={ffmpegLoading}
          ffmpegLoadFailed={ffmpegFailed}
          onCopyDebugInfo={handleCopyDebugInfo}
          status={status}
          forceFFmpeg={forceFFmpeg}
          onToggleForceFFmpeg={setForceFFmpeg}
          useCanvasRenderer={useCanvasRenderer}
          onToggleCanvasRenderer={handleToggleCanvasRenderer}
          audioReactive={audioReactive}
          onToggleAudioReactive={setAudioReactive}
          forceReencode={forceReencode}
          onToggleForceReencode={setForceReencode}
          progressStage={progressStage}
          progressValue={progressValue}
          progressIndeterminate={progressIndeterminate}
          isRendering={isRendering}
          renderPlan={renderPlan}
        />
        {renderFailureMessage && !isRendering && (
          <RenderFailurePanel
            message={renderFailureMessage}
            renderPlan={renderPlan}
            onCopyDebug={handleCopyDebugInfo}
            onRetry={() => {
              setRenderFailureMessage(null);
              void performRender();
            }}
            onDismiss={() => setRenderFailureMessage(null)}
          />
        )}
        <StorageRow
          endpoint={storageEndpoint}
          authToken={storageAuthToken}
          onAuthTokenChange={handleStorageAuthTokenChange}
          onSaveRemote={handleSaveRemote}
          onLoadRemote={handleLoadRemote}
          isRemoteSaving={isRemoteSaving}
          isRemoteLoading={isRemoteLoading}
          remoteLoadStage={remoteLoadStage}
          remoteLoadProgress={remoteLoadProgress}
          remoteLoadIndeterminate={remoteLoadIndeterminate}
          remoteUploadItems={remoteUploadItems}
          pendingRemoteUploadError={pendingRemoteUploadError}
          onResolveRemoteUploadError={resolveRemoteUploadError as any}
        />
        <MediaLibraryPanel
          endpoint={storageEndpoint}
          authToken={storageAuthToken}
          onAddClip={handleAddLibraryClip}
        />
      </section>

      <section className="layout-grid">
        <ClipLibrary
          clips={clips}
          selectedClipId={selectedClipId}
          clipGroups={clipGroups}
          onSelect={setSelectedClipId}
          onToggleVariant={handleToggleVariant}
          onDelete={handleDeleteClip}
        />
        <Preview
          clip={selectedClip}
          timelineClips={timelineClips}
          clipGroups={clipGroups}
          transitions={transitions}
          textOverlays={textOverlays}
          exportSettings={exportSettings}
          colorGrade={colorGrade}
          outputUrl={outputUrl}
          exportFilename={exportSettings.filename}
          playheadTime={previewPlayheadTime}
          onPlayheadChange={setPreviewPlayheadTime}
        />
        <Inspector
          clip={selectedClip}
          exportSettings={exportSettings}
          clipLocalTime={selectedClipLocalTime}
          colorGrade={colorGrade}
          onColorGradeChange={setColorGrade}
          onChange={handleInspectorChange}
          onKeyframesChange={handleClipKeyframesChange}
          onApplyKenBurns={handleApplyKenBurns}
          onExportSettingsChange={setExportSettings}
          onExtractAudio={handleExtractAudio}
          onRife={handleRife}
          rifeProcessing={rifeProcessingClipId !== null}
        />
      </section>

      <Timeline
        clips={timelineClips}
        selectedClipId={selectedClipId}
        transitions={transitions}
        onSelect={setSelectedClipId}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
        onReorder={handleReorder}
        onTransitionUpdate={handleTransitionUpdate}
        onDelete={handleDeleteClip}
        morphProcessingIndex={morphProcessingIndex}
      />

      <TextOverlayPanel
        overlays={textOverlays}
        previewGlobalTime={previewPlayheadTime ?? 0}
        totalDuration={previewTotalDuration}
        onAdd={handleAddTextOverlay}
        onUpdate={handleUpdateTextOverlay}
        onDelete={handleDeleteTextOverlay}
      />

      <KeyboardShortcutsModal
        isOpen={showKeyboardShortcuts}
        onClose={() => setShowKeyboardShortcuts(false)}
      />

      <MemoryWarningModal
        isOpen={showMemoryWarning}
        clips={clips}
        onConfirm={handleMemoryWarningConfirm}
        onCancel={handleMemoryWarningCancel}
      />

      {recoveryOffer && (
        <RecoveryModal
          isOpen
          savedAt={recoveryOffer.savedAt}
          clipCount={recoveryOffer.clipCount}
          textOverlayCount={recoveryOffer.textOverlayCount}
          embeddedClipCount={recoveryOffer.embeddedClipCount}
          referenceOnlyClipCount={recoveryOffer.referenceOnlyClipCount}
          unrecoverableLocalClipCount={recoveryOffer.unrecoverableLocalClipCount}
          isRecovering={isRecovering}
          onRecover={handleRecover}
          onDiscard={handleDiscardRecovery}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * After swapping two adjacent clips at indices i and j (j = i+1),
 * transitions are positional and stay at their slots — no remapping needed.
 * Users can adjust transition types after reordering via the TransitionEditor.
 */
function reindexAfterSwap(
  transitions: ClipTransition[],
  _i: number,
  _j: number,
): ClipTransition[] {
  return transitions;
}
