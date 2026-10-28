import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import type { Clip } from "../types";
import { playbackStore } from "../store/playbackStore";
import { uiStore } from "../store/uiStore";
import type { TimelineEditTool } from "../utils/editModes";
import { EDIT_NUDGE_FRAME_SEC } from "./useTimelineActions";
import type { UseEditHistoryResult } from "./useEditHistory";

type AppKeyboardShortcutsDeps = {
  toolbarRef: RefObject<{ triggerLoadDialog: () => void }>;
  selectedClipId: string | null;
  timelineClips: Clip[];
  canUndo: boolean;
  canRedo: boolean;
  handleMerge: () => Promise<void>;
  handleSaveProject: () => void;
  handleSplitClip: () => void;
  handleDuplicateClip: () => void;
  handleDeleteClip: (clipId: string) => void;
  handleReorder: (fromIndex: number, insertBefore: number) => void;
  /** Applies the sticky edit tool to the selected clip; bound to Alt+←/→. */
  handleEditNudge: (deltaSec: number) => void;
  /** Deletes a clip and closes its gap; bound to Shift+Delete. */
  handleRippleDelete: (clipId: string) => void;
  /** Adds a caption cue at the given output time; bound to `C`. */
  handleAddCaptionAtPlayhead: (startSec: number) => string;
  undo: UseEditHistoryResult["undo"];
  redo: UseEditHistoryResult["redo"];
  setStatus: (status: string) => void;
  setShowKeyboardShortcuts: (show: boolean) => void;
};

export function useAppKeyboardShortcuts({
  toolbarRef,
  selectedClipId,
  timelineClips,
  canUndo,
  canRedo,
  handleMerge,
  handleSaveProject,
  handleSplitClip,
  handleDuplicateClip,
  handleDeleteClip,
  handleReorder,
  handleEditNudge,
  handleRippleDelete,
  handleAddCaptionAtPlayhead,
  undo,
  redo,
  setStatus,
  setShowKeyboardShortcuts,
}: AppKeyboardShortcutsDeps) {
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

  const handleRippleDeleteSelected = useCallback(() => {
    if (selectedClipId) handleRippleDelete(selectedClipId);
  }, [selectedClipId, handleRippleDelete]);

  // Edit-mode keys (#168 follow-up). Tool / mode state lives in `uiStore` and is
  // read at press time, so these stay stable.
  const editModeShortcuts = useMemo(() => {
    const tool = (next: TimelineEditTool, label: string) => () => {
      uiStore.getState().setTimelineTool(next);
      setStatus(`${label} tool — Alt+←/→ nudges the selected clip's edit.`);
    };
    return {
      v: () => {
        uiStore.getState().setTimelineTool("select");
        setStatus("Select tool.");
      },
      q: tool("ripple", "Ripple trim"),
      w: tool("roll", "Roll"),
      y: tool("slip", "Slip"),
      u: tool("slide", "Slide"),
      i: () => {
        uiStore.getState().setDropEditMode("insert");
        setStatus("Insert mode — drops push later clips on the lane.");
      },
      o: () => {
        uiStore.getState().setDropEditMode("overwrite");
        setStatus("Overwrite mode — drops cover clips on the lane.");
      },
      n: () => {
        const next = !uiStore.getState().snapEnabled;
        uiStore.getState().setSnapEnabled(next);
        setStatus(next ? "Snapping on." : "Snapping off.");
      },
      "alt+arrowleft": () => handleEditNudge(-EDIT_NUDGE_FRAME_SEC),
      "alt+arrowright": () => handleEditNudge(EDIT_NUDGE_FRAME_SEC),
      "shift+alt+arrowleft": () => handleEditNudge(-10 * EDIT_NUDGE_FRAME_SEC),
      "shift+alt+arrowright": () => handleEditNudge(10 * EDIT_NUDGE_FRAME_SEC),
      "shift+delete": handleRippleDeleteSelected,
      "shift+backspace": handleRippleDeleteSelected,
    };
  }, [handleEditNudge, handleRippleDeleteSelected, setStatus]);

  // The playhead is read at press time rather than subscribed to, so this
  // callback stays stable while the preview scrubs.
  const handleAddCaption = useCallback(() => {
    handleAddCaptionAtPlayhead(playbackStore.getState().playheadTime ?? 0);
    setStatus("Caption added at the playhead. Edit it in the Captions tab.");
  }, [handleAddCaptionAtPlayhead, setStatus]);

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

  const shortcutsMap = useMemo(
    () => ({
      r: handleMerge,
      "ctrl+s": handleSaveProject,
      s: handleSplitClip,
      c: handleAddCaption,
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
      ...editModeShortcuts,
    }),
    [
      editModeShortcuts,
      handleMerge,
      handleSaveProject,
      handleSplitClip,
      handleDuplicateClip,
      handleAddCaption,
      handleDeleteSelectedClip,
      handleMoveSelectedLeft,
      handleMoveSelectedRight,
      handleUndo,
      handleRedo,
      toolbarRef,
      setShowKeyboardShortcuts,
    ],
  );

  useKeyboardShortcuts(shortcutsMap, true);

  return {
    handleUndo,
    handleRedo,
  };
}
