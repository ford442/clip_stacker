import { useCallback } from "react";
import type { Clip, TextOverlay } from "../types";
import { createClipId } from "../utils/media";
import {
  DEFAULT_TEXT_OVERLAY_X,
  DEFAULT_TEXT_OVERLAY_Y,
} from "../utils/overlayCoords";
import { DEFAULT_SCROLL_SPEED } from "../utils/textOverlay";
import type { UseEditHistoryResult } from "./useEditHistory";
import { editorActions, editorStore, playbackStore } from "../store";
import {
  placeTextOverlayOnTrack,
  removeTextOverlayFromTracks,
} from "../utils/trackModel";

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
    // When the project has a titles lane, the new overlay is placed on the first
    // one at the playhead so it inherits that lane's mute / lock / ordering
    // (#168 Phase C). Projects without a titles lane are unaffected — an overlay
    // with no placement is always visible.
    const { tracks } = editorStore.getState();
    const titlesLane = tracks.find((t) => t.kind === 'text' && !t.locked);
    if (titlesLane) {
      editorActions.setTracks((prev) =>
        placeTextOverlayOnTrack(
          prev,
          newOverlay.id,
          titlesLane.id,
          playbackStore.getState().playheadTime ?? 0,
        ),
      );
    }
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
      editorActions.setTracks((prev) => removeTextOverlayFromTracks(prev, id));
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
