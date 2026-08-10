import { useCallback } from "react";
import { getTimelineClips } from "../utils/timelineClips";
import { reindexTransitions } from "../utils/transitions";
import {
  moveClipBetweenTracks,
  removeClipFromTracks,
  reorderMainTrackClips,
} from "../utils/trackModel";
import { reindexAfterSwap } from "../app/helpers";
import type { UseEditHistoryResult } from "./useEditHistory";

type TimelineActionsDeps = Pick<
  UseEditHistoryResult,
  | "clips"
  | "clipGroups"
  | "transitions"
  | "selectedClipId"
  | "setClips"
  | "setTracks"
  | "setClipGroups"
  | "setTransitions"
  | "setSelectedClipId"
  | "pushHistory"
> & {
  setStatus: (status: string) => void;
};

export function useTimelineActions({
  clips,
  clipGroups,
  transitions,
  selectedClipId,
  setClips,
  setTracks,
  setClipGroups,
  setTransitions,
  setSelectedClipId,
  pushHistory,
  setStatus,
}: TimelineActionsDeps) {
  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    pushHistory();
    setClips((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index - 1, index));
  }, [pushHistory, setClips, setTransitions]);

  const handleMoveDown = useCallback((index: number) => {
    pushHistory();
    setClips((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index, index + 1));
  }, [pushHistory, setClips, setTransitions]);

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
      setTracks((prev) => reorderMainTrackClips(prev, clips, transitions, fromIndex, insertBefore));
      setClips((prev) => {
        const legacy = [...prev];
        const timelineIds = getTimelineClips(prev, clipGroups).map((c) => c.id);
        const fromId = timelineIds[fromIndex];
        const fromPoolIndex = legacy.findIndex((c) => c.id === fromId);
        if (fromPoolIndex < 0) return prev;
        const next = [...legacy];
        const [moved] = next.splice(fromPoolIndex, 1);
        let target = insertBefore;
        if (insertBefore < timelineIds.length) {
          const targetId = timelineIds[insertBefore > fromIndex ? insertBefore - 1 : insertBefore];
          const targetPoolIndex = next.findIndex((c) => c.id === targetId);
          if (targetPoolIndex >= 0) {
            next.splice(targetPoolIndex + (insertBefore > fromIndex ? 1 : 0), 0, moved);
            return next;
          }
        }
        next.push(moved);
        return next;
      });
    },
    [pushHistory, clips, transitions, clipGroups, setTracks, setClips],
  );

  const handleMoveToTrack = useCallback(
    (clipId: string, targetTrackId: string, startTime: number) => {
      pushHistory();
      setTracks((prev) => moveClipBetweenTracks(prev, clipId, targetTrackId, startTime));
    },
    [pushHistory, setTracks],
  );

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
      setTracks((prev) => removeClipFromTracks(prev, clipId));

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
    [
      clips,
      clipGroups,
      selectedClipId,
      pushHistory,
      setClips,
      setTracks,
      setClipGroups,
      setTransitions,
      setSelectedClipId,
      setStatus,
    ],
  );

  return {
    handleMoveUp,
    handleMoveDown,
    handleReorder,
    handleMoveToTrack,
    handleDeleteClip,
  };
}
