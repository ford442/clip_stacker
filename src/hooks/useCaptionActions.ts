import { useCallback } from "react";
import type { CaptionEntry, TextOverlayStyle } from "../types";
import { editorStore } from "../store/editorStore";
import { settingsStore } from "../store/settingsStore";
import { uiActions } from "../store/uiStore";
import { captionsToSrtBlob } from "../ffmpeg/captions";
import {
  createCaptionId,
  MIN_CAPTION_DURATION_SEC,
  parseSubtitles,
} from "../utils/subtitles";
import type { UseEditHistoryResult } from "./useEditHistory";

/** Length of a cue added with the `C` shortcut / "Add caption" button. */
export const NEW_CAPTION_DURATION_SEC = 2;

type CaptionActionsDeps = Pick<
  UseEditHistoryResult,
  "pushHistory" | "pushHistoryDebounced"
>;

/** Trigger a browser download for `blob` under `fileName`. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Caption CRUD, `.srt`/`.ass` import and `.srt` export.
 *
 * Cue edits go through `pushHistoryDebounced` keyed on the cue id, so typing
 * in a caption's text field collapses into one undo step the same way the
 * inspector's sliders and the text-overlay panel do.
 */
export function useCaptionActions({
  pushHistory,
  pushHistoryDebounced,
}: CaptionActionsDeps) {
  const setCaptions = editorStore.getState().setCaptions;

  /**
   * Add a cue starting at `startSec` (the preview playhead when invoked from
   * the `C` shortcut) and select it for editing.
   */
  const handleAddCaption = useCallback(
    (startSec: number): string => {
      pushHistory();
      const start = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
      const caption: CaptionEntry = {
        id: createCaptionId(),
        startSec: start,
        endSec: start + NEW_CAPTION_DURATION_SEC,
        text: "New caption",
      };
      setCaptions((prev) => [...prev, caption]);
      uiActions.setSelectedCaptionId(caption.id);
      return caption.id;
    },
    [pushHistory, setCaptions],
  );

  const handleUpdateCaption = useCallback(
    (caption: CaptionEntry) => {
      pushHistoryDebounced(`caption:${caption.id}`);
      setCaptions((prev) =>
        prev.map((c) => (c.id === caption.id ? caption : c)),
      );
    },
    [pushHistoryDebounced, setCaptions],
  );

  /**
   * Move one edge of a cue while keeping it at least
   * `MIN_CAPTION_DURATION_SEC` long — the drag handler for the lane's chips.
   */
  const handleResizeCaption = useCallback(
    (id: string, edge: "start" | "end", timeSec: number) => {
      pushHistoryDebounced(`caption-resize:${id}`);
      setCaptions((prev) =>
        prev.map((caption) => {
          if (caption.id !== id) return caption;
          if (edge === "start") {
            const startSec = Math.max(
              0,
              Math.min(timeSec, caption.endSec - MIN_CAPTION_DURATION_SEC),
            );
            return { ...caption, startSec };
          }
          const endSec = Math.max(
            caption.startSec + MIN_CAPTION_DURATION_SEC,
            timeSec,
          );
          return { ...caption, endSec };
        }),
      );
    },
    [pushHistoryDebounced, setCaptions],
  );

  const handleDeleteCaption = useCallback(
    (id: string) => {
      pushHistory();
      setCaptions((prev) => prev.filter((caption) => caption.id !== id));
      uiActions.setSelectedCaptionId((prev) => (prev === id ? null : prev));
    },
    [pushHistory, setCaptions],
  );

  const handleCaptionStyleChange = useCallback(
    (style: Partial<TextOverlayStyle>) => {
      pushHistoryDebounced("caption-style");
      editorStore.getState().setCaptionStyle(style);
    },
    [pushHistoryDebounced],
  );

  /**
   * Import a `.srt` / `.ass` file, replacing the existing caption track.
   *
   * Replacing rather than merging keeps the mental model simple (the file is
   * the track) and is reversible via undo.
   */
  const handleImportCaptions = useCallback(
    async (file: File) => {
      const { setStatus } = settingsStore.getState();
      try {
        const imported = parseSubtitles(await file.text(), file.name);
        if (imported.length === 0) {
          setStatus(
            `No caption cues found in "${file.name}". Expected SubRip (.srt) or SubStation Alpha (.ass) text.`,
          );
          return;
        }
        pushHistory();
        setCaptions(imported);
        uiActions.setSelectedCaptionId(null);
        setStatus(
          `Imported ${imported.length} caption${imported.length === 1 ? "" : "s"} from "${file.name}".`,
        );
      } catch (error) {
        setStatus(`Could not import captions: ${(error as Error).message}`);
      }
    },
    [pushHistory, setCaptions],
  );

  /** Download the caption track as a `.srt` sidecar. No re-encode involved. */
  const handleExportCaptionsSrt = useCallback(() => {
    const { setStatus, exportSettings } = settingsStore.getState();
    const captions = editorStore.getState().captions;
    if (captions.length === 0) {
      setStatus("Add or import captions before exporting an .srt file.");
      return;
    }
    downloadBlob(
      captionsToSrtBlob(captions),
      `${exportSettings.filename || "stacked"}.srt`,
    );
    setStatus(
      `Exported ${captions.length} caption${captions.length === 1 ? "" : "s"} as .srt.`,
    );
  }, []);

  const handleClearCaptions = useCallback(() => {
    pushHistory();
    setCaptions([]);
    uiActions.setSelectedCaptionId(null);
  }, [pushHistory, setCaptions]);

  return {
    handleAddCaption,
    handleUpdateCaption,
    handleResizeCaption,
    handleDeleteCaption,
    handleCaptionStyleChange,
    handleImportCaptions,
    handleExportCaptionsSrt,
    handleClearCaptions,
  };
}
