import type { RefObject } from "react";
import type { Clip, ClipTransition, TextOverlay } from "../types";
import type { CaptionsPanelProps } from "./CaptionsPanel";
import { formatEncoderPathLabel } from "../utils/encoderPathLabel";
import { settingsStore, uiActions } from "../store";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ClipValues } from "./Inspector";
import type { PendingRemoteUploadError } from "../hooks/useProjectSaveLoad";
import type { AutoSaveOffer } from "../utils/autoSave";
import type { MediaLibraryItem, RemoteUploadProgressEvent } from "../utils/project";
import type { IntercutGeneratorConfig } from "../ffmpeg/intercutGenerator";
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
import { RenderFailurePanel } from "./RenderFailurePanel";

/**
 * Props are limited to things the panels cannot get for themselves: the
 * imperative toolbar ref, callbacks owned by App's action hooks, and the
 * transient async state those hooks expose (remote transfer progress, recovery
 * offer, render failure). Clip, timeline, selection, settings and render state
 * are read from the Zustand stores by whichever panel renders them, so an edit
 * never re-renders this shell (#144).
 */
export type AppShellProps = {
  toolbarRef: RefObject<{ triggerLoadDialog: () => void }>;
  morphProcessingIndex: number | null;
  showMemoryWarning: boolean;
  recoveryOffer: AutoSaveOffer | null;
  isRecovering: boolean;
  renderFailureMessage: string | null;
  isRemoteSaving: boolean;
  isRemoteLoading: boolean;
  remoteLoadStage: string;
  remoteLoadProgress: number | null;
  remoteLoadIndeterminate: boolean;
  remoteUploadItems: RemoteUploadProgressEvent[];
  pendingRemoteUploadError: PendingRemoteUploadError | null;
  onAddClips: (files: File[]) => Promise<void>;
  onMerge: () => Promise<void>;
  onGpuStitch: () => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  onDebugResetFFmpeg: () => Promise<void>;
  onRetryFfmpegLoad: () => Promise<void>;
  onCopyDebugInfo: () => Promise<void>;
  onPerformRender: () => Promise<void>;
  onDismissRenderFailure: () => void;
  onSaveRemote: (endpoint: string, authToken: string, projectName: string) => Promise<void>;
  onLoadRemote: (endpoint: string, authToken: string, projectName: string) => Promise<void>;
  onResolveRemoteUploadError: (action: "retry" | "skip" | "abort") => void;
  onAddLibraryClip: (item: MediaLibraryItem) => Promise<void>;
  onToggleVariant: (groupId: string, variant: "A" | "B") => void;
  onDeleteClip: (clipId: string) => void;
  onGenerateIntercut: (config: IntercutGeneratorConfig) => Promise<boolean>;
  onClipLayoutCommit: (clipId: string, clip: Clip, editedKeyframe: boolean) => void;
  onTextOverlayLayoutCommit: (
    overlayId: string,
    overlay: TextOverlay,
    editedKeyframe: boolean,
  ) => void;
  onPreviewDragStart: () => void;
  onInspectorChange: (values: ClipValues) => void;
  onKeyframesChange: (keyframes: Clip["keyframes"]) => void;
  onAutomationChange: (automation: Clip["automation"]) => void;
  onApplyKenBurns: () => void;
  onExtractAudio: () => Promise<void>;
  onRife: (mode: "interpolation" | "boomerang", multiplier: 2 | 4) => Promise<void>;
  onStabilizeChange: (enabled: boolean) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  onMoveToTrack: (clipId: string, targetTrackId: string, startTime: number) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
  /** Caption-track callbacks, forwarded to the Inspector's Captions tab. */
  captions: CaptionsPanelProps;
  /** Retime one edge of a caption cue from the timeline's CC lane. */
  onCaptionResize: (id: string, edge: "start" | "end", timeSec: number) => void;
  onAddTextOverlay: () => string;
  onUpdateTextOverlay: (overlay: TextOverlay) => void;
  onDeleteTextOverlay: (id: string) => void;
  onMemoryWarningConfirm: () => void;
  onMemoryWarningCancel: () => void;
  onRecover: () => void;
  onDiscardRecovery: () => void;
};

export function AppShell(props: AppShellProps) {
  const {
    toolbarRef,
    renderFailureMessage,
    morphProcessingIndex,
    showMemoryWarning,
    recoveryOffer,
    isRecovering,
    isRemoteSaving,
    isRemoteLoading,
    remoteLoadStage,
    remoteLoadProgress,
    remoteLoadIndeterminate,
    remoteUploadItems,
    pendingRemoteUploadError,
    onAddClips,
    onMerge,
    onGpuStitch,
    onUndo,
    onRedo,
    onSaveProject,
    onLoadProject,
    onDebugResetFFmpeg,
    onRetryFfmpegLoad,
    onCopyDebugInfo,
    onPerformRender,
    onDismissRenderFailure,
    onSaveRemote,
    onLoadRemote,
    onResolveRemoteUploadError,
    onAddLibraryClip,
    onToggleVariant,
    onDeleteClip,
    onGenerateIntercut,
    onClipLayoutCommit,
    onTextOverlayLayoutCommit,
    onPreviewDragStart,
    onInspectorChange,
    onKeyframesChange,
    onAutomationChange,
    onApplyKenBurns,
    onExtractAudio,
    onRife,
    onStabilizeChange,
    onMoveUp,
    onMoveDown,
    onReorder,
    onMoveToTrack,
    onTransitionUpdate,
    captions,
    onCaptionResize,
    onAddTextOverlay,
    onUpdateTextOverlay,
    onDeleteTextOverlay,
    onMemoryWarningConfirm,
    onMemoryWarningCancel,
    onRecover,
    onDiscardRecovery,
  } = props;

  // Only the three fields this shell itself renders — a progress tick during a
  // render must not re-render every panel below.
  const { encoderPath, isRendering, renderPlan } = useStore(
    settingsStore,
    useShallow((s) => ({
      encoderPath: s.encoderPath,
      isRendering: s.isRendering,
      renderPlan: s.renderPlan,
    })),
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>clip_stacker</h1>
        <p>Upload, trim, reorder, fade, and merge clips into one MP4.</p>
        {encoderPath && (
          <span className="encoder-used-badge">
            Last export: {formatEncoderPathLabel(encoderPath)}
          </span>
        )}
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
        <MediaLibraryPanel onAddClip={onAddLibraryClip} />
      </section>

      <section className="layout-grid">
        <ClipLibrary
          onToggleVariant={onToggleVariant}
          onDelete={onDeleteClip}
          onGenerateIntercut={onGenerateIntercut}
        />
        <Preview
          onClipLayoutCommit={onClipLayoutCommit}
          onTextOverlayLayoutCommit={onTextOverlayLayoutCommit}
          onPreviewDragStart={onPreviewDragStart}
        />
        <Inspector
          onChange={onInspectorChange}
          onKeyframesChange={onKeyframesChange}
          onAutomationChange={onAutomationChange}
          onApplyKenBurns={onApplyKenBurns}
          onExtractAudio={onExtractAudio}
          onRife={onRife}
          onStabilizeChange={onStabilizeChange}
          captions={captions}
        />
      </section>

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
