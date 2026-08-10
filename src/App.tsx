import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeTotalDuration } from "./utils/transitions";
import { useProjectSaveLoad } from "./hooks/useProjectSaveLoad";
import { useRenderState } from "./hooks/useRenderState";
import { useEditHistory } from "./hooks/useEditHistory";
import { useAutoSave } from "./hooks/useAutoSave";
import { useClipBeatAnalysis } from "./hooks/useClipBeatAnalysis";
import { getEffectiveTimelineClips } from "./utils/timelineClips";
import {
  readStorageAuthToken,
  writeStorageAuthToken,
} from "./utils/storageAuth";
import { setPlayheadTime } from "./store";
import { useClipActions } from "./hooks/useClipActions";
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
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [selectedTextOverlayId, setSelectedTextOverlayId] = useState<string | null>(null);

  const {
    exportSettings,
    setExportSettings,
    finishing,
    setFinishing,
    forceFFmpeg,
    setForceFFmpeg,
    useCanvasRenderer,
    setUseCanvasRenderer,
    audioReactive,
    setAudioReactive,
    forceReencode,
    setForceReencode,
    status,
    setStatus,
    progressStage,
    setProgressStage,
    progressValue,
    setProgressValue,
    progressIndeterminate,
    setProgressIndeterminate,
    isRendering,
    setIsRendering,
    ffmpegLoading,
    setFfmpegLoading,
    ffmpegFailed,
    setFfmpegFailed,
    outputUrl,
    setOutputUrl,
    encoderPath,
    setEncoderPath,
    renderPlan,
    setRenderPlan,
    rifeProcessingClipId,
    setRifeProcessingClipId,
  } = useRenderState();

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
    finishing,
    setFinishing,
    setClips,
    setClipGroups,
    setSelectedClipId,
    setTransitions,
    setTextOverlays,
    setStatus,
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
    exportSettings,
    setExportSettings,
    resetHistory,
    setStatus,
    enabled: !isRendering,
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
    setStatus,
    setOutputUrl,
  });

  const renderActions = useRenderActions({
    clips,
    clipGroups,
    transitions,
    textOverlays,
    exportSettings,
    finishing,
    forceFFmpeg,
    useCanvasRenderer,
    audioReactive,
    forceReencode,
    outputUrl,
    status,
    renderPlan,
    encoderPath,
    setStatus,
    setFinishing,
    setForceFFmpeg,
    setUseCanvasRenderer,
    setAudioReactive,
    setForceReencode,
    setProgressStage,
    setProgressValue,
    setProgressIndeterminate,
    setIsRendering,
    setFfmpegLoading,
    setFfmpegFailed,
    setOutputUrl,
    setEncoderPath,
    setRenderPlan,
  });

  const inspectorActions = useInspectorActions({
    clips,
    selectedClipId,
    setClips,
    pushHistory,
    pushHistoryDebounced,
    exportSettings,
    rifeProcessingClipId,
    setRifeProcessingClipId,
    setStatus,
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
    setStatus,
  });

  const transitionActions = useTransitionActions({
    clips,
    clipGroups,
    setTransitions,
    pushHistoryDebounced,
    setStatus,
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
    setStatus,
    setShowKeyboardShortcuts,
  });

  return (
    <AppShell
      toolbarRef={toolbarRef}
      encoderPath={encoderPath}
      renderFailureMessage={renderActions.renderFailureMessage}
      isRendering={isRendering}
      renderPlan={renderPlan}
      storageEndpoint={storageEndpoint}
      storageAuthToken={storageAuthToken}
      clips={clips}
      tracks={tracks}
      clipGroups={clipGroups}
      transitions={transitions}
      textOverlays={textOverlays}
      exportSettings={exportSettings}
      finishing={finishing}
      outputUrl={outputUrl}
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
      ffmpegLoading={ffmpegLoading}
      ffmpegFailed={ffmpegFailed}
      forceFFmpeg={forceFFmpeg}
      useCanvasRenderer={useCanvasRenderer}
      audioReactive={audioReactive}
      forceReencode={forceReencode}
      status={status}
      progressStage={progressStage}
      progressValue={progressValue}
      progressIndeterminate={progressIndeterminate}
      rifeProcessingClipId={rifeProcessingClipId}
      isRemoteSaving={isRemoteSaving}
      isRemoteLoading={isRemoteLoading}
      remoteLoadStage={remoteLoadStage}
      remoteLoadProgress={remoteLoadProgress}
      remoteLoadIndeterminate={remoteLoadIndeterminate}
      remoteUploadItems={remoteUploadItems}
      pendingRemoteUploadError={pendingRemoteUploadError}
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
      onToggleForceFFmpeg={setForceFFmpeg}
      onToggleCanvasRenderer={renderActions.handleToggleCanvasRenderer}
      onToggleAudioReactive={setAudioReactive}
      onToggleForceReencode={setForceReencode}
      onPerformRender={renderActions.performRender}
      onDismissRenderFailure={() => renderActions.setRenderFailureMessage(null)}
      onStorageAuthTokenChange={handleStorageAuthTokenChange}
      onSaveRemote={handleSaveRemote}
      onLoadRemote={handleLoadRemote}
      onResolveRemoteUploadError={resolveRemoteUploadError}
      onAddLibraryClip={clipActions.handleAddLibraryClip}
      onToggleVariant={clipActions.handleToggleVariant}
      onDeleteClip={timelineActions.handleDeleteClip}
      onSelectClip={setSelectedClipId}
      onSelectTextOverlay={setSelectedTextOverlayId}
      onClipLayoutCommit={handleClipLayoutCommit}
      onTextOverlayLayoutCommit={handleTextOverlayLayoutCommit}
      onPreviewDragStart={textOverlayActions.handlePreviewDragStart}
      onFinishingChange={setFinishing}
      onInspectorChange={inspectorActions.handleInspectorChange}
      onKeyframesChange={inspectorActions.handleClipKeyframesChange}
      onApplyKenBurns={inspectorActions.handleApplyKenBurns}
      onExportSettingsChange={setExportSettings}
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
