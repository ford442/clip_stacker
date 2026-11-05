/**
 * Render-job actions that only need the stores: remote concat, Copy Debug and
 * the FFmpeg debug reset / retry. `useRenderActions` binds them to the
 * render-failure state it owns; nothing here holds React state.
 */

import type { Clip, ClipGroup, ClipTransition, TextOverlay } from "../types";
import { editorStore } from "../store/editorStore";
import { settingsStore } from "../store/settingsStore";
import { renderJobStore } from "../store/renderJobStore";
import { resolveTargetResolution } from "../export/resolution";
import { remoteConcatBlockers } from "../export/renderEligibility";
import { normalizeError } from "../ffmpeg/ffmpegCommon";
import { getMemoryStatus } from "../utils/memory";

// The export pipeline (encoders, FFmpeg, mp4box demux, the GPU export
// compositor) is most of the app's code and none of it is needed to edit, so
// it loads on the first render / FFmpeg action instead of with the editor.
// Repeat calls resolve from the module cache.
export type FfmpegServiceModule = typeof import("../ffmpeg/ffmpegService");
export const loadFfmpegService = (): Promise<FfmpegServiceModule> =>
  import("../ffmpeg/ffmpegService");

/**
 * Copy Debug writes to the clipboard, which some browsers only allow while
 * the click's user activation is still live — so the report module is kept
 * once loaded (and warmed after a failed render) to generate synchronously.
 */
let debugReportModule: typeof import("./debugReport") | null = null;
export async function loadDebugReport() {
  debugReportModule ??= await import("./debugReport");
  return debugReportModule;
}

/** Called with the failure message and error, or (null, null) when a job starts. */
export type RenderFailureSink = (message: string | null, error: unknown) => void;

export interface RemoteConcatInputs {
  clips: Clip[];
  /** Clips as the tracks lay them out (`selectTimelineClips`). */
  effectiveClips: Clip[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  onFailure: RenderFailureSink;
}

/** "Remote concat": trim each clip, stitch on the HF Space, remux for NLEs. */
export async function runRemoteConcat({
  clips,
  effectiveClips,
  transitions,
  textOverlays,
  onFailure,
}: RemoteConcatInputs): Promise<void> {
  const timelineClips = effectiveClips.filter((clip) => clip.kind === "video");
  if (clips.filter((c) => c.kind === "video").length === 0) {
    renderJobStore.getState().setStatus("Add at least one video clip before remote concat.");
    return;
  }

  const { finishing } = settingsStore.getState();
  const { captions, masterAudio } = editorStore.getState();
  const { timelineNeedsAudioPremix } = await import("../export/webcodecsAudio");
  const skippedFeatures = remoteConcatBlockers(effectiveClips, {
    transitions,
    textOverlays,
    finishing,
    captionCount: captions.length,
    hasMasterAudio: masterAudio != null,
    needsAudioPremix: timelineNeedsAudioPremix(effectiveClips),
  });
  if (skippedFeatures.length > 0) {
    renderJobStore.getState().setStatus(
      `Remote concat only stitches plain clips end to end; this timeline has ${skippedFeatures.join(", ")} — use Render instead.`,
    );
    return;
  }

  let ffmpeg: FfmpegServiceModule | null = null;
  try {
    const {
      exportSettings,
    } = settingsStore.getState();
    const {
      outputUrl,
      setStatus,
      setOutputUrl,
      setEncoderPath,
      setRenderPlan,
      setIsRendering,
      setProgressIndeterminate,
      setProgressValue,
      setProgressStage,
    } = renderJobStore.getState();

    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setOutputUrl(null);
    setEncoderPath("");
    setRenderPlan(null);
    onFailure(null, null);
    setIsRendering(true);
    setProgressIndeterminate(true);
    setProgressValue(null);
    setProgressStage("Remote concat");

    ffmpeg = await loadFfmpegService();
    const { extractTrimmedVideoClip, remuxStitchedMp4ForNle } = ffmpeg;

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
    const { stitchClipsOnGpu } = await import("../remote/huggingface");
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
    const { setStatus } = renderJobStore.getState();
    const errMsg = normalizeError(error);
    console.error("Remote concat error:", error);
    const recentLogs = ffmpeg?.getLastFfmpegLogs(30).join("\n");
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
    onFailure(message, error);
  } finally {
    const { setIsRendering, setProgressIndeterminate } = renderJobStore.getState();
    setIsRendering(false);
    setProgressIndeterminate(false);
    ffmpeg?.aggressiveCleanupFFmpegVFS().catch(() => {});
  }}

export interface DebugInfoInputs {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  error: unknown;
}

/** Copy rich diagnostics (status + render plan + last FFmpeg logs + browser info) to clipboard. */
export async function copyDebugInfo(inputs: DebugInfoInputs): Promise<void> {
  const { exportSettings, colorManagement } = settingsStore.getState();
  const { status, renderPlan, encoderPath, setStatus } = renderJobStore.getState();
  let report: typeof import("../actions/debugReport");
  try {
    report = debugReportModule ?? (await loadDebugReport());
  } catch (err) {
    setStatus(`Could not build the debug report: ${normalizeError(err)}`);
    return;
  }
  const text = report.generateDebugReport({
    status,
    renderPlan,
    encoderPath,
    clips: inputs.clips,
    clipGroups: inputs.clipGroups,
    transitions: inputs.transitions,
    textOverlays: inputs.textOverlays,
    exportSettings,
    colorManagement,
    error: inputs.error ?? undefined,
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
  }}

export async function resetFfmpegForDebug(): Promise<void> {
    const { setStatus } = renderJobStore.getState();
    setStatus("Resetting FFmpeg instance (debug action)...");
    try {
      const { resetFFmpegInstance } = await loadFfmpegService();
      await resetFFmpegInstance();
      const memoryStatus = getMemoryStatus();
      const message = memoryStatus
        ? `FFmpeg instance reset. Memory: ${memoryStatus}`
        : "FFmpeg instance reset.";
      setStatus(message);
    } catch (err) {
      setStatus(`Error resetting FFmpeg: ${(err as Error).message}`);
    }}

export async function retryFfmpegLoad(): Promise<void> {
    const { setStatus, setFfmpegFailed, setFfmpegLoading } = renderJobStore.getState();
    setStatus("Resetting FFmpeg and retrying load...");
    setFfmpegFailed(false);
    setFfmpegLoading(true);
    try {
      const { resetFFmpegInstance, ensureFfmpeg } = await loadFfmpegService();
      await resetFFmpegInstance();
      await ensureFfmpeg(
        (msg) => renderJobStore.getState().setStatus(msg),
        (update) => {
          renderJobStore.getState().setProgressStage(update.stage);
          renderJobStore.getState().setProgressIndeterminate(update.indeterminate === true);
        },
      );
      setStatus("FFmpeg loaded successfully. Click Render to start.");
    } catch (err) {
      const message = (err as Error).message;
      setStatus(message);
      setFfmpegFailed(true);
    } finally {
      setFfmpegLoading(false);
    }}
