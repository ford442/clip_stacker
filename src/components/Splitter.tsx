import { memo, useCallback, useEffect, useRef } from 'react';
import { splitterKeyAction } from '../utils/workspaceLayout';

/**
 * A draggable, keyboard-operable separator (WAI-ARIA window splitter).
 *
 * It owns only the gesture: the owner decides what a delta means. Pointer
 * moves are coalesced to one `onResizeBy` per animation frame, with the delta
 * measured from where the drag started (so rounding never accumulates).
 * Arrow keys step by 16px (Shift: 64px), Home / End jump to the limits,
 * Enter runs `onToggle` (collapse), double-click runs `onReset`.
 */
export interface SplitterProps {
  /** `vertical` sits between columns (drags left/right); `horizontal` between rows. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  /** id of the region this splitter sizes. */
  controls?: string;
  /** Current size for assistive tech; omitted while it is the natural (unset) size. */
  value?: number;
  min: number;
  max: number;
  className?: string;
  /** Pointer drag begins — the owner snapshots its start sizes here. */
  onResizeStart: () => void;
  /** Total delta (px, + = right / down) since `onResizeStart`. */
  onResizeBy: (deltaPx: number) => void;
  onResizeEnd?: () => void;
  /** One keyboard step relative to the current size. */
  onStep: (deltaPx: number) => void;
  onStepTo: (edge: 'min' | 'max') => void;
  onReset?: () => void;
  onToggle?: () => void;
}

const DRAGGING_CLASS = 'workspace-is-resizing';

function SplitterImpl({
  orientation,
  label,
  controls,
  value,
  min,
  max,
  className,
  onResizeStart,
  onResizeBy,
  onResizeEnd,
  onStep,
  onStepTo,
  onReset,
  onToggle,
}: SplitterProps) {
  const dragRef = useRef<{ pointerId: number; origin: number; delta: number } | null>(null);
  const rafRef = useRef(0);
  // Latest callbacks for the rAF flush, so a re-render mid-drag is harmless.
  const onResizeByRef = useRef(onResizeBy);
  useEffect(() => {
    onResizeByRef.current = onResizeBy;
  }, [onResizeBy]);

  const axis = (e: { clientX: number; clientY: number }) =>
    orientation === 'vertical' ? e.clientX : e.clientY;

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    onResizeByRef.current(dragRef.current.delta);
    dragRef.current = null;
    document.body.classList.remove(DRAGGING_CLASS, `${DRAGGING_CLASS}--${orientation}`);
    onResizeEnd?.();
  }, [onResizeEnd, orientation]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      document.body.classList.remove(DRAGGING_CLASS, `${DRAGGING_CLASS}--${orientation}`);
    },
    [orientation],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, origin: axis(e), delta: 0 };
    document.body.classList.add(DRAGGING_CLASS, `${DRAGGING_CLASS}--${orientation}`);
    onResizeStart();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.delta = axis(e) - drag.origin;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (dragRef.current) onResizeByRef.current(dragRef.current.delta);
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    endDrag();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = splitterKeyAction(e.key, e.shiftKey, orientation);
    if (!action) return;
    if (action.kind === 'toggle' && !onToggle) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === 'step') onStep(action.deltaPx);
    else if (action.kind === 'toggle') onToggle?.();
    else onStepTo(action.kind);
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label} — drag or use the arrow keys; double-click to reset`}
      className={`workspace-splitter workspace-splitter--${orientation}${className ? ` ${className}` : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}

export const Splitter = memo(SplitterImpl);
