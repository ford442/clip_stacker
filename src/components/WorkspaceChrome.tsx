import { memo, useCallback, useRef, type RefObject } from 'react';
import {
  layoutActions,
  layoutStore,
  useLayoutDensity,
  useLayoutFullWidth,
  useSideCollapsed,
  useSideWidth,
  useUpperHeight,
} from '../store/layoutStore';
import {
  WORKSPACE_LIMITS,
  clampSideWidth,
  resizeSideByDrag,
  resizeVerticalSplit,
  sideLimits,
  type LayoutDensity,
  type WorkspaceSide,
} from '../utils/workspaceLayout';
import { Splitter } from './Splitter';

/**
 * The Cubase-style zone chrome around the panels: column splitters, the
 * upper-zone / timeline divider, collapsed-panel rails and the header's
 * layout controls. Each piece subscribes to just the layout field it shows;
 * the sizes reach the grid as CSS variables (`useWorkspaceLayoutVars`), so
 * resizing never re-renders the Library, Preview, Inspector or Timeline.
 */

export const WORKSPACE_ZONE_IDS = {
  library: 'workspace-library',
  preview: 'workspace-preview',
  inspector: 'workspace-inspector',
  timeline: 'workspace-timeline',
} as const;

const SIDE_LABEL: Record<WorkspaceSide, string> = {
  library: 'Library',
  inspector: 'Inspector',
};

/** Laid-out width of a zone, or undefined when it is missing or not laid out. */
function renderedWidth(id: string): number | undefined {
  const width = document.getElementById(id)?.getBoundingClientRect().width;
  return width && width > 0 ? width : undefined;
}

/** Column splitter on the inner edge of the Library or the Inspector. */
export const PanelSplitter = memo(function PanelSplitter({
  side,
  gridRef,
}: {
  side: WorkspaceSide;
  gridRef: RefObject<HTMLElement>;
}) {
  const width = useSideWidth(side);
  const collapsed = useSideCollapsed(side);
  const startRef = useRef<{ width: number; gridWidth?: number; otherWidth?: number } | null>(
    null,
  );

  const snapshot = useCallback(() => {
    const other: WorkspaceSide = side === 'library' ? 'inspector' : 'library';
    // Start from the rendered width: CSS caps a side at a share of the grid,
    // so the stored value can be wider than what is on screen.
    return {
      width: renderedWidth(WORKSPACE_ZONE_IDS[side]) ?? layoutStore.getState()[`${side}Width`],
      gridWidth: gridRef.current?.getBoundingClientRect().width,
      otherWidth: renderedWidth(WORKSPACE_ZONE_IDS[other]),
    };
  }, [gridRef, side]);

  const onResizeStart = useCallback(() => {
    startRef.current = snapshot();
  }, [snapshot]);

  const onResizeBy = useCallback(
    (delta: number) => {
      const start = startRef.current;
      if (!start) return;
      layoutActions.setSideWidth(side, resizeSideByDrag(side, start.width, delta, start));
    },
    [side],
  );

  const onStep = useCallback(
    (delta: number) => {
      const start = snapshot();
      layoutActions.setSideWidth(side, resizeSideByDrag(side, start.width, delta, start));
    },
    [side, snapshot],
  );

  const onStepTo = useCallback(
    (edge: 'min' | 'max') => {
      const start = snapshot();
      const target = edge === 'min' ? sideLimits(side).min : Number.MAX_SAFE_INTEGER;
      layoutActions.setSideWidth(side, clampSideWidth(side, target, start));
    },
    [side, snapshot],
  );

  const onReset = useCallback(() => layoutActions.resetSideWidth(side), [side]);
  const onToggle = useCallback(() => layoutActions.toggleSideCollapsed(side), [side]);

  if (collapsed) return null;
  const { min, max } = sideLimits(side);
  return (
    <Splitter
      orientation="vertical"
      className={`workspace-splitter--${side}`}
      label={`Resize ${SIDE_LABEL[side]} panel`}
      controls={WORKSPACE_ZONE_IDS[side]}
      value={width}
      min={min}
      max={max}
      onResizeStart={onResizeStart}
      onResizeBy={onResizeBy}
      onStep={onStep}
      onStepTo={onStepTo}
      onReset={onReset}
      onToggle={onToggle}
    />
  );
});

/**
 * Divider between the Library | Preview | Inspector zone and the timeline.
 * Dragging trades height between the two (see `resizeVerticalSplit`).
 */
export const TimelineSplitter = memo(function TimelineSplitter({
  gridRef,
  shellRef,
}: {
  gridRef: RefObject<HTMLElement>;
  shellRef: RefObject<HTMLElement>;
}) {
  const upperHeight = useUpperHeight();
  const startRef = useRef<{ upperHeight: number; timelineHeight: number | null } | null>(null);

  const snapshot = useCallback(() => {
    const s = layoutStore.getState();
    const scroll = shellRef.current?.querySelector<HTMLElement>('.timeline-scroll-container');
    return {
      upperHeight:
        s.upperHeight ??
        gridRef.current?.getBoundingClientRect().height ??
        WORKSPACE_LIMITS.upperMin,
      timelineHeight: s.timelineHeight ?? (scroll ? scroll.getBoundingClientRect().height : null),
    };
  }, [gridRef, shellRef]);

  const apply = useCallback(
    (start: { upperHeight: number; timelineHeight: number | null }, delta: number) => {
      const next = resizeVerticalSplit(start, delta);
      layoutActions.setVerticalSplit(next.upperHeight, next.timelineHeight);
    },
    [],
  );

  const onResizeStart = useCallback(() => {
    startRef.current = snapshot();
  }, [snapshot]);
  const onResizeBy = useCallback(
    (delta: number) => {
      if (startRef.current) apply(startRef.current, delta);
    },
    [apply],
  );
  const onStep = useCallback((delta: number) => apply(snapshot(), delta), [apply, snapshot]);
  const onStepTo = useCallback(
    (edge: 'min' | 'max') =>
      apply(snapshot(), edge === 'min' ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER),
    [apply, snapshot],
  );

  return (
    <Splitter
      orientation="horizontal"
      className="workspace-splitter--timeline"
      label="Resize preview area and timeline"
      controls={WORKSPACE_ZONE_IDS.timeline}
      value={upperHeight ?? undefined}
      min={WORKSPACE_LIMITS.upperMin}
      max={WORKSPACE_LIMITS.upperMax}
      onResizeStart={onResizeStart}
      onResizeBy={onResizeBy}
      onStep={onStep}
      onStepTo={onStepTo}
      onReset={layoutActions.resetVerticalSplit}
    />
  );
});

/** Narrow strip a collapsed side panel leaves behind; click to bring it back. */
export const CollapsedRail = memo(function CollapsedRail({ side }: { side: WorkspaceSide }) {
  const collapsed = useSideCollapsed(side);
  if (!collapsed) return null;
  return (
    <button
      type="button"
      className={`workspace-rail workspace-rail--${side}`}
      aria-expanded={false}
      aria-controls={WORKSPACE_ZONE_IDS[side]}
      title={`Show ${SIDE_LABEL[side]}`}
      onClick={() => layoutActions.setSideCollapsed(side, false)}
    >
      <span className="workspace-rail-label">{SIDE_LABEL[side]}</span>
    </button>
  );
});

const DENSITIES: { id: LayoutDensity; label: string; title: string }[] = [
  { id: 'compact', label: 'S', title: 'Compact — smallest controls, most room for media' },
  { id: 'comfortable', label: 'M', title: 'Comfortable — default control size' },
  { id: 'spacious', label: 'L', title: 'Spacious — larger controls and hit targets' },
];

function SideToggle({ side }: { side: WorkspaceSide }) {
  const collapsed = useSideCollapsed(side);
  return (
    <button
      type="button"
      className={`workspace-control-btn${collapsed ? '' : ' is-active'}`}
      aria-pressed={!collapsed}
      aria-controls={WORKSPACE_ZONE_IDS[side]}
      title={`${collapsed ? 'Show' : 'Hide'} the ${SIDE_LABEL[side]} panel`}
      onClick={() => layoutActions.toggleSideCollapsed(side)}
    >
      {SIDE_LABEL[side]}
    </button>
  );
}

/** Header controls: zone toggles, density, full width, reset. */
export const WorkspaceControls = memo(function WorkspaceControls() {
  const density = useLayoutDensity();
  const fullWidth = useLayoutFullWidth();
  return (
    <div className="workspace-controls" role="toolbar" aria-label="Workspace layout">
      <div className="workspace-control-group" role="group" aria-label="Panels">
        <SideToggle side="library" />
        <SideToggle side="inspector" />
      </div>
      <div className="workspace-control-group" role="group" aria-label="Control size">
        {DENSITIES.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`workspace-control-btn${density === d.id ? ' is-active' : ''}`}
            aria-pressed={density === d.id}
            aria-label={`${d.id[0].toUpperCase()}${d.id.slice(1)} controls`}
            title={d.title}
            onClick={() => layoutActions.setDensity(d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="workspace-control-group" role="group" aria-label="Window">
        <button
          type="button"
          className={`workspace-control-btn${fullWidth ? ' is-active' : ''}`}
          aria-pressed={fullWidth}
          title={fullWidth ? 'Centre the workspace at 1440px' : 'Fill the window width'}
          onClick={() => layoutActions.setFullWidth(!fullWidth)}
        >
          Full width
        </button>
        <button
          type="button"
          className="workspace-control-btn"
          title="Restore the default panel sizes, timeline height and control size"
          onClick={layoutActions.resetLayout}
        >
          Reset layout
        </button>
      </div>
    </div>
  );
});
