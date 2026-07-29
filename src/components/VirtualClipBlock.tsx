import { memo, type CSSProperties, type DragEvent } from 'react';
import type { ClipTransition } from '../types';
import { editorActions, useIsClipSelected } from '../store';
import { WaveformCanvas } from './WaveformCanvas';
import type { VirtualClipLayout } from './timelineClipTypes';

const TRANSITION_COLORS: Record<string, string> = {
  none: 'var(--border)',
  dissolve: '#7c4dff',
  motion: '#f06292',
  morph: '#26c6da',
};

interface Props {
  layout: VirtualClipLayout;
  style: CSSProperties;
  /** Whether this row's clip is the one currently being dragged (see `useIsClipSelected`). */
  isDragging: boolean;
  thumbs?: string[];
  waves?: Float32Array;
  transition?: ClipTransition;
  showTransition: boolean;
  clipCount: number;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDelete: (id: string) => void;
  onEditTransition: (transition: ClipTransition) => void;
  onDragStart: (e: DragEvent, index: number) => void;
  onDragEnd: () => void;
  onTouchStart: (index: number) => void;
}

function VirtualClipBlockImpl({
  layout,
  style,
  isDragging,
  thumbs,
  waves,
  transition,
  showTransition,
  clipCount,
  onMoveUp,
  onMoveDown,
  onDelete,
  onEditTransition,
  onDragStart,
  onDragEnd,
  onTouchStart,
}: Props) {
  const { clip, index, duration } = layout;
  const isSelected = useIsClipSelected(clip.id);
  const isLoadingThumbs = clip.kind === 'video' && thumbs === undefined;
  const isLoadingWave = clip.kind === 'audio' && waves === undefined;
  const layerIndex = clip.layerIndex ?? 0;
  const isOverlay = layerIndex > 0;

  return (
    <>
      {showTransition && transition && (
        <button
          type="button"
          className={`transition-zone transition-zone--overlay${transition.type !== 'none' ? ' active' : ''}`}
          style={{
            left: layout.start - 12,
            '--tz-color': TRANSITION_COLORS[transition.type],
          } as CSSProperties}
          onClick={() => onEditTransition(transition)}
          title={`Transition: ${transition.type}${transition.type !== 'none' ? ` (${transition.duration}s)` : ''}`}
          aria-label={`Edit transition between clips ${index} and ${index + 1}`}
        >
          <span className="tz-icon">⬡</span>
          {transition.type !== 'none' && (
            <span className="tz-label">{transition.duration}s</span>
          )}
        </button>
      )}

      <div
        className={`timeline-clip-wrapper${isDragging ? ' is-dragging' : ''}`}
        style={style}
        data-clip-index={index}
        draggable
        onDragStart={(e) => onDragStart(e, index)}
        onDragEnd={onDragEnd}
        onTouchStart={() => onTouchStart(index)}
      >
        <div
          className={`timeline-clip${clip.kind === 'audio' ? ' timeline-clip--audio' : ''}${
            isSelected ? ' selected' : ''
          }${isOverlay ? ' timeline-clip--pip' : ''}`}
          onClick={() => editorActions.setSelectedClipId(clip.id)}
          title={
            isOverlay
              ? `${clip.title}\nPicture-in-Picture overlay (layer ${layerIndex}) — plays from the start of the output, not at its position on this row.`
              : clip.title
          }
        >
          {clip.kind === 'video' ? (
            <div className={`timeline-thumbs${isLoadingThumbs ? ' is-loading' : ''}`}>
              {thumbs?.map((src, ti) => <img key={ti} src={src} alt="" />) ?? null}
            </div>
          ) : (
            <div className={`timeline-waveform${isLoadingWave ? ' is-loading' : ''}`}>
              {waves ? (
                <WaveformCanvas peaks={waves} height={54} />
              ) : (
                <span className="waveform-loading-icon">♫</span>
              )}
            </div>
          )}

          <div className="timeline-clip-footer">
            <span
              className="timeline-drag-handle"
              role="img"
              aria-label="Drag handle — drag to reorder clip"
              title="Drag to reorder"
            >
              ⠿
            </span>

            {isOverlay && (
              <span
                className="timeline-clip-badge"
                title={`Picture-in-Picture overlay, layer ${layerIndex}. Overlay clips always play from the start of the output, independent of where they sit on this track.`}
              >
                PiP · L{layerIndex}
              </span>
            )}

            <span className="timeline-clip-label">
              {index + 1}. {clip.title}
            </span>

            <span className="timeline-clip-dur">{duration.toFixed(1)}s</span>

            <span className="timeline-clip-btns">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onMoveUp(index); }}
                disabled={index === 0}
                aria-label="Move clip left"
              >
                ←
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onMoveDown(index); }}
                disabled={index === clipCount - 1}
                aria-label="Move clip right"
              >
                →
              </button>
              <button
                type="button"
                className="project-delete-btn"
                onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
                title="Delete clip"
                aria-label="Delete clip"
              >
                ×
              </button>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Memoized so that selecting a different clip (or editing one clip's data)
 * only re-renders the affected row(s), not every row in the timeline —
 * critical once timelines have hundreds of clips (#150).
 */
export const VirtualClipBlock = memo(VirtualClipBlockImpl);
