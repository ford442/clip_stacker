import type { RefObject } from "react";
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  RenderPlan,
  TextOverlay,
  Track,
} from "../types";
import { formatEncoderPathLabel } from "../utils/encoderPathLabel";
import { settingsStore } from "../store/settingsStore";
import { useStore } from "zustand";
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

export type AppShellProps = {
  toolbarRef: RefObject<{ triggerLoadDialog: () => void }>;
  selectedTextOverlayId: string | null;
  selectedClip: Clip | null;
  selectedClipId: string | null;
  timelineClips: Clip[];
  previewTotalDuration: number;
  morphProcessingIndex: number | null;
  showKeyboardShortcuts: boolean;
  showMemoryWarning: boolean;
  recoveryOffer: AutoSaveOffer | null;
  isRecovering: boolean;
  storageEndpoint: string;
  storageAuthToken: string;
  clips: Clip[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  renderFailureMessage: string | null;
  isRemoteSaving: boolean;
  isRemoteLoading: boolean;
  remoteLoadStage: string;
  remoteLoadProgress: number | null;
  remoteLoadIndeterminate: boolean;
  remoteUploadItems: RemoteUploadProgressEvent[];
  pendingRemoteUploadError: PendingRemoteUploadError | null;
  canUndo: boolean;
  canRedo: boolean;
  onAddClips: (files: File[]) => Promise<void>;
  onMerge: () => Promise<void>;
  onGpuStitch: () => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  onShowKeyboardShortcuts: () => void;
  onDebugResetFFmpeg: () => Promise<void>;
  onRetryFfmpegLoad: () => Promise<void>;
  onCopyDebugInfo: () => Promise<void>;
  onPerformRender: () => Promise<void>;
  onDismissRenderFailure: () => void;
  onStorageAuthTokenChange: (value: string) => void;
  onSaveRemote: (endpoint: string, authToken: string, projectName: string) => Promise<void>;
  onLoadRemote: (endpoint: string, authToken: string, projectName: string) => Promise<void>;
  onResolveRemoteUploadError: (action: "retry" | "skip" | "abort") => void;
  onAddLibraryClip: (item: MediaLibraryItem) => Promise<void>;
  onToggleVariant: (groupId: string, variant: "A" | "B") => void;
  onDeleteClip: (clipId: string) => void;
  onGenerateIntercut: (config: IntercutGeneratorConfig) => Promise<boolean>;
  onSelectClip: (id: string | null) => void;
  onSelectTextOverlay: (id: string | null) => void;
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
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  onMoveToTrack: (clipId: string, targetTrackId: string, startTime: number) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
  onAddTextOverlay: () => string;
  onUpdateTextOverlay: (overlay: TextOverlay) => void;
  onDeleteTextOverlay: (id: string) => void;
  onCloseKeyboardShortcuts: () => void;
  onMemoryWarningConfirm: () => void;
  onMemoryWarningCancel: () => void;
  onRecover: () => void;
  onDiscardRecovery: () => void;
};

export function AppShell(props: AppShellProps) {
  const {
    toolbarRef,
    renderFailureMessage,
    storageEndpoint,
    storageAuthToken,
    clips,
    tracks,
    clipGroups,
    transitions,
    textOverlays,
    selectedTextOverlayId,
    selectedClip,
    selectedClipId,
    timelineClips,
    previewTotalDuration,
    morphProcessingIndex,
    showKeyboardShortcuts,
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
    canUndo,
    canRedo,
    onAddClips,
    onMerge,
    onGpuStitch,
    onUndo,
    onRedo,
    onSaveProject,
    onLoadProject,
    onShowKeyboardShortcuts,
    onDebugResetFFmpeg,
    onRetryFfmpegLoad,
    onCopyDebugInfo,
    onPerformRender,
    onDismissRenderFailure,
    onStorageAuthTokenChange,
    onSaveRemote,
    onLoadRemote,
    onResolveRemoteUploadError,
    onAddLibraryClip,
    onToggleVariant,
    onDeleteClip,
    onGenerateIntercut,
    onSelectClip,
    onSelectTextOverlay,
    onClipLayoutCommit,
    onTextOverlayLayoutCommit,
    onPreviewDragStart,
    onInspectorChange,
    onKeyframesChange,
    onAutomationChange,
    onApplyKenBurns,
    onExtractAudio,
    onRife,
    onMoveUp,
    onMoveDown,
    onReorder,
    onMoveToTrack,
    onTransitionUpdate,
    onAddTextOverlay,
    onUpdateTextOverlay,
    onDeleteTextOverlay,
    onCloseKeyboardShortcuts,
    onMemoryWarningConfirm,
    onMemoryWarningCancel,
    onRecover,
    onDiscardRecovery,
  } = props;

  const {
    encoderPath,
    isRendering,
    renderPlan,
    exportSettings,
    finishing,
    outputUrl,
    ffmpegLoading,
    ffmpegFailed,
    forceFFmpeg,
    useCanvasRenderer,
    audioReactive,
    forceReencode,
    status,
    progressStage,
    progressValue,
    progressIndeterminate,
    rifeProcessingClipId,
    setFinishing,
    setForceFFmpeg,
    setUseCanvasRenderer,
    setAudioReactive,
    setForceReencode,
    setExportSettings,
  } = useStore(settingsStore);

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
          canUndo={canUndo}
          canRedo={canRedo}
          onSaveProject={onSaveProject}
          onLoadProject={onLoadProject}
          onShowKeyboardShortcuts={onShowKeyboardShortcuts}
          onDebugResetFFmpeg={onDebugResetFFmpeg}
          onRetryFfmpegLoad={onRetryFfmpegLoad}
          ffmpegLoading={ffmpegLoading}
          ffmpegLoadFailed={ffmpegFailed}
          onCopyDebugInfo={onCopyDebugInfo}
          status={status}
          forceFFmpeg={forceFFmpeg}
          onToggleForceFFmpeg={setForceFFmpeg}
          useCanvasRenderer={useCanvasRenderer}
          onToggleCanvasRenderer={setUseCanvasRenderer}
          audioReactive={audioReactive}
          onToggleAudioReactive={setAudioReactive}
          forceReencode={forceReencode}
          onToggleForceReencode={setForceReencode}
          progressStage={progressStage}
          progressValue={progressValue}
          progressIndeterminate={progressIndeterminate}
          isRendering={isRendering}
          renderPlan={renderPlan}
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
          endpoint={storageEndpoint}
          authToken={storageAuthToken}
          onAuthTokenChange={onStorageAuthTokenChange}
          onSaveRemote={onSaveRemote}
          onLoadRemote={onLoadRemote}
          isRemoteSaving={isRemoteSaving}
          isRemoteLoading={isRemoteLoading}
          remoteLoadStage={remoteLoadStage}
          remoteLoadProgress={remoteLoadProgress}
          remoteLoadIndeterminate={remoteLoadIndeterminate}
          remoteUploadItems={remoteUploadItems}
          pendingRemoteUploadError={pendingRemoteUploadError}
          onResolveRemoteUploadError={onResolveRemoteUploadError as any}
        />
        <MediaLibraryPanel
          endpoint={storageEndpoint}
          authToken={storageAuthToken}
          onAddClip={onAddLibraryClip}
        />
      </section>

      <section className="layout-grid">
        <ClipLibrary
          onToggleVariant={onToggleVariant}
          onDelete={onDeleteClip}
          onGenerateIntercut={onGenerateIntercut}
        />
        <Preview
          clip={selectedClip}
          timelineClips={timelineClips}
          tracks={tracks}
          clipGroups={clipGroups}
          transitions={transitions}
          textOverlays={textOverlays}
          exportSettings={exportSettings}
          finishing={finishing}
          outputUrl={outputUrl}
          exportFilename={exportSettings.filename}
          selectedClipId={selectedClipId}
          selectedTextOverlayId={selectedTextOverlayId}
          onSelectClip={onSelectClip}
          onSelectTextOverlay={onSelectTextOverlay}
          onClipLayoutCommit={onClipLayoutCommit}
          onTextOverlayLayoutCommit={onTextOverlayLayoutCommit}
          onPreviewDragStart={onPreviewDragStart}
        />
        <Inspector
          exportSettings={exportSettings}
          finishing={finishing}
          onFinishingChange={setFinishing}
          onChange={onInspectorChange}
          onKeyframesChange={onKeyframesChange}
          onAutomationChange={onAutomationChange}
          onApplyKenBurns={onApplyKenBurns}
          onExportSettingsChange={setExportSettings}
          onExtractAudio={onExtractAudio}
          onRife={onRife}
          rifeProcessing={rifeProcessingClipId !== null}
        />
      </section>

      <Timeline
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onReorder={onReorder}
        onMoveToTrack={onMoveToTrack}
        onTransitionUpdate={onTransitionUpdate}
        onDelete={onDeleteClip}
        morphProcessingIndex={morphProcessingIndex}
      />

      <TextOverlayPanel
        totalDuration={previewTotalDuration}
        exportSettings={exportSettings}
        selectedOverlayId={selectedTextOverlayId}
        onSelectOverlay={onSelectTextOverlay}
        onAdd={onAddTextOverlay}
        onUpdate={onUpdateTextOverlay}
        onDelete={onDeleteTextOverlay}
      />

      <KeyboardShortcutsModal
        isOpen={showKeyboardShortcuts}
        onClose={onCloseKeyboardShortcuts}
      />

      <MemoryWarningModal
        isOpen={showMemoryWarning}
        clips={clips}
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
