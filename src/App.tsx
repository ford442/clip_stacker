import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeTotalDuration } from "./utils/transitions";
import { useProjectSaveLoad } from "./hooks/useProjectSaveLoad";
import { useEditHistory } from "./hooks/useEditHistory";
import { useAutoSave } from "./hooks/useAutoSave";
import { useClipBeatAnalysis } from "./hooks/useClipBeatAnalysis";
import { useClipImportChores } from "./hooks/useClipImportChores";
import { getEffectiveTimelineClips } from "./utils/timelineClips";
import {
  readStorageAuthToken,
  writeStorageAuthToken,
} from "./utils/storageAuth";
import { setPlayheadTime } from "./store";
import { useClipActions } from "./hooks/useClipActions";
import { useIntercutActions } from "./hooks/useIntercutActions";
import { useRenderActions } from "./hooks/useRenderActions";
import { useInspectorActions } from "./hooks/useInspectorActions";
import { useTimelineActions } from "./hooks/useTimelineActions";
import { useTransitionActions } from "./hooks/useTransitionActions";
import {
  useTextOverlayActions,
  useLayoutCommitHandlers,
} from "./hooks/useTextOverlayActions";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { AppShell } from "./components/AppShell";

export function App() {
  const {
    clips,
    tracks,
    clipGroups,
    transitions,
    textOverlays,
    selectedClipId,
    setClips,
    setTracks,
    setClipGroups,
    setTransitions,
    setTextOverlays,
    setSelectedClipId,
    pushHistory,
    pushHistoryDebounced,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
  } = useEditHistory();
  useClipBeatAnalysis(clips, setClips);
  useClipImportChores(clips, setClips);
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [selectedTextOverlayId, setSelectedTextOverlayId] = useState<string | null>(null);

  const {
    handleSaveProject,
    handleLoadProject,
    handleSaveRemote,
    handleLoadRemote,
    isRemoteSaving,
    isRemoteLoading,
    remoteLoadStage,
    remoteLoadProgress,
    remoteLoadIndeterminate,
    remoteUploadItems,
    pendingRemoteUploadError,
    resolveRemoteUploadError,
  } = useProjectSaveLoad({
    clips,
    tracks,
    clipGroups,
    transitions,
    textOverlays,
    setClips,
    setClipGroups,
    setSelectedClipId,
    setTransitions,
    setTextOverlays,
    resetHistory,
  });

  const {
    recoveryOffer,
    isRecovering,
    handleRecover,
    handleDiscardRecovery,
  } = useAutoSave({
    clips,
    tracks,
    clipGroups,
    transitions,
    textOverlays,
    selectedClipId,
    resetHistory,
    enabled: true, // We don't have isRendering easily here anymore, but AutoSave has its own debounce
  });

  const toolbarRef = useRef<{ triggerLoadDialog: () => void }>(null!);

  const [storageEndpoint, setStorageEndpoint] = useState(
    "https://storage.noahcohn.com/webhook/clip-stacker",
  );
  const [storageAuthToken, setStorageAuthToken] = useState(readStorageAuthToken);
  const handleStorageAuthTokenChange = useCallback((value: string) => {
    setStorageAuthToken(value);
    writeStorageAuthToken(value);
  }, []);

  useEffect(() => {
    if (!selectedClipId) {
      setPlayheadTime(null);
      return;
    }
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return;
    setPlayheadTime(clip.trimStart);
  }, [selectedClipId, clips]);

  const clipActions = useClipActions({
    clips,
    selectedClipId,
    setClips,
    setTracks,
    setClipGroups,
    setTransitions,
    setSelectedClipId,
    pushHistory,
  });

  const { handleGenerateIntercut } = useIntercutActions({
    pushHistory,
    setSelectedClipId,
  });

  const renderActions = useRenderActions({
    clips,
    clipGroups,
    transitions,
    textOverlays,
  });

  const inspectorActions = useInspectorActions({
    clips,
    selectedClipId,
    setClips,
    pushHistory,
    pushHistoryDebounced,
    storageEndpoint,
    storageAuthToken,
  });

  const timelineActions = useTimelineActions({
    clips,
    clipGroups,
    transitions,
    selectedClipId,
    setClips,
    setTracks,
    setClipGroups,
    setTransitions,
    setSelectedClipId,
    pushHistory,
  });

  const transitionActions = useTransitionActions({
    clips,
    clipGroups,
    setTransitions,
    pushHistoryDebounced,
  });

  const textOverlayActions = useTextOverlayActions({
    setTextOverlays,
    pushHistory,
    pushHistoryDebounced,
    setSelectedTextOverlayId,
  });

  const { handleClipLayoutCommit, handleTextOverlayLayoutCommit } =
    useLayoutCommitHandlers(setClips, setTextOverlays);

  const timelineClips = useMemo(
    () => getEffectiveTimelineClips(tracks, clips, clipGroups),
    [tracks, clips, clipGroups],
  );

  const previewTotalDuration = useMemo(
    () => computeTotalDuration(timelineClips, transitions),
    [timelineClips, transitions],
  );

  const { handleUndo, handleRedo } = useAppKeyboardShortcuts({
    toolbarRef,
    selectedClipId,
    timelineClips,
    canUndo,
    canRedo,
    handleMerge: renderActions.handleMerge,
    handleSaveProject,
    handleSplitClip: clipActions.handleSplitClip,
    handleDuplicateClip: clipActions.handleDuplicateClip,
    handleDeleteClip: timelineActions.handleDeleteClip,
    handleReorder: timelineActions.handleReorder,
    undo,
    redo,
    setShowKeyboardShortcuts,
    setStatus: (status) => {
      import("./store/settingsStore").then((m) => m.settingsStore.getState().setStatus(status));
    },
  });

  return (
    <AppShell
      toolbarRef={toolbarRef}
      storageEndpoint={storageEndpoint}
      storageAuthToken={storageAuthToken}
      clips={clips}
      tracks={tracks}
      clipGroups={clipGroups}
      transitions={transitions}
      textOverlays={textOverlays}
      selectedClipId={selectedClipId}
      selectedTextOverlayId={selectedTextOverlayId}
      selectedClip={inspectorActions.selectedClip}
      timelineClips={timelineClips}
      previewTotalDuration={previewTotalDuration}
      morphProcessingIndex={transitionActions.morphProcessingIndex}
      showKeyboardShortcuts={showKeyboardShortcuts}
      showMemoryWarning={renderActions.showMemoryWarning}
      recoveryOffer={recoveryOffer}
      isRecovering={isRecovering}
      isRemoteSaving={isRemoteSaving}
      isRemoteLoading={isRemoteLoading}
      remoteLoadStage={remoteLoadStage}
      remoteLoadProgress={remoteLoadProgress}
      remoteLoadIndeterminate={remoteLoadIndeterminate}
      remoteUploadItems={remoteUploadItems}
      pendingRemoteUploadError={pendingRemoteUploadError}
      renderFailureMessage={renderActions.renderFailureMessage}
      canUndo={canUndo}
      canRedo={canRedo}
      onAddClips={clipActions.handleAddClips}
      onMerge={renderActions.handleMerge}
      onGpuStitch={renderActions.handleGpuStitch}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onSaveProject={handleSaveProject}
      onLoadProject={handleLoadProject}
      onShowKeyboardShortcuts={() => setShowKeyboardShortcuts(true)}
      onDebugResetFFmpeg={renderActions.handleDebugResetFFmpeg}
      onRetryFfmpegLoad={renderActions.handleRetryFfmpegLoad}
      onCopyDebugInfo={renderActions.handleCopyDebugInfo}
      onPerformRender={renderActions.performRender}
      onDismissRenderFailure={() => renderActions.setRenderFailureMessage(null)}
      onStorageAuthTokenChange={handleStorageAuthTokenChange}
      onSaveRemote={handleSaveRemote}
      onLoadRemote={handleLoadRemote}
      onResolveRemoteUploadError={resolveRemoteUploadError}
      onAddLibraryClip={clipActions.handleAddLibraryClip}
      onToggleVariant={clipActions.handleToggleVariant}
      onDeleteClip={timelineActions.handleDeleteClip}
      onGenerateIntercut={handleGenerateIntercut}
      onSelectClip={setSelectedClipId}
      onSelectTextOverlay={setSelectedTextOverlayId}
      onClipLayoutCommit={handleClipLayoutCommit}
      onTextOverlayLayoutCommit={handleTextOverlayLayoutCommit}
      onPreviewDragStart={textOverlayActions.handlePreviewDragStart}
      onInspectorChange={inspectorActions.handleInspectorChange}
      onKeyframesChange={inspectorActions.handleClipKeyframesChange}
      onAutomationChange={inspectorActions.handleClipAutomationChange}
      onApplyKenBurns={inspectorActions.handleApplyKenBurns}
      onExtractAudio={inspectorActions.handleExtractAudio}
      onRife={inspectorActions.handleRife}
      onMoveUp={timelineActions.handleMoveUp}
      onMoveDown={timelineActions.handleMoveDown}
      onReorder={timelineActions.handleReorder}
      onMoveToTrack={timelineActions.handleMoveToTrack}
      onTransitionUpdate={transitionActions.handleTransitionUpdate}
      onAddTextOverlay={textOverlayActions.handleAddTextOverlay}
      onUpdateTextOverlay={textOverlayActions.handleUpdateTextOverlay}
      onDeleteTextOverlay={textOverlayActions.handleDeleteTextOverlay}
      onCloseKeyboardShortcuts={() => setShowKeyboardShortcuts(false)}
      onMemoryWarningConfirm={renderActions.handleMemoryWarningConfirm}
      onMemoryWarningCancel={renderActions.handleMemoryWarningCancel}
      onRecover={handleRecover}
      onDiscardRecovery={handleDiscardRecovery}
    />
  );
}
