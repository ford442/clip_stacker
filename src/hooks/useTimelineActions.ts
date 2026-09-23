import { useCallback } from "react";
import { getTimelineClips } from "../utils/timelineClips";
import { reindexTransitions } from "../utils/transitions";
import {
  isClipLocked,
  removeClipFromTracks,
  reorderMainTrackClips,
  MAIN_VIDEO_TRACK_ID,
} from "../utils/trackModel";
import { editorStore } from "../store/editorStore";
import { settingsStore } from "../store/settingsStore";
import { uiStore } from "../store/uiStore";
import { playbackStore } from "../store/playbackStore";
import {
  dropEdit,
  nudgeWithTool,
  rippleDelete,
  type EditResult,
  type EditState,
} from "../utils/editModes";
import { collectSnapTargets, snapClipStart } from "../utils/timelineSnap";
import { getClipDuration } from "../utils/project";

/**
 * Guard every clip edit that a locked lane must reject (#168 Phase A).
 *
 * Checked here rather than in the UI so the block holds for keyboard shortcuts
 * and programmatic callers too, not just the timeline's buttons.
 */
function mainTrackLocked(): boolean {
  const main = editorStore.getState().tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID);
  if (!main?.locked) return false;
  settingsStore.getState().setStatus("Track is locked — unlock the lane to reorder clips.");
  return true;
}

function refuseWhenLocked(clipId: string, what: string): boolean {
  if (!isClipLocked(editorStore.getState().tracks, clipId)) return false;
  settingsStore.getState().setStatus(`Track is locked — unlock the lane to ${what}.`);
  return true;
}
import { reindexAfterSwap } from "../app/helpers";

function currentEditState(): EditState {
  const { tracks, clips, transitions } = editorStore.getState();
  return { tracks, clips, transitions };
}

/**
 * Commit an edit-mode result as one undo step, or surface why it was refused.
 * The pure edit already refuses locked lanes; this is where the reason reaches
 * the status bar for every entry point (drop, keyboard nudge, ripple delete).
 */
function commitOrReport(result: EditResult, success?: string): boolean {
  if (!result.ok) {
    settingsStore.getState().setStatus(result.reason);
    return false;
  }
  editorStore.getState().commitEdit(result.state);
  if (success) settingsStore.getState().setStatus(success);
  return true;
}

/** Nudge step for the edit tools: one frame at 30 fps. */
export const EDIT_NUDGE_FRAME_SEC = 1 / 30;
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
> & {};


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
}: TimelineActionsDeps) {
  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    if (mainTrackLocked()) return;
    pushHistory();
    setClips((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index - 1, index));
  }, [pushHistory, setClips, setTransitions]);

  const handleMoveDown = useCallback((index: number) => {
    if (mainTrackLocked()) return;
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
      const mainTrack = editorStore
        .getState()
        .tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID);
      if (mainTrack?.locked) {
        settingsStore.getState().setStatus("Track is locked — unlock the lane to reorder clips.");
        return;
      }
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

  /**
   * Drop a clip onto a lane at `startTime`, honouring the timeline's drop mode
   * (overwrite covers what is underneath, insert pushes it later) and, when the
   * magnet is on, snapping either clip edge to the playhead, clip edges,
   * markers, caption edges or beats within `snapThresholdSec`.
   */
  const handleMoveToTrack = useCallback(
    (clipId: string, targetTrackId: string, startTime: number, snapThresholdSec?: number) => {
      if (refuseWhenLocked(clipId, "move this clip")) return;
      const { dropEditMode, snapEnabled, linkedRipple } = uiStore.getState();
      const state = editorStore.getState();
      const target = state.tracks.find((t) => t.id === targetTrackId);
      const clip = state.clips.find((c) => c.id === clipId);
      if (!target || !clip) return;
      if (target.locked) {
        settingsStore.getState().setStatus("Target track is locked.");
        return;
      }

      let at = startTime;
      if (snapEnabled) {
        const targets = collectSnapTargets({
          tracks: state.tracks,
          clips: state.clips,
          playhead: playbackStore.getState().playheadTime,
          captions: state.captions,
          markers: state.masterAudioMarkers,
          masterAudio: state.masterAudio,
          excludeClipId: clipId,
        });
        at = snapClipStart(startTime, getClipDuration(clip), targets, snapThresholdSec).time;
      }

      commitOrReport(
        dropEdit(currentEditState(), dropEditMode, clipId, targetTrackId, at, {
          linked: linkedRipple,
        }),
      );
    },
    [],
  );

  /**
   * Apply the sticky tool (ripple / roll / slip / slide) to the selected clip,
   * moving its edit by `deltaSec` output seconds. Bound to Alt+←/→.
   */
  const handleEditNudge = useCallback((deltaSec: number) => {
    const { selectedClipId: clipId } = editorStore.getState();
    if (!clipId) {
      settingsStore.getState().setStatus("Select a clip to nudge its edit.");
      return;
    }
    if (refuseWhenLocked(clipId, "edit this clip")) return;
    const { timelineTool, linkedRipple } = uiStore.getState();
    commitOrReport(
      nudgeWithTool(currentEditState(), timelineTool, clipId, deltaSec, { linked: linkedRipple }),
    );
  }, []);

  /** Delete a clip and close the gap it leaves (Shift+Delete). */
  const handleRippleDelete = useCallback((clipId: string) => {
    if (refuseWhenLocked(clipId, "delete this clip")) return;
    const clip = editorStore.getState().clips.find((c) => c.id === clipId);
    const { linkedRipple } = uiStore.getState();
    commitOrReport(
      rippleDelete(currentEditState(), clipId, { linked: linkedRipple }),
      `Ripple-deleted "${clip?.title ?? "clip"}".`,
    );
  }, []);

  const handleDeleteClip = useCallback(
    (clipId: string) => {
      // Find the clip
      const clipIndex = clips.findIndex((c) => c.id === clipId);
      if (clipIndex < 0) return;
      const clipToDelete = clips[clipIndex];

      if (refuseWhenLocked(clipId, "delete this clip")) return;

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

      settingsStore.getState().setStatus(`Deleted "${clipTitle}".`);
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
    ],
  );

  return {
    handleMoveUp,
    handleMoveDown,
    handleReorder,
    handleMoveToTrack,
    handleDeleteClip,
    handleEditNudge,
    handleRippleDelete,
  };
}
