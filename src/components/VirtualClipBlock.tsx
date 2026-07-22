import type { CSSProperties, DragEvent } from 'react';
import type { ClipTransition } from '../types';
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
  selectedClipId: string | null;
  dragIndex: number | null;
  thumbs?: string[];
  waves?: Float32Array;
  transition?: ClipTransition;
  showTransition: boolean;
  clipCount: number;
  onSelect: (id: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDelete: (id: string) => void;
  onEditTransition: (transition: ClipTransition) => void;
  onDragStart: (e: DragEvent, index: number) => void;
  onDragEnd: () => void;
  onTouchStart: (index: number) => void;
}

export function VirtualClipBlock({
  layout,
  style,
  selectedClipId,
  dragIndex,
  thumbs,
  waves,
  transition,
  showTransition,
  clipCount,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDelete,
  onEditTransition,
  onDragStart,
  onDragEnd,
  onTouchStart,
}: Props) {
  const { clip, index, duration } = layout;
  const isLoadingThumbs = clip.kind === 'video' && thumbs === undefined;
  const isLoadingWave = clip.kind === 'audio' && waves === undefined;

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
        className={`timeline-clip-wrapper${dragIndex === index ? ' is-dragging' : ''}`}
        style={style}
        data-clip-index={index}
        draggable
        onDragStart={(e) => onDragStart(e, index)}
        onDragEnd={onDragEnd}
        onTouchStart={() => onTouchStart(index)}
      >
        <div
          className={`timeline-clip${clip.kind === 'audio' ? ' timeline-clip--audio' : ''}${
            clip.id === selectedClipId ? ' selected' : ''
          }`}
          onClick={() => onSelect(clip.id)}
          title={clip.title}
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
