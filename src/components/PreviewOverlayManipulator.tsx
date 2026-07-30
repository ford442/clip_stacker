import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from '../types';
import {
  buildPreviewCompositionPlan,
  resolveClipLocalTimeAtGlobal,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
  type PreviewTextLayer,
} from '../utils/previewComposition';
import { parseCanvasSize } from '../utils/pipPreset';
import {
  applyClipLayoutAtPlayhead,
  applyTextOverlayPositionAtPlayhead,
} from '../utils/overlayPositionEdit';
import {
  clipAspectRatio,
} from '../utils/pipPreset';
import {
  clampPixelRectToCanvas,
  DEFAULT_SNAP_THRESHOLD_PX,
  estimateTextSizeNormalized,
  hitTestResizeHandle,
  pointInRect,
  resizePixelRect,
  snapPixelRect,
  type PixelRect,
  type ResizeHandle,
  type SnapGuide,
} from '../utils/overlayCoords';
import { textOverlayHasKeyframes } from '../utils/animatedLayout';
import { clipHasKeyframes } from '../utils/animatedLayout';

type ManipulableTarget =
  | { kind: 'pip'; clipId: string; rect: PixelRect; zIndex: number }
  | { kind: 'text'; overlayId: string; rect: PixelRect; zIndex: number; scrolling: boolean };

interface Props {
  timelineClips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings?: ExportSettings;
  playheadTime: number;
  selectedClipId: string | null;
  selectedTextOverlayId: string | null;
  canvasWidth: number;
  canvasHeight: number;
  onSelectClip: (clipId: string | null) => void;
  onSelectTextOverlay: (overlayId: string | null) => void;
  onClipLayoutCommit: (clipId: string, clip: Clip, editedKeyframe: boolean) => void;
  onTextOverlayCommit: (
    overlayId: string,
    overlay: TextOverlay,
    editedKeyframe: boolean,
  ) => void;
  onDragStart: () => void;
  onBackgroundClick?: () => void;
}

const HANDLE_SIZE = 8;

function estimateTextRect(
  layer: PreviewTextLayer,
  outputWidth: number,
  outputHeight: number,
  scale: number,
): PixelRect {
  const overlay = layer.overlay;
  const fontsize = overlay.fontsize * scale;
  const charWidth = fontsize * 0.55;
  const width = Math.min(layer.x + overlay.text.length * charWidth, outputWidth * scale) - layer.x;
  const height = fontsize;
  const pad = overlay.box ? fontsize * 0.2 : 0;
  return {
    x: layer.x - pad,
    y: layer.y - pad,
    width: Math.max(24, width + pad * 2),
    height: height + pad * 2,
  };
}

function buildManipulableTargets(plan: PreviewCompositionPlan): ManipulableTarget[] {
  const targets: ManipulableTarget[] = [];

  for (const layer of plan.layers) {
    if (layer.kind === 'pip') {
      const pip = layer as PreviewClipLayer;
      targets.push({
        kind: 'pip',
        clipId: pip.clipId,
        zIndex: pip.zIndex,
        rect: {
          x: pip.rect.x,
          y: pip.rect.y,
          width: pip.rect.width,
          height: pip.rect.height,
        },
      });
    } else if (layer.kind === 'text') {
      const text = layer as PreviewTextLayer;
      if (text.overlay.scrolling) {
        targets.push({
          kind: 'text',
          overlayId: text.overlayId,
          zIndex: text.zIndex,
          scrolling: true,
          rect: {
            x: 0,
            y: text.y,
            width: plan.canvasWidth,
            height: estimateTextRect(text, plan.canvasWidth, plan.canvasHeight, plan.scale).height,
          },
        });
      } else {
        targets.push({
          kind: 'text',
          overlayId: text.overlayId,
          zIndex: text.zIndex,
          scrolling: false,
          rect: estimateTextRect(text, plan.canvasWidth, plan.canvasHeight, plan.scale),
        });
      }
    }
  }

  return targets.sort((a, b) => a.zIndex - b.zIndex);
}

export function PreviewOverlayManipulator({
  timelineClips,
  clipGroups,
  transitions,
  textOverlays,
  exportSettings,
  playheadTime,
  selectedClipId,
  selectedTextOverlayId,
  canvasWidth,
  canvasHeight,
  onSelectClip,
  onSelectTextOverlay,
  onClipLayoutCommit,
  onTextOverlayCommit,
  onDragStart,
  onBackgroundClick,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    target: ManipulableTarget;
    handle?: ResizeHandle;
    startPointer: { x: number; y: number };
    startRect: PixelRect;
    aspectRatio: number;
    editedKeyframe: boolean;
  } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<ManipulableTarget | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [keyframeHint, setKeyframeHint] = useState<string | null>(null);

  const outputCanvas = useMemo(
    () => parseCanvasSize(exportSettings?.outputResolution),
    [exportSettings?.outputResolution],
  );

  const plan = useMemo(
    () =>
      buildPreviewCompositionPlan(
        timelineClips,
        clipGroups,
        transitions,
        textOverlays,
        exportSettings,
        playheadTime,
        outputCanvas.height,
        outputCanvas.width,
      ),
    [
      timelineClips,
      clipGroups,
      transitions,
      textOverlays,
      exportSettings,
      playheadTime,
      outputCanvas.height,
      outputCanvas.width,
    ],
  );

  const targets = useMemo(() => buildManipulableTargets(plan), [plan]);

  const scaleX = canvasWidth / plan.canvasWidth;
  const scaleY = canvasHeight / plan.canvasHeight;

  const pointerToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const el = overlayRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * plan.canvasWidth;
      const y = ((clientY - rect.top) / rect.height) * plan.canvasHeight;
      return { x, y };
    },
    [plan.canvasWidth],
  );

  const findTargetAt = useCallback(
    (x: number, y: number): ManipulableTarget | null => {
      for (let i = targets.length - 1; i >= 0; i -= 1) {
        const target = targets[i];
        if (pointInRect(x, y, target.rect)) return target;
      }
      return null;
    },
    [targets],
  );

  const activeTarget = useMemo(() => {
    if (selectedTextOverlayId) {
      const match = targets.find(
        (target) => target.kind === 'text' && target.overlayId === selectedTextOverlayId,
      );
      if (match) return match;
    }
    if (selectedClipId) {
      const match = targets.find(
        (target) => target.kind === 'pip' && target.clipId === selectedClipId,
      );
      if (match) return match;
    }
    return null;
  }, [targets, selectedClipId, selectedTextOverlayId]);

  const commitRect = useCallback(
    (target: ManipulableTarget, rect: PixelRect, editedKeyframe: boolean) => {
      const outputRect = {
        x: rect.x / plan.scale,
        y: rect.y / plan.scale,
        width: rect.width / plan.scale,
        height: rect.height / plan.scale,
      };
      const clamped = clampPixelRectToCanvas(outputRect, outputCanvas);

      if (target.kind === 'pip') {
        const clip = timelineClips.find((item) => item.id === target.clipId);
        if (!clip) return;
        const local = resolveClipLocalTimeAtGlobal(
          timelineClips,
          clipGroups,
          transitions,
          clip.id,
          playheadTime,
        );
        const result = applyClipLayoutAtPlayhead(
          clip,
          clamped,
          outputCanvas,
          local?.localTime ?? 0,
        );
        onClipLayoutCommit(clip.id, result.value, result.editedKeyframe || editedKeyframe);
      } else {
        const overlay = textOverlays.find((item) => item.id === target.overlayId);
        if (!overlay) return;
        const result = applyTextOverlayPositionAtPlayhead(
          overlay,
          { x: clamped.x, y: clamped.y },
          outputCanvas,
          playheadTime,
        );
        onTextOverlayCommit(
          overlay.id,
          result.value,
          result.editedKeyframe || editedKeyframe,
        );
      }
    },
    [
      plan.scale,
      outputCanvas,
      timelineClips,
      clipGroups,
      transitions,
      playheadTime,
      textOverlays,
      onClipLayoutCommit,
      onTextOverlayCommit,
    ],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pointer = pointerToCanvas(event.clientX, event.clientY);
    const target = findTargetAt(pointer.x, pointer.y);

    if (!target) {
      onSelectClip(null);
      onSelectTextOverlay(null);
      onBackgroundClick?.();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onDragStart();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (target.kind === 'pip') {
      onSelectClip(target.clipId);
      onSelectTextOverlay(null);
    } else {
      onSelectTextOverlay(target.overlayId);
      onSelectClip(null);
    }

    const clip =
      target.kind === 'pip'
        ? timelineClips.find((item) => item.id === target.clipId)
        : null;
    const overlay =
      target.kind === 'text'
        ? textOverlays.find((item) => item.id === target.overlayId)
        : null;

    const hasKeyframes =
      (clip && clipHasKeyframes(clip)) ||
      (overlay && textOverlayHasKeyframes(overlay));
    setKeyframeHint(
      hasKeyframes
        ? 'Position keyframes at the playhead are updated while dragging. Hold Alt to disable snapping.'
        : 'Hold Alt to disable snapping.',
    );

    const handle =
      target.kind === 'pip'
        ? hitTestResizeHandle(pointer.x, pointer.y, target.rect, HANDLE_SIZE / scaleX)
        : null;

    dragRef.current = {
      mode: handle ? 'resize' : 'move',
      target,
      handle: handle ?? undefined,
      startPointer: pointer,
      startRect: { ...target.rect },
      aspectRatio:
        target.kind === 'pip' && clip
          ? clipAspectRatio(clip) ?? target.rect.width / target.rect.height
          : 1,
      editedKeyframe: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const pointer = pointerToCanvas(event.clientX, event.clientY);

    if (!drag) {
      const target = findTargetAt(pointer.x, pointer.y);
      setHoverTarget(target);
      return;
    }

    event.preventDefault();
    const disableSnap = event.altKey;
    const constrainAspect = event.shiftKey;
    let nextRect: PixelRect;

    if (drag.mode === 'resize' && drag.handle && drag.target.kind === 'pip') {
      nextRect = resizePixelRect(
        drag.startRect,
        drag.handle,
        pointer.x,
        pointer.y,
        constrainAspect,
        drag.aspectRatio,
      );
    } else {
      const dx = pointer.x - drag.startPointer.x;
      const dy = pointer.y - drag.startPointer.y;
      nextRect = {
        ...drag.startRect,
        x: drag.startRect.x + dx,
        y: drag.startRect.y + dy,
      };
      if (drag.target.kind === 'text' && drag.target.scrolling) {
        nextRect.x = drag.startRect.x;
      }
    }

    const snapped = snapPixelRect(
      nextRect,
      { width: plan.canvasWidth, height: plan.canvasHeight },
      DEFAULT_SNAP_THRESHOLD_PX,
      disableSnap,
    );
    setSnapGuides(snapped.guides);
    commitRect(drag.target, snapped.rect, false);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setSnapGuides([]);
    setKeyframeHint(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dragRef.current = null;
        setSnapGuides([]);
        setKeyframeHint(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const renderOutline = (target: ManipulableTarget, selected: boolean) => {
    const { rect } = target;
    const style = {
      left: `${(rect.x / plan.canvasWidth) * 100}%`,
      top: `${(rect.y / plan.canvasHeight) * 100}%`,
      width: `${(rect.width / plan.canvasWidth) * 100}%`,
      height: `${(rect.height / plan.canvasHeight) * 100}%`,
    };
    return (
      <div
        key={`${target.kind}-${target.kind === 'pip' ? target.clipId : target.overlayId}`}
        className={
          selected
            ? 'preview-overlay-outline is-selected'
            : 'preview-overlay-outline is-hover'
        }
        style={style}
        aria-hidden="true"
      >
        {selected && target.kind === 'pip' && (
          <>
            <span className="preview-overlay-handle nw" />
            <span className="preview-overlay-handle ne" />
            <span className="preview-overlay-handle sw" />
            <span className="preview-overlay-handle se" />
          </>
        )}
      </div>
    );
  };

  return (
    <div
      ref={overlayRef}
      className="preview-overlay-manipulator"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {hoverTarget &&
        activeTarget !== hoverTarget &&
        renderOutline(hoverTarget, false)}
      {activeTarget && renderOutline(activeTarget, true)}
      {snapGuides.map((guide, index) => (
        <div
          key={`${guide.axis}-${guide.kind}-${guide.position}-${index}`}
          className={`preview-snap-guide is-${guide.axis} is-${guide.kind}`}
          style={
            guide.axis === 'x'
              ? { left: `${(guide.position / plan.canvasWidth) * 100}%` }
              : { top: `${(guide.position / plan.canvasHeight) * 100}%` }
          }
          aria-hidden="true"
        />
      ))}
      {keyframeHint && (
        <p className="preview-overlay-hint" role="status">
          {keyframeHint}
        </p>
      )}
    </div>
  );
}
