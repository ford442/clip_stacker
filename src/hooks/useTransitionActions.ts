import { useCallback, useState } from "react";
import type { ClipTransition } from "../types";
import { getTimelineClips } from "../utils/timelineClips";
import {
  isMorphTransition,
  shouldRegenerateMorph,
} from "../utils/morphTransition";
import type { UseEditHistoryResult } from "./useEditHistory";

type TransitionActionsDeps = Pick<
  UseEditHistoryResult,
  "clips" | "clipGroups" | "setTransitions" | "pushHistoryDebounced"
> & {
  setStatus: (status: string) => void;
};

export function useTransitionActions({
  clips,
  clipGroups,
  setTransitions,
  pushHistoryDebounced,
  setStatus,
}: TransitionActionsDeps) {
  const [morphProcessingIndex, setMorphProcessingIndex] = useState<number | null>(
    null,
  );

  const handleTransitionUpdate = useCallback(
    (updated: ClipTransition) => {
      pushHistoryDebounced(`transition:${updated.afterClipIndex}`);
      let previous: ClipTransition | undefined;
      setTransitions((prev) => {
        previous = prev.find(
          (t) => t.afterClipIndex === updated.afterClipIndex,
        );
        const exists = previous !== undefined;
        if (exists) {
          return prev.map((t) =>
            t.afterClipIndex === updated.afterClipIndex ? updated : t,
          );
        }
        return [...prev, updated];
      });

      if (
        isMorphTransition(updated) &&
        shouldRegenerateMorph(previous, updated) &&
        morphProcessingIndex === null
      ) {
        setMorphProcessingIndex(updated.afterClipIndex);
        const clipsForMorph = getTimelineClips(clips, clipGroups);
        void (async () => {
          const { requestMorphSegment } = await import("../utils/morphGeneration");
          await requestMorphSegment(
            updated,
            clipsForMorph,
            setStatus,
            (next) => {
              setTransitions((prev) =>
                prev.map((t) =>
                  t.afterClipIndex === next.afterClipIndex ? next : t,
                ),
              );
            },
          );
          setMorphProcessingIndex(null);
        })();
      }
    },
    [
      pushHistoryDebounced,
      morphProcessingIndex,
      clips,
      clipGroups,
      setStatus,
      setTransitions,
    ],
  );

  return {
    morphProcessingIndex,
    handleTransitionUpdate,
  };
}
