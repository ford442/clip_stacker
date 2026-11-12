import { useRef, type RefObject } from "react";
import type { Clip, ClipTransition, CleanupOptions, TextOverlay, VideoOutputFormat } from "../types";
import type { CaptionsPanelProps } from "./CaptionsPanel";
import { formatEncoderPathLabel } from "../export/encoderPathLabel";
import { uiActions } from "../store";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ClipValues } from "../types";
import type { PendingRemoteUploadError } from "../hooks/useProjectSaveLoad";
import type { AutoSaveOffer } from "../project/autoSave";
import type { MediaLibraryItem, RemoteUploadProgressEvent } from "../project";
import type { IntercutGeneratorConfig } from "../ffmpeg/intercutGenerator";
import type { BatchProcessingOptions } from "../remote/batchClipProcessing";
import { Toolbar } from "./Toolbar";
import { StorageRow } from "./StorageRow";
import { MediaLibraryPanel } from "./MediaLibraryPanel";
import { ClipLibrary } from "./ClipLibrary";
import { Preview } from "./Preview";
import { Inspector } from "./Inspector";
import { Timeline } from "./Timeline";
import { TextOverlayPanel } from "./TextOverlayPanel";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { MemoryWarningModal } from "./MemoryWarningModal";
import { RecoveryModal } from "./RecoveryModal";
import { LazyBoundary, lazyNamed } from "./LazyBoundary";
import {
  CollapsedRail,
  PanelSplitter,
  TimelineSplitter,
  WORKSPACE_ZONE_IDS,
  WorkspaceControls,
} from "./WorkspaceChrome";
import { useWorkspaceLayoutVars } from "../hooks/useWorkspaceLayoutVars";
import { renderJobStore } from '../store/renderJobStore';

// Only shown after a failed render, and it reads the FFmpeg runtime's logs, so
// it loads with that runtime rather than with the shell.
const RenderFailurePanel = lazyNamed(
  () => import("./RenderFailurePanel"),
  "RenderFailurePanel",
);

/**
 * Props are limited to things the panels cannot get for themselves: the
 * imperative toolbar ref, callbacks owned by App's action hooks, and the
 * transient async state those hooks expose (remote transfer progress, recovery
 * offer, render failure), grouped by domain. Each bundle keeps its identity
 * while its members do (`useStableObject`), so a panel re-renders exactly as
 * it would with one prop per callback. Clip, timeline, selection, settings
 * and render state are read from the Zustand stores by whichever panel
 * renders them, so an edit never re-renders this shell (#144).
 */
export interface HistoryBundle {
  onUndo: () => void;
  onRedo: () => void;
}

export interface ProjectBundle {
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  onSaveRemote: (endpoint: string, authToken: string, projectName: string) => Promise<void>;
  onLoadRemote: (endpoint: string, authToken: string, projectName: string) => Promise<void>;
  onResolveRemoteUploadError: (action: "retry" | "skip" | "abort") => void;
  isRemoteSaving: boolean;
  isRemoteLoading: boolean;
  remoteLoadStage: string;
  remoteLoadProgress: number | null;
  remoteLoadIndeterminate: boolean;
  remoteUploadItems: RemoteUploadProgressEvent[];
  pendingRemoteUploadError: PendingRemoteUploadError | null;
  recoveryOffer: AutoSaveOffer | null;
  isRecovering: boolean;
  onRecover: () => void;
  onDiscardRecovery: () => void;
}

export interface RenderBundle {
  onMerge: () => Promise<void>;
  onGpuStitch: () => Promise<void>;
  onDebugResetFFmpeg: () => Promise<void>;
  onRetryFfmpegLoad: () => Promise<void>;
  onCopyDebugInfo: () => Promise<void>;
  onPerformRender: () => Promise<void>;
  renderFailureMessage: string | null;
  onDismissRenderFailure: () => void;
  showMemoryWarning: boolean;
  onMemoryWarningConfirm: () => void;
  onMemoryWarningCancel: () => void;
}

export interface ClipBundle {
  onAddClips: (files: File[]) => Promise<void>;
  onAddLibraryClip: (item: MediaLibraryItem) => Promise<void>;
  onToggleVariant: (groupId: string, variant: "A" | "B") => void;
  onDeleteClip: (clipId: string) => void;
  onGenerateIntercut: (config: IntercutGeneratorConfig) => Promise<boolean>;
  onBatchProcess: (clipIds: string[], options: BatchProcessingOptions) => Promise<boolean>;
}

export interface PreviewBundle {
  onClipLayoutCommit: (clipId: string, clip: Clip, editedKeyframe: boolean) => void;
  onTextOverlayLayoutCommit: (
    overlayId: string,
    overlay: TextOverlay,
    editedKeyframe: boolean,
  ) => void;
  onPreviewDragStart: () => void;
}

export interface InspectorBundle {
  onInspectorChange: (values: ClipValues) => void;
  onKeyframesChange: (keyframes: Clip["keyframes"]) => void;
  onAutomationChange: (automation: Clip["automation"]) => void;
  onAudioEffectsChange: (clipId: string, effects: Clip["audioEffects"]) => void;
  onApplyKenBurns: () => void;
  onExtractAudio: () => Promise<void>;
  onRife: (
    mode: "interpolation" | "boomerang",
    multiplier: 2 | 4,
    outputFormat?: VideoOutputFormat,
    cleanup?: CleanupOptions,
  ) => Promise<void>;
  onStabilizeChange: (enabled: boolean) => void;
  onReverseChange: (enabled: boolean) => void;
}

export interface TimelineBundle {
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  onMoveToTrack: (
    clipId: string,
    targetTrackId: string,
    startTime: number,
    snapThresholdSec?: number,
  ) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
  /** Retime one edge of a caption cue from the timeline's CC lane. */
  onCaptionResize: (id: string, edge: "start" | "end", timeSec: number) => void;
  morphProcessingIndex: number | null;
}

export interface TextOverlayBundle {
  onAddTextOverlay: () => string;
  onUpdateTextOverlay: (overlay: TextOverlay) => void;
  onDeleteTextOverlay: (id: string) => void;
}

export type AppShellProps = {
  toolbarRef: RefObject<{ triggerLoadDialog: () => void }>;
  history: HistoryBundle;
  project: ProjectBundle;
  render: RenderBundle;
  clips: ClipBundle;
  preview: PreviewBundle;
  inspector: InspectorBundle;
  timeline: TimelineBundle;
  /** Caption-track callbacks, forwarded to the Inspector's Captions tab. */
  captions: CaptionsPanelProps;
  textOverlays: TextOverlayBundle;
};

export function AppShell({
  toolbarRef,
  history,
  project,
  render,
  clips,
  preview,
  inspector,
  timeline,
  captions,
  textOverlays,
}: AppShellProps) {
  const { onUndo, onRedo } = history;
  const {
    onSaveProject,
    onLoadProject,
    onSaveRemote,
    onLoadRemote,
    onResolveRemoteUploadError,
    isRemoteSaving,
    isRemoteLoading,
    remoteLoadStage,
    remoteLoadProgress,
    remoteLoadIndeterminate,
    remoteUploadItems,
    pendingRemoteUploadError,
    recoveryOffer,
    isRecovering,
    onRecover,
    onDiscardRecovery,
  } = project;
  const {
    onMerge,
    onGpuStitch,
    onDebugResetFFmpeg,
    onRetryFfmpegLoad,
    onCopyDebugInfo,
    onPerformRender,
    renderFailureMessage,
    onDismissRenderFailure,
    showMemoryWarning,
    onMemoryWarningConfirm,
    onMemoryWarningCancel,
  } = render;
  const {
    onAddClips,
    onAddLibraryClip,
    onToggleVariant,
    onDeleteClip,
    onGenerateIntercut,
    onBatchProcess,
  } = clips;
  const { onClipLayoutCommit, onTextOverlayLayoutCommit, onPreviewDragStart } = preview;
  const {
    onInspectorChange,
    onKeyframesChange,
    onAutomationChange,
    onAudioEffectsChange,
    onApplyKenBurns,
    onExtractAudio,
    onRife,
    onStabilizeChange,
    onReverseChange,
  } = inspector;
  const {
    onMoveUp,
    onMoveDown,
    onReorder,
    onMoveToTrack,
    onTransitionUpdate,
    onCaptionResize,
    morphProcessingIndex,
  } = timeline;
  const { onAddTextOverlay, onUpdateTextOverlay, onDeleteTextOverlay } = textOverlays;

  // Only the three fields this shell itself renders — a progress tick during a
  // render must not re-render every panel below.
  const { encoderPath, isRendering, renderPlan } = useStore(
    renderJobStore,
    useShallow((s) => ({
      encoderPath: s.encoderPath,
      isRendering: s.isRendering,
      renderPlan: s.renderPlan,
    })),
  );

  // Panel sizes arrive as CSS variables on the shell (no re-render here).
  const shellRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  useWorkspaceLayoutVars(shellRef);

  return (
    <main className="app-shell" ref={shellRef}>
      <header className="app-header">
        <h1>clip_stacker</h1>
        <p>Upload, trim, reorder, fade, and merge clips into one MP4.</p>
        {encoderPath && (
          <span className="encoder-used-badge">
            Last export: {formatEncoderPathLabel(encoderPath)}
          </span>
        )}
        <WorkspaceControls />
      </header>

      <section className="panel">
        <Toolbar
          ref={toolbarRef}
          onAddClips={onAddClips}
          onMerge={onMerge}
          onGpuStitch={onGpuStitch}
          onUndo={onUndo}
          onRedo={onRedo}
          onSaveProject={onSaveProject}
          onLoadProject={onLoadProject}
          onShowKeyboardShortcuts={() => uiActions.setShowKeyboardShortcuts(true)}
          onDebugResetFFmpeg={onDebugResetFFmpeg}
          onRetryFfmpegLoad={onRetryFfmpegLoad}
          onCopyDebugInfo={onCopyDebugInfo}
        />
        {renderFailureMessage && !isRendering && (
          <LazyBoundary
            label="Render failure details"
            fallback={<p className="muted" role="alert">{renderFailureMessage}</p>}
          >
            <RenderFailurePanel
              message={renderFailureMessage}
              renderPlan={renderPlan}
              onCopyDebug={onCopyDebugInfo}
              onRetry={() => {
                onDismissRenderFailure();
                void onPerformRender();
              }}
              onDismiss={onDismissRenderFailure}
            />
          </LazyBoundary>
        )}
        <StorageRow
          onSaveRemote={onSaveRemote}
          onLoadRemote={onLoadRemote}
          isRemoteSaving={isRemoteSaving}
          isRemoteLoading={isRemoteLoading}
          remoteLoadStage={remoteLoadStage}
          remoteLoadProgress={remoteLoadProgress}
          remoteLoadIndeterminate={remoteLoadIndeterminate}
          remoteUploadItems={remoteUploadItems}
          pendingRemoteUploadError={pendingRemoteUploadError}
          onResolveRemoteUploadError={onResolveRemoteUploadError}
        />
        <MediaLibraryPanel onAddClip={onAddLibraryClip} onAddFiles={onAddClips} />
      </section>

      <section className="layout-grid" ref={gridRef}>
        <div className="workspace-zone workspace-zone--library" id={WORKSPACE_ZONE_IDS.library}>
          <CollapsedRail side="library" />
          <ClipLibrary
            onToggleVariant={onToggleVariant}
            onDelete={onDeleteClip}
            onGenerateIntercut={onGenerateIntercut}
            onBatchProcess={onBatchProcess}
          />
        </div>
        <PanelSplitter side="library" gridRef={gridRef} />
        <div className="workspace-zone workspace-zone--preview" id={WORKSPACE_ZONE_IDS.preview}>
          <Preview
            onClipLayoutCommit={onClipLayoutCommit}
            onTextOverlayLayoutCommit={onTextOverlayLayoutCommit}
            onPreviewDragStart={onPreviewDragStart}
          />
        </div>
        <PanelSplitter side="inspector" gridRef={gridRef} />
        <div className="workspace-zone workspace-zone--inspector" id={WORKSPACE_ZONE_IDS.inspector}>
          <CollapsedRail side="inspector" />
          <Inspector
            onChange={onInspectorChange}
            onKeyframesChange={onKeyframesChange}
            onAutomationChange={onAutomationChange}
            onAudioEffectsChange={onAudioEffectsChange}
            onApplyKenBurns={onApplyKenBurns}
            onExtractAudio={onExtractAudio}
            onRife={onRife}
            onStabilizeChange={onStabilizeChange}
            onReverseChange={onReverseChange}
            captions={captions}
          />
        </div>
      </section>

      <TimelineSplitter gridRef={gridRef} shellRef={shellRef} />

      <div className="workspace-timeline" id={WORKSPACE_ZONE_IDS.timeline}>
        <Timeline
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onReorder={onReorder}
          onMoveToTrack={onMoveToTrack}
          onTransitionUpdate={onTransitionUpdate}
          onDelete={onDeleteClip}
          onCaptionResize={onCaptionResize}
          onCaptionAdd={captions.onAdd}
          morphProcessingIndex={morphProcessingIndex}
        />
      </div>

      <TextOverlayPanel
        onAdd={onAddTextOverlay}
        onUpdate={onUpdateTextOverlay}
        onDelete={onDeleteTextOverlay}
      />

      <KeyboardShortcutsModal />

      <MemoryWarningModal
        isOpen={showMemoryWarning}
        onConfirm={onMemoryWarningConfirm}
        onCancel={onMemoryWarningCancel}
      />

      {recoveryOffer && (
        <RecoveryModal
          isOpen
          savedAt={recoveryOffer.savedAt}
          clipCount={recoveryOffer.clipCount}
          textOverlayCount={recoveryOffer.textOverlayCount}
          embeddedClipCount={recoveryOffer.embeddedClipCount}
          referenceOnlyClipCount={recoveryOffer.referenceOnlyClipCount}
          unrecoverableLocalClipCount={recoveryOffer.unrecoverableLocalClipCount}
          isRecovering={isRecovering}
          onRecover={onRecover}
          onDiscard={onDiscardRecovery}
        />
      )}
    </main>
  );
}
