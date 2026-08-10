import { useCallback } from "react";
import type { Clip, ClipKeyframes, ClipAutomation, ExportSettings } from "../types";
import { sanitizeClipAdjustments, getClipDuration, ContaboStorageManagerClient } from "../utils/project";
import { clampClipVolume } from "../utils/audioVolume";
import { clampClipPlaybackRate } from "../utils/playbackRate";
import { normalizeClipAutomation } from "../utils/clipAutomation";
import { clipDisplayPixelsToNormalized } from "../utils/overlayCoords";
import { parseCanvasSize } from "../utils/pipPreset";
import { createKenBurnsKeyframes } from "../utils/animatedLayout";
import { getMediaInfo } from "../utils/media";
import {
  extractAudioToWav,
  extractTrimmedVideoClip,
  muxProcessedVideoWithSourceAudio,
  getLastFfmpegLogs,
} from "../ffmpeg/ffmpegService";
import type { ClipValues } from "../components/Inspector";
import type { UseEditHistoryResult } from "./useEditHistory";

type InspectorActionsDeps = Pick<
  UseEditHistoryResult,
  "selectedClipId" | "setClips" | "pushHistory" | "pushHistoryDebounced"
> & {
  clips: Clip[];
  exportSettings: ExportSettings;
  rifeProcessingClipId: string | null;
  setRifeProcessingClipId: (id: string | null) => void;
  setStatus: (status: string) => void;
  storageEndpoint: string;
  storageAuthToken: string;
};

export function useInspectorActions({
  clips,
  selectedClipId,
  setClips,
  pushHistory,
  pushHistoryDebounced,
  exportSettings,
  rifeProcessingClipId,
  setRifeProcessingClipId,
  setStatus,
  storageEndpoint,
  storageAuthToken,
}: InspectorActionsDeps) {
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

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
  }, [selectedClip, storageEndpoint, storageAuthToken, setClips, setStatus]);

  const handleInspectorChange = useCallback(
    (values: ClipValues) => {
      if (selectedClipId) {
        pushHistoryDebounced(`inspector:${selectedClipId}`);
      }
      const layoutCanvas = parseCanvasSize(exportSettings.outputResolution);
      setClips((prev) =>
        prev.map((clip) => {
          if (clip.id !== selectedClipId) return clip;
          const layout = clipDisplayPixelsToNormalized(
            {
              x: Number(values.x || 0),
              y: Number(values.y || 0),
              width: Math.max(0, Number(values.width || 0)),
              height: Math.max(0, Number(values.height || 0)),
            },
            layoutCanvas,
          );
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
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            opacity: Math.min(1, Math.max(0, Number(values.opacity ?? 1))),
            volume: clampClipVolume(Number(values.volume ?? 1)),
            playbackRate: clampClipPlaybackRate(
              Number(values.playbackRate ?? 1),
            ),
          };
          sanitizeClipAdjustments(updated);
          return updated;
        }),
      );
    },
    [selectedClipId, pushHistoryDebounced, exportSettings.outputResolution, setClips],
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
    [selectedClipId, pushHistoryDebounced, setClips],
  );

  const handleClipAutomationChange = useCallback(
    (automation: ClipAutomation | undefined) => {
      if (!selectedClipId) return;
      pushHistoryDebounced(`automation:${selectedClipId}`);
      const next = normalizeClipAutomation(automation);
      setClips((prev) =>
        prev.map((clip) => {
          if (clip.id !== selectedClipId) return clip;
          if (!next) {
            const { automation: _removed, ...rest } = clip;
            return rest;
          }
          return { ...clip, automation: next };
        }),
      );
    },
    [selectedClipId, pushHistoryDebounced, setClips],
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
  }, [selectedClipId, pushHistory, setStatus, setClips]);

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
        const { processClipWithRIFE } = await import("../utils/huggingface");

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
        const baseName = clipSnapshot.file.name.replace(/\.[^.]+$/, "");
        const processedFile = new File(
          [blobWithAudio],
          `rife_${modeLabel}_${baseName}.mp4`,
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
    [
      selectedClip,
      rifeProcessingClipId,
      pushHistory,
      setRifeProcessingClipId,
      setStatus,
      setClips,
    ],
  );

  return {
    selectedClip,
    handleExtractAudio,
    handleInspectorChange,
    handleClipKeyframesChange,
    handleClipAutomationChange,
    handleApplyKenBurns,
    handleRife,
  };
}
