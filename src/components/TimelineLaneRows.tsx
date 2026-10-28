import type { Dispatch, DragEvent, SetStateAction } from 'react';
import type { TextOverlay, Track } from '../types';
import { uiActions } from '../store';
import {
  DEFAULT_TRACK_HEIGHT,
  MAIN_VIDEO_TRACK_ID,
  type TrackClipLayout,
} from '../utils/trackModel';
import { TrackLaneHeader } from './TrackLaneHeader';
import { VirtualClipBlock } from './VirtualClipBlock';

interface TimelineLaneRowsProps {
  tracks: Track[];
  trackLayouts: Map<string, TrackClipLayout[]>;
  textOverlays: TextOverlay[];
  selectedTextOverlayId: string | null;
  contentWidth: number;
  pixelsPerSecond: number;
  dropTargetTrackId: string | null;
  dragClipId: string | null;
  setDragClipId: Dispatch<SetStateAction<string | null>>;
  thumbMap: Record<string, string[]>;
  waveMap: Record<string, Float32Array>;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDelete: (id: string) => void;
  handleDragStart: (e: DragEvent, index: number) => void;
  handleDragEnd: () => void;
}

/**
 * Every lane after the main video lane: overlay video and audio lanes (clip
 * blocks) and titles lanes (text-overlay chips).
 */
export function TimelineLaneRows({
  tracks,
  trackLayouts,
  textOverlays,
  selectedTextOverlayId,
  contentWidth,
  pixelsPerSecond,
  dropTargetTrackId,
  dragClipId,
  setDragClipId,
  thumbMap,
  waveMap,
  onMoveUp,
  onMoveDown,
  onDelete,
  handleDragStart,
  handleDragEnd,
}: TimelineLaneRowsProps) {
  return (
    <>
      {tracks.filter((t) => t.id !== MAIN_VIDEO_TRACK_ID).map((track) => {
        const rowLayouts = trackLayouts.get(track.id) ?? [];
        const rowHeight = track.height ?? DEFAULT_TRACK_HEIGHT;
        return (
          <div
            key={track.id}
            className={`timeline-track-row${dropTargetTrackId === track.id ? ' timeline-track-row--drop-target' : ''}${track.locked ? ' timeline-track-row--locked' : ''}`}
            data-track-id={track.id}
          >
            <TrackLaneHeader trackId={track.id} />
            {track.kind === 'text' ? (
              <div
                className="timeline-track timeline-track--titles"
                style={{ width: contentWidth, height: rowHeight }}
              >
                {track.items.map((item) => {
                  const overlay = textOverlays.find((o) => o.id === item.clipId);
                  if (!overlay) return null;
                  return (
                    <button
                      key={item.clipId}
                      type="button"
                      className={`timeline-title-chip${
                        selectedTextOverlayId === overlay.id ? ' selected' : ''
                      }`}
                      style={{ left: item.startTime * pixelsPerSecond }}
                      onClick={() => uiActions.setSelectedTextOverlayId(overlay.id)}
                      title={`${overlay.text} @ ${item.startTime.toFixed(2)}s`}
                    >
                      T {overlay.text}
                    </button>
                  );
                })}
              </div>
            ) : (
            <div className="timeline-track timeline-track--overlay" style={{ width: contentWidth, height: rowHeight }}>
              {rowLayouts.map((layout) => (
                <VirtualClipBlock
                  key={layout.clip.id}
                  layout={{
                    clip: layout.clip,
                    index: layout.itemIndex,
                    duration: layout.duration,
                    width: layout.width,
                    start: layout.left,
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: layout.width,
                    transform: `translateX(${layout.left}px)`,
                  }}
                  isDragging={dragClipId === layout.clip.id}
                  thumbs={thumbMap[layout.clip.id]}
                  waves={waveMap[layout.clip.id]}
                  clipCount={rowLayouts.length}
                  locked={track.locked ?? false}
                  showTransition={false}
                  onMoveUp={onMoveUp}
                  onMoveDown={onMoveDown}
                  onDelete={onDelete}
                  onEditTransition={() => {}}
                  onDragStart={(e, clipIndex) => {
                    setDragClipId(layout.clip.id);
                    handleDragStart(e, clipIndex);
                  }}
                  onDragEnd={handleDragEnd}
                  onTouchStart={() => setDragClipId(layout.clip.id)}
                />
              ))}
            </div>
            )}
          </div>
        );
      })}
    </>
  );
}
