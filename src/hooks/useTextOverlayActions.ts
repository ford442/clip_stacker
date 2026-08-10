import { useCallback } from "react";
import type { Clip, TextOverlay } from "../types";
import { createClipId } from "../utils/media";
import {
  DEFAULT_TEXT_OVERLAY_X,
  DEFAULT_TEXT_OVERLAY_Y,
} from "../utils/overlayCoords";
import { DEFAULT_SCROLL_SPEED } from "../utils/textOverlay";
import type { UseEditHistoryResult } from "./useEditHistory";

type TextOverlayActionsDeps = Pick<
  UseEditHistoryResult,
  "setTextOverlays" | "pushHistory" | "pushHistoryDebounced"
> & {
  setSelectedTextOverlayId: (id: string | null | ((prev: string | null) => string | null)) => void;
};

export function useTextOverlayActions({
  setTextOverlays,
  pushHistory,
  pushHistoryDebounced,
  setSelectedTextOverlayId,
}: TextOverlayActionsDeps) {
  const handleAddTextOverlay = useCallback((): string => {
    pushHistory();
    const newOverlay: TextOverlay = {
      id: createClipId(),
      text: "Add your text here",
      fontsize: 40,
      fontcolor: "#ffffff",
      x: DEFAULT_TEXT_OVERLAY_X,
      y: DEFAULT_TEXT_OVERLAY_Y,
      scrolling: false,
      scrollSpeed: DEFAULT_SCROLL_SPEED,
      box: true,
      boxColor: "black@0.5",
    };
    setTextOverlays((prev) => [...prev, newOverlay]);
    return newOverlay.id;
  }, [pushHistory, setTextOverlays]);

  const handleUpdateTextOverlay = useCallback((overlay: TextOverlay) => {
    pushHistoryDebounced(`text-overlay:${overlay.id}`);
    setTextOverlays((prev) =>
      prev.map((o) => (o.id === overlay.id ? overlay : o)),
    );
  }, [pushHistoryDebounced, setTextOverlays]);

  const handleDeleteTextOverlay = useCallback(
    (id: string) => {
      pushHistory();
      setTextOverlays((prev) => prev.filter((o) => o.id !== id));
      setSelectedTextOverlayId((prev) => (prev === id ? null : prev));
    },
    [pushHistory, setTextOverlays, setSelectedTextOverlayId],
  );

  const handlePreviewDragStart = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  return {
    handleAddTextOverlay,
    handleUpdateTextOverlay,
    handleDeleteTextOverlay,
    handlePreviewDragStart,
  };
}

export function useLayoutCommitHandlers(
  setClips: UseEditHistoryResult["setClips"],
  setTextOverlays: UseEditHistoryResult["setTextOverlays"],
) {
  const handleClipLayoutCommit = useCallback(
    (clipId: string, clip: Clip, _editedKeyframe: boolean) => {
      setClips((prev) => prev.map((item) => (item.id === clipId ? clip : item)));
    },
    [setClips],
  );

  const handleTextOverlayLayoutCommit = useCallback(
    (overlayId: string, overlay: TextOverlay, _editedKeyframe: boolean) => {
      setTextOverlays((prev) =>
        prev.map((item) => (item.id === overlayId ? overlay : item)),
      );
    },
    [setTextOverlays],
  );

  return {
    handleClipLayoutCommit,
    handleTextOverlayLayoutCommit,
  };
}
