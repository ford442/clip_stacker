import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import type { Clip } from "../types";
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
