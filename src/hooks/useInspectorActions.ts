import { useCallback } from "react";
import type {
  Clip,
  ClipKeyframes,
  ClipAutomation,
  ExportSettings,
  OverlayBlendMode,
  VideoOutputFormat,
} from "../types";
import { sanitizeClipAdjustments, ContaboStorageManagerClient } from "../utils/project";
import { getClipDuration } from "../utils/clipTiming";
import { clampClipVolume } from "../utils/audioVolume";
import { clampClipLoopCount, clampClipPlaybackRate } from "../utils/playbackRate";
import { normalizeClipAutomation } from "../utils/clipAutomation";
import { normalizeClipAudioEffects, type ClipAudioEffects } from "../utils/audioEffects";
import { clipDisplayPixelsToNormalized } from "../utils/overlayCoords";
import { parseCanvasSize } from "../utils/pipPreset";
import { createKenBurnsKeyframes } from "../utils/animatedLayout";
import { getMediaInfo } from "../utils/media";
import type { ClipValues } from "../components/Inspector";
import { DEFAULT_CHROMA_KEY } from "../utils/overlayBlend";
import type { UseEditHistoryResult } from "./useEditHistory";
import { setClipStabilize } from "./useClipStabilization";

import { settingsStore } from "../store/settingsStore";
import { editorActions, editorStore } from "../store/editorStore";
import { isClipLocked, moveClipToVideoLayer } from "../utils/trackModel";
import { useStorageAuthToken, useStorageEndpoint } from "../store";
import { clamp01Finite } from "../utils/math";

// FFmpeg is only needed once a clip action runs; see useRenderActions.
const loadFfmpegService = () => import("../ffmpeg/ffmpegService");

type InspectorActionsDeps = Pick<
  UseEditHistoryResult,
  "selectedClipId" | "setClips" | "pushHistory" | "pushHistoryDebounced"
> & {
  clips: Clip[];
};

const OVERLAY_BLEND_MODES: OverlayBlendMode[] = [
  "opaque",
  "source-alpha",
  "premultiplied",
  "chroma",
  "luma",
];

/**
 * Overlay keying fields from the inspector form. `chromaKey` is only stored for
 * the key modes that use it, so an unkeyed overlay round-trips as before.
 */
function resolveOverlayKeying(
  values: ClipValues,
): Pick<Clip, "overlayBlend" | "chromaKey"> {
  const mode = OVERLAY_BLEND_MODES.find((m) => m === values.overlayBlend);
  if (!mode) return { overlayBlend: undefined, chromaKey: undefined };
  if (mode !== "chroma" && mode !== "luma") {
    return { overlayBlend: mode, chromaKey: undefined };
  }
  return {
    overlayBlend: mode,
    chromaKey: {
      color: values.chromaColor || DEFAULT_CHROMA_KEY.color,
      similarity: clamp01Finite(
        Number(values.chromaSimilarity),
        DEFAULT_CHROMA_KEY.similarity,
      ),
      blend: clamp01Finite(Number(values.chromaBlend), DEFAULT_CHROMA_KEY.blend),
    },
  };
}

export function useInspectorActions({
  clips,
  selectedClipId,
  setClips,
  pushHistory,
  pushHistoryDebounced,
}: InspectorActionsDeps) {
  const storageEndpoint = useStorageEndpoint();
  const storageAuthToken = useStorageAuthToken();
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  const handleExtractAudio = useCallback(async () => {
    if (!selectedClip) return;

    // Capture id and filename at the start so they remain stable across awaits.
    const clipId = selectedClip.id;
    const baseName = selectedClip.file.name.replace(/\.[^.]+$/, "");
    const wavFileName = `${baseName}.wav`;

    let ffmpeg: Awaited<ReturnType<typeof loadFfmpegService>> | null = null;
    try {
      const { setStatus } = settingsStore.getState();
      ffmpeg = await loadFfmpegService();
      const wavBlob = await ffmpeg.extractAudioToWav(selectedClip, setStatus);

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
      const recentLogs = ffmpeg?.getLastFfmpegLogs(20).join("\n");
      if (recentLogs)
        console.error("Last FFmpeg logs for extract:\n" + recentLogs);
      settingsStore.getState().setStatus(`Audio extraction failed: ${err.message}`);
    }
  }, [selectedClip, storageEndpoint, storageAuthToken, setClips]);

  const handleInspectorChange = useCallback(
    (values: ClipValues) => {
      if (selectedClipId) {
        pushHistoryDebounced(`inspector:${selectedClipId}`);
      }
      const layoutCanvas = parseCanvasSize(settingsStore.getState().exportSettings.outputResolution);
      // Stacking order is track order (#168 Phase B), so the layer field is a
      // shortcut for "move this clip to video lane N" — the derived
      // `layerIndex` then follows from where the clip actually sits.
      const nextLayerIndex = Math.max(0, Math.round(Number(values.layerIndex || 0)));
      // A locked lane keeps its clips' trim points and lane assignment; other
      // inspector fields (title, volume, colour) stay editable (#168 Phase A).
      const locked = selectedClipId
        ? isClipLocked(editorStore.getState().tracks, selectedClipId)
        : false;
      if (selectedClipId && !locked) {
        editorActions.setTracks((prev) =>
          moveClipToVideoLayer(prev, selectedClipId, nextLayerIndex, editorStore.getState().clips),
        );
      }
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
            trimStart: locked ? clip.trimStart : Number(values.trimStart || 0),
            trimEnd: locked
              ? clip.trimEnd
              : values.trimEnd === "" ? NaN : Number(values.trimEnd),
            videoFadeIn: Number(values.videoFadeIn || 0),
            videoFadeOut: Number(values.videoFadeOut || 0),
            audioFadeIn: Number(values.audioFadeIn || 0),
            audioFadeOut: Number(values.audioFadeOut || 0),
            layerIndex: locked ? (clip.layerIndex ?? 0) : nextLayerIndex,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            opacity: Math.min(1, Math.max(0, Number(values.opacity ?? 1))),
            ...resolveOverlayKeying(values),
            volume: clampClipVolume(Number(values.volume ?? 1)),
            playbackRate: clampClipPlaybackRate(
              Number(values.playbackRate ?? 1),
            ),
            loopCount: clampClipLoopCount(Number(values.loopCount ?? 1)),
          };
          sanitizeClipAdjustments(updated);
          return updated;
        }),
      );
    },
    [selectedClipId, pushHistoryDebounced, setClips],
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

  const handleClipAudioEffectsChange = useCallback(
    (clipId: string, effects: ClipAudioEffects | undefined) => {
      pushHistoryDebounced(`audioEffects:${clipId}`);
      const next = normalizeClipAudioEffects(effects);
      setClips((prev) =>
        prev.map((clip) => {
          if (clip.id !== clipId) return clip;
          if (!next) {
            const { audioEffects: _removed, ...rest } = clip;
            return rest;
          }
          return { ...clip, audioEffects: next };
        }),
      );
    },
    [pushHistoryDebounced, setClips],
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
    settingsStore.getState().setStatus("Ken Burns keyframes applied.");
  }, [selectedClipId, pushHistory, setClips]);

  const handleStabilizeChange = useCallback(
    (enabled: boolean) => {
      if (!selectedClipId) return;
      pushHistory();
      setClips((prev) =>
        prev.map((clip) =>
          clip.id === selectedClipId ? setClipStabilize(clip, enabled) : clip,
        ),
      );
      settingsStore
        .getState()
        .setStatus(
          enabled
            ? "Stabilization on — analysing camera motion in the background."
            : "Stabilization off.",
        );
    },
    [selectedClipId, pushHistory, setClips],
  );

  const handleReverseChange = useCallback(
    (enabled: boolean) => {
      if (!selectedClipId) return;
      pushHistory();
      setClips((prev) =>
        prev.map((clip) => {
          if (clip.id !== selectedClipId) return clip;
          if (enabled) return { ...clip, reversed: true };
          const next = { ...clip };
          delete next.reversed;
          return next;
        }),
      );
      settingsStore
        .getState()
        .setStatus(enabled ? "Clip plays backward." : "Clip plays forward.");
    },
    [selectedClipId, pushHistory, setClips],
  );

  const handleRife = useCallback(
    async (
      mode: "interpolation" | "boomerang",
      multiplier: 2 | 4,
      outputFormat: VideoOutputFormat = "mp4",
    ) => {
      if (!selectedClip || selectedClip.kind !== "video") return;
      const { rifeProcessingClipId, setRifeProcessingClipId, setStatus } = settingsStore.getState();
      if (rifeProcessingClipId) return; // Already processing

      // Capture the clip's current state (including originalFps if already set)
      // before any async work so we have a stable snapshot.
      const clipSnapshot = selectedClip;

      pushHistory();
      setRifeProcessingClipId(clipSnapshot.id);
      setStatus("Preparing trimmed clip for RIFE…");

      try {
        const { extractTrimmedVideoClip, muxProcessedVideoWithSourceAudio } =
          await loadFfmpegService();
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
          outputFormat,
        );
        const blobWithAudio = await muxProcessedVideoWithSourceAudio(
          blob,
          clipSnapshot,
          setStatus,
          outputFormat,
        );

        const modeLabel = mode === "boomerang" ? "boomerang" : `${multiplier}x`;
        const baseName = clipSnapshot.file.name.replace(/\.[^.]+$/, "");
        const extension = outputFormat === "prores" ? "mov" : "mp4";
        const processedFile = new File(
          [blobWithAudio],
          `rife_${modeLabel}_${baseName}.${extension}`,
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
              // New source bytes: the old proxy shows the wrong picture.
              proxy: undefined,
            };
          }),
        );

        const modeDisplay =
          mode === "boomerang" ? "Boomerang" : `${multiplier}×`;
        setStatus(`✨ RIFE ${modeDisplay} applied to "${clipSnapshot.title}".`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        settingsStore.getState().setStatus(`RIFE failed: ${message}`);
        console.error("RIFE processing error:", err);
      } finally {
        settingsStore.getState().setRifeProcessingClipId(null);
      }
    },
    [
      selectedClip,
      pushHistory,
      setClips,
    ],
  );

  return {
    selectedClip,
    handleExtractAudio,
    handleInspectorChange,
    handleClipKeyframesChange,
    handleClipAutomationChange,
    handleClipAudioEffectsChange,
    handleApplyKenBurns,
    handleRife,
    handleStabilizeChange,
    handleReverseChange,
  };
}
