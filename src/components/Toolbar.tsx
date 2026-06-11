import { useEffect, useRef, useState, forwardRef } from "react";
import type { BrowserCapabilities } from "../utils/feature-detector";
import type { RenderPlan } from "../types";
import { detectCapabilities } from "../utils/feature-detector";
import { ProgressBar } from "./ProgressBar";

interface Props {
  onAddClips: (files: File[]) => void;
  onMerge: () => void;
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  onTriggerLoadDialog?: () => void;
  onShowKeyboardShortcuts?: () => void;
  onDebugResetFFmpeg?: () => void;
  /** Called when the user clicks "Retry FFmpeg load" after a failed/stuck load. */
  onRetryFfmpegLoad?: () => void;
  /** When true, FFmpeg is currently loading (shows spinner feedback in status). */
  ffmpegLoading?: boolean;
  /** When true, last FFmpeg load attempt failed — show the retry button prominently. */
  ffmpegLoadFailed?: boolean;
  status: string;
  forceFFmpeg: boolean;
  onToggleForceFFmpeg: (v: boolean) => void;
  /** Enable the canvas renderer path (audio-reactive compositing). */
  useCanvasRenderer: boolean;
  onToggleCanvasRenderer: (v: boolean) => void;
  /** Enable audio-reactive visual effects in the canvas renderer. */
  audioReactive: boolean;
  onToggleAudioReactive: (v: boolean) => void;
  /** Force re-encoding even when lossless concat would be available. */
  forceReencode: boolean;
  onToggleForceReencode: (v: boolean) => void;
  progressStage: string;
  progressValue: number | null;
  progressIndeterminate: boolean;
  isRendering: boolean;
  renderPlan?: RenderPlan | null;
  /** Optional: copy last FFmpeg logs + context for support / bug reports. */
  onCopyDebugInfo?: () => void;
}

export const Toolbar = forwardRef<{ triggerLoadDialog: () => void }, Props>(
  function Toolbar(
    {
      onAddClips,
      onMerge,
      onSaveProject,
      onLoadProject,
      onTriggerLoadDialog,
      onShowKeyboardShortcuts,
      onDebugResetFFmpeg,
      onRetryFfmpegLoad,
      ffmpegLoading,
      ffmpegLoadFailed,
      status,
      forceFFmpeg,
      onToggleForceFFmpeg,
      useCanvasRenderer,
      onToggleCanvasRenderer,
      audioReactive,
      onToggleAudioReactive,
      forceReencode,
      onToggleForceReencode,
      progressStage,
      progressValue,
      progressIndeterminate,
      isRendering,
      renderPlan,
      onCopyDebugInfo,
    },
    ref,
  ) {
    const clipInputRef = useRef<HTMLInputElement>(null);
    const projectFileInputRef = useRef<HTMLInputElement>(null);
    const [caps, setCaps] = useState<BrowserCapabilities | null>(null);

    // Expose triggerLoadDialog via imperative ref
    useEffect(() => {
      if (ref) {
        if (typeof ref === "function") {
          ref({
            triggerLoadDialog: () => projectFileInputRef.current?.click(),
          });
        } else {
          ref.current = {
            triggerLoadDialog: () => projectFileInputRef.current?.click(),
          };
        }
      }
    }, [ref]);

    useEffect(() => {
      detectCapabilities()
        .then(setCaps)
        .catch(() => {});
    }, []);

    const handleClipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onAddClips(files);
      e.target.value = "";
    };

    const handleProjectFileChange = (
      e: React.ChangeEvent<HTMLInputElement>,
    ) => {
      const file = e.target.files?.[0];
      if (file) onLoadProject(file);
      e.target.value = "";
    };

    const mediaRecorderAvailable =
      caps?.mediaRecorderMp4 ?? typeof MediaRecorder !== "undefined";

    const gpuLabel = useCanvasRenderer ? "🎨 Canvas" : "🖥 CPU";

    const gpuTitle = caps
      ? `Audio-safe exports use FFmpeg by default. WebCodecs: ${caps.webcodecs ? "yes" : "no"} · Hardware H.264: ${caps.hardwareH264 ? "yes" : "no"} · WebGPU: ${caps.webgpu ? "yes" : "no"} · MediaRecorder: ${caps.mediaRecorderMp4 ? "yes" : "no"}`
      : "Detecting capabilities...";

    return (
      <>
        <div className="toolbar">
          <label className="button-like">
            Add clips (MP4 / WAV / MP3)
            <input
              ref={clipInputRef}
              type="file"
              accept="video/mp4,audio/wav,audio/x-wav,audio/mpeg,.mp4,.wav,.mp3"
              multiple
              onChange={handleClipChange}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={onMerge}
            aria-keyshortcuts="r"
            title="Render merge (R)"
          >
            ▶ Render
          </button>
          <button
            type="button"
            onClick={onSaveProject}
            aria-keyshortcuts="s"
            title="Save local project (S)"
          >
            Save project
          </button>
          <button
            type="button"
            onClick={() => projectFileInputRef.current?.click()}
            aria-keyshortcuts="l"
            title="Load local project (L)"
          >
            Load project
          </button>
          <input
            ref={projectFileInputRef}
            type="file"
            accept="application/json"
            hidden
            onChange={handleProjectFileChange}
          />
          <button
            type="button"
            onClick={onShowKeyboardShortcuts}
            aria-keyshortcuts="?"
            title="Show keyboard shortcuts (?)"
          >
            ⌨️ Help
          </button>

          {/* Reset FFmpeg — frees VFS memory and resets the engine for recovery */}
          {onDebugResetFFmpeg && (
            <button
              type="button"
              onClick={onDebugResetFFmpeg}
              title="Reset FFmpeg engine and free VFS memory (use if renders hang or after repeated failures)"
            >
              🔄 Reset FFmpeg
            </button>
          )}

          {/* Retry FFmpeg load — shown prominently when the last load failed, or during loading */}
          {onRetryFfmpegLoad && (ffmpegLoadFailed || ffmpegLoading) && (
            <button
              type="button"
              onClick={onRetryFfmpegLoad}
              disabled={ffmpegLoading}
              title={
                ffmpegLoadFailed
                  ? "FFmpeg failed to load — click to retry"
                  : "FFmpeg is loading…"
              }
              style={{
                background: ffmpegLoadFailed
                  ? "var(--danger, #c0392b)"
                  : undefined,
                color: ffmpegLoadFailed ? "#fff" : undefined,
                fontWeight: "bold",
              }}
            >
              {ffmpegLoading ? "⏳ Loading FFmpeg…" : "⚠️ Retry FFmpeg load"}
            </button>
          )}
          {onCopyDebugInfo && (
            <button
              type="button"
              onClick={onCopyDebugInfo}
              title="Copy last FFmpeg logs + render plan + browser context (great for bug reports)"
            >
              📋 Copy Debug
            </button>
          )}

          {/* Encoder / renderer controls */}
          <div className="encoder-badge" title={gpuTitle}>
            <span className="encoder-indicator">{gpuLabel}</span>

            {/* Canvas renderer toggle (requires MediaRecorder) */}
            {mediaRecorderAvailable && (
              <label
                className="encoder-toggle-label"
                title="Use canvas compositor with audio-reactive effects"
              >
                <input
                  type="checkbox"
                  checked={useCanvasRenderer}
                  onChange={(e) => onToggleCanvasRenderer(e.target.checked)}
                />
                Canvas
              </label>
            )}

            {/* Audio-reactive sub-toggle (only shown when canvas is active) */}
            {useCanvasRenderer && (
              <label
                className="encoder-toggle-label"
                title="Enable audio-reactive visual effects (bass-driven glow)"
              >
                <input
                  type="checkbox"
                  checked={audioReactive}
                  onChange={(e) => onToggleAudioReactive(e.target.checked)}
                />
                Audio FX
              </label>
            )}

            {/* Force re-encode toggle */}
            <label
              className="encoder-toggle-label"
              title="Force re-encoding even when lossless concat is available"
            >
              <input
                type="checkbox"
                checked={forceReencode}
                onChange={(e) => onToggleForceReencode(e.target.checked)}
              />
              Force re-encode
            </label>
          </div>
        </div>
        {isRendering && (
          <ProgressBar
            stage={progressStage}
            progress={progressValue}
            indeterminate={progressIndeterminate}
          />
        )}
        {renderPlan && !isRendering && (
          <p className="render-plan-info">
            Render plan: {renderPlan.description} ({renderPlan.reason})
          </p>
        )}
        <p
          aria-live="polite"
          style={{
            minHeight: "1.4rem",
            color: "var(--muted)",
            margin: "0.5rem 0 0",
          }}
        >
          {status}
        </p>
      </>
    );
  },
);
