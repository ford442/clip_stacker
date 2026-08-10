import { useCallback } from "react";
import type { Clip } from "../types";
import { getMediaInfo, createClipId, MIN_CLIP_DURATION } from "../utils/media";
import { duplicateClip, splitClipAt } from "../utils/clipOperations";
import { snapSplitTimeToBeat } from "../utils/beatSnap";
import {
  removeClipFromGroups,
} from "../utils/clipOperations";
import {
  replaceClipOnTrackAfterSplit,
} from "../utils/trackModel";
import { shiftTransitionsForInsert } from "../utils/transitions";
import { downloadRemoteMedia, type MediaLibraryItem } from "../utils/project";
import { editorStore, playbackStore, setPlayheadTime } from "../store";
import { planAddClip } from "../utils/planAddClip";
import type { UseEditHistoryResult } from "./useEditHistory";

type ClipActionsDeps = Pick<
  UseEditHistoryResult,
  | "clips"
  | "selectedClipId"
  | "setClips"
  | "setTracks"
  | "setClipGroups"
  | "setTransitions"
  | "setSelectedClipId"
  | "pushHistory"
> & {
  setStatus: (status: string) => void;
  setOutputUrl: (url: string | null) => void;
};

export function useClipActions({
  clips,
  selectedClipId,
  setClips,
  setTracks,
  setClipGroups,
  setTransitions,
  setSelectedClipId,
  pushHistory,
  setStatus,
  setOutputUrl,
}: ClipActionsDeps) {
  /** Add a new clip to the state and set up A/B grouping if a matching clip exists. */
  const addClipToState = useCallback((newClip: Clip) => {
    const { clips: prevClips, tracks: prevTracks, clipGroups: prevGroups } =
      editorStore.getState();
    const plan = planAddClip(prevClips, prevTracks, prevGroups, newClip);
    editorStore.setState({
      clips: plan.clips,
      ...(plan.tracks ? { tracks: plan.tracks } : {}),
      ...(plan.clipGroups ? { clipGroups: plan.clipGroups } : {}),
    });
  }, []);

  const insertClipAfter = useCallback(
    (index: number, newClip: Clip) => {
      setClips((prev) => {
        const next = [...prev];
        next.splice(index + 1, 0, newClip);
        return next;
      });
      setTransitions((prev) => shiftTransitionsForInsert(prev, index + 1));
    },
    [setClips, setTransitions],
  );

  const handleDuplicateClip = useCallback(() => {
    if (!selectedClipId) {
      setStatus("Select a clip to duplicate.");
      return;
    }

    const index = clips.findIndex((clip) => clip.id === selectedClipId);
    if (index < 0) return;

    pushHistory();
    const source = clips[index];
    const copy = duplicateClip(source);
    insertClipAfter(index, copy);
    setSelectedClipId(copy.id);
    setPlayheadTime(copy.trimStart);
    setOutputUrl(null);
    setStatus(`Duplicated "${source.title}".`);
  }, [
    clips,
    selectedClipId,
    pushHistory,
    insertClipAfter,
    setSelectedClipId,
    setStatus,
    setOutputUrl,
  ]);

  const handleSplitClip = useCallback(() => {
    if (!selectedClipId) {
      setStatus("Select a clip to split.");
      return;
    }
    const currentPlayheadTime = playbackStore.getState().playheadTime;
    if (currentPlayheadTime === null) {
      setStatus("Move the preview playhead before splitting.");
      return;
    }

    const index = clips.findIndex((clip) => clip.id === selectedClipId);
    if (index < 0) return;

    const source = clips[index];
    const snappedTime = snapSplitTimeToBeat(source, currentPlayheadTime);
    const split = splitClipAt(source, snappedTime);
    if (!split) {
      setStatus(
        "Cannot split here — place the playhead at least 0.1s inside the trimmed region.",
      );
      return;
    }

    pushHistory();
    const [left, right] = split;
    setClips((prev) => {
      const next = [...prev];
      next.splice(index, 1, left, right);
      return next;
    });
    setTracks((prev) =>
      replaceClipOnTrackAfterSplit(prev, source.id, left.id, right.id, snappedTime),
    );
    setTransitions((prev) => shiftTransitionsForInsert(prev, index + 1));
    if (source.groupId) {
      setClipGroups((prev) => removeClipFromGroups(prev, source));
    }
    setSelectedClipId(right.id);
    setPlayheadTime(right.trimStart);
    setOutputUrl(null);
    setStatus(
      `Split "${source.title}" at ${snappedTime.toFixed(2)}s${
        snappedTime !== currentPlayheadTime ? " (snapped to beat)" : ""
      }.`,
    );
  }, [
    clips,
    selectedClipId,
    pushHistory,
    setClipGroups,
    setSelectedClipId,
    setStatus,
    setOutputUrl,
    setClips,
    setTracks,
    setTransitions,
  ]);

  const handleAddClips = useCallback(
    async (files: File[]) => {
      setStatus("Importing clips...");
      let added = 0;
      let pushedHistory = false;

      for (const file of files) {
        const isVideo =
          file.type.startsWith("video/") ||
          file.name.toLowerCase().endsWith(".mp4");
        const isAudio =
          file.type.startsWith("audio/") || /\.(wav|mp3)$/i.test(file.name);
        const isImage =
          file.type.startsWith("image/") ||
          /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name);
        if (!isVideo && !isAudio && !isImage) continue;

        try {
          const { duration, objectUrl, videoWidth, videoHeight } =
            await getMediaInfo(file);
          const newClip: Clip = {
            id: createClipId(),
            file,
            objectUrl,
            title: file.name,
            kind: isAudio ? "audio" : "video",
            duration: Math.max(MIN_CLIP_DURATION, duration),
            videoWidth,
            videoHeight,
            trimStart: 0,
            trimEnd: NaN,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            ...(isImage ? { stillImage: true } : {}),
          };
          if (!pushedHistory) {
            pushHistory();
            pushedHistory = true;
          }
          addClipToState(newClip);
          setSelectedClipId(newClip.id);
          added++;
        } catch (error) {
          setStatus(
            `Failed to import ${file.name}: ${(error as Error).message}`,
          );
        }
      }

      if (added > 0) {
        setOutputUrl(null);
        setStatus(`${added} clip(s) imported.`);
      } else {
        setStatus(
          "No media files could be imported. Check that files are valid MP4/WAV/MP3/JPEG/PNG.",
        );
      }
    },
    [addClipToState, pushHistory, setSelectedClipId, setStatus, setOutputUrl],
  );

  const handleAddLibraryClip = useCallback(
    async (item: MediaLibraryItem) => {
      setStatus(`Downloading ${item.name} from media library...`);
      try {
        const blob = await downloadRemoteMedia(item.url);
        const file = new File([blob], item.name, { type: blob.type });
        const isAudio =
          file.type.startsWith("audio/") || /\.(wav|mp3)$/i.test(file.name);
        const { duration, objectUrl, videoWidth, videoHeight } =
          await getMediaInfo(file);
        const newClip: Clip = {
          id: createClipId(),
          file,
          objectUrl,
          title: file.name,
          kind: isAudio ? "audio" : "video",
          duration: Math.max(MIN_CLIP_DURATION, duration),
          videoWidth,
          videoHeight,
          trimStart: 0,
          trimEnd: NaN,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          remoteSourceUrl: item.url,
        };
        pushHistory();
        addClipToState(newClip);
        setSelectedClipId(newClip.id);
        setOutputUrl(null);
        setStatus(`Added "${item.name}" from media library.`);
      } catch (error) {
        setStatus(
          `Could not add "${item.name}" from media library: ${(error as Error).message}`,
        );
      }
    },
    [addClipToState, pushHistory, setSelectedClipId, setStatus, setOutputUrl],
  );

  const handleToggleVariant = useCallback(
    (groupId: string, variant: "A" | "B") => {
      pushHistory();
      setClipGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, activeVariant: variant } : g,
        ),
      );
      setClips((prevClips) => {
        // Find the group
        // We need the latest groups state — use functional update pattern
        // The newly selected variant clip becomes the one on the timeline
        return prevClips.map((c) => {
          if (c.groupId !== groupId) return c;
          // The clip that matches the chosen variant stays, the other is "background"
          return c;
        });
      });
    },
    [pushHistory, setClipGroups, setClips],
  );

  return {
    handleDuplicateClip,
    handleSplitClip,
    handleAddClips,
    handleAddLibraryClip,
    handleToggleVariant,
  };
}
