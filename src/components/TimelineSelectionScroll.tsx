import { useEffect, useRef, type RefObject } from 'react';
import type { useVirtualizer } from '@tanstack/react-virtual';
import { useSelectedClipId } from '../store';
import { editorStore } from '../store/editorStore';
import { getEffectiveTimelineClips } from '../utils/trackModel';

/** Scrolls the virtualizer when selection changes without re-rendering the timeline track. */
export function TimelineSelectionScroll({
  virtualizerRef,
}: {
  virtualizerRef: RefObject<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>;
}) {
  const selectedClipId = useSelectedClipId();
  const scrolledForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedClipId) {
      scrolledForRef.current = null;
      return;
    }
    if (scrolledForRef.current === selectedClipId) return;
    scrolledForRef.current = selectedClipId;

    const { tracks, clips, clipGroups } = editorStore.getState();
    const timelineClips = getEffectiveTimelineClips(tracks, clips, clipGroups);
    const selectedIndex = timelineClips.findIndex((clip) => clip.id === selectedClipId);
    if (selectedIndex < 0) return;
    virtualizerRef.current?.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedClipId, virtualizerRef]);

  return null;
}
