import { useEffect, useMemo, useRef } from "react";
import { useProjectSaveLoad } from "./hooks/useProjectSaveLoad";
import { useEditHistory } from "./hooks/useEditHistory";
import { useAutoSave } from "./hooks/useAutoSave";
import { useClipBeatAnalysis } from "./hooks/useClipBeatAnalysis";
import { useClipStabilization } from "./hooks/useClipStabilization";
import { useMasterAudioBeatAnalysis } from "./hooks/useMasterAudioBeatAnalysis";
import { useClipImportChores } from "./hooks/useClipImportChores";
import { getEffectiveTimelineClips } from "./utils/timelineClips";
import { setPlayheadTime, settingsActions, uiActions } from "./store";
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
import { useCaptionActions } from "./hooks/useCaptionActions";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { AppShell } from "./components/AppShell";

/**
 * Composition root. All business state lives in the Zustand stores under
 * `src/store/` (#144); this component only wires the action hooks together and
 * hands their callbacks to {@link AppShell}, which lays out the panels. Panels
 * subscribe to the stores themselves rather than receiving state as props.
 */
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
  useClipStabilization(clips, setClips);
  useMasterAudioBeatAnalysis();
  useClipImportChores(clips, setClips);

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
    setSelectedTextOverlayId: uiActions.setSelectedTextOverlayId,
  });

  const captionActions = useCaptionActions({
    pushHistory,
    pushHistoryDebounced,
  });

  const {
    handleAddCaption,
    handleUpdateCaption,
    handleDeleteCaption,
    handleCaptionStyleChange,
    handleImportCaptions,
    handleExportCaptionsSrt,
    handleClearCaptions,
  } = captionActions;

  // Bundled for the Inspector's Captions tab. Memoized on the individual
  // callbacks (each `useCallback`-stable) rather than on the hook's return
  // object, which is a fresh literal every render — otherwise this prop would
  // change identity constantly and defeat `Inspector`'s `memo`.
  const captionPanelProps = useMemo(
    () => ({
      onAdd: handleAddCaption,
      onUpdate: handleUpdateCaption,
      onDelete: handleDeleteCaption,
      onStyleChange: handleCaptionStyleChange,
      onImport: handleImportCaptions,
      onExportSrt: handleExportCaptionsSrt,
      onClear: handleClearCaptions,
    }),
    [
      handleAddCaption,
      handleUpdateCaption,
      handleDeleteCaption,
      handleCaptionStyleChange,
      handleImportCaptions,
      handleExportCaptionsSrt,
      handleClearCaptions,
    ],
  );

  const { handleClipLayoutCommit, handleTextOverlayLayoutCommit } =
    useLayoutCommitHandlers(setClips, setTextOverlays);

  const timelineClips = useMemo(
    () => getEffectiveTimelineClips(tracks, clips, clipGroups),
    [tracks, clips, clipGroups],
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
    handleAddCaptionAtPlayhead: captionActions.handleAddCaption,
    undo,
    redo,
    setShowKeyboardShortcuts: uiActions.setShowKeyboardShortcuts,
    setStatus: settingsActions.setStatus,
  });

  return (
    <AppShell
      toolbarRef={toolbarRef}
      morphProcessingIndex={transitionActions.morphProcessingIndex}
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
      onAddClips={clipActions.handleAddClips}
      onMerge={renderActions.handleMerge}
      onGpuStitch={renderActions.handleGpuStitch}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onSaveProject={handleSaveProject}
      onLoadProject={handleLoadProject}
      onDebugResetFFmpeg={renderActions.handleDebugResetFFmpeg}
      onRetryFfmpegLoad={renderActions.handleRetryFfmpegLoad}
      onCopyDebugInfo={renderActions.handleCopyDebugInfo}
      onPerformRender={renderActions.performRender}
      onDismissRenderFailure={() => renderActions.setRenderFailureMessage(null)}
      onSaveRemote={handleSaveRemote}
      onLoadRemote={handleLoadRemote}
      onResolveRemoteUploadError={resolveRemoteUploadError}
      onAddLibraryClip={clipActions.handleAddLibraryClip}
      onToggleVariant={clipActions.handleToggleVariant}
      onDeleteClip={timelineActions.handleDeleteClip}
      onGenerateIntercut={handleGenerateIntercut}
      onClipLayoutCommit={handleClipLayoutCommit}
      onTextOverlayLayoutCommit={handleTextOverlayLayoutCommit}
      onPreviewDragStart={textOverlayActions.handlePreviewDragStart}
      onInspectorChange={inspectorActions.handleInspectorChange}
      onKeyframesChange={inspectorActions.handleClipKeyframesChange}
      onAutomationChange={inspectorActions.handleClipAutomationChange}
      onApplyKenBurns={inspectorActions.handleApplyKenBurns}
      onExtractAudio={inspectorActions.handleExtractAudio}
      onRife={inspectorActions.handleRife}
      onStabilizeChange={inspectorActions.handleStabilizeChange}
      onMoveUp={timelineActions.handleMoveUp}
      onMoveDown={timelineActions.handleMoveDown}
      onReorder={timelineActions.handleReorder}
      onMoveToTrack={timelineActions.handleMoveToTrack}
      onTransitionUpdate={transitionActions.handleTransitionUpdate}
      captions={captionPanelProps}
      onCaptionResize={captionActions.handleResizeCaption}
      onAddTextOverlay={textOverlayActions.handleAddTextOverlay}
      onUpdateTextOverlay={textOverlayActions.handleUpdateTextOverlay}
      onDeleteTextOverlay={textOverlayActions.handleDeleteTextOverlay}
      onMemoryWarningConfirm={renderActions.handleMemoryWarningConfirm}
      onMemoryWarningCancel={renderActions.handleMemoryWarningCancel}
      onRecover={handleRecover}
      onDiscardRecovery={handleDiscardRecovery}
    />
  );
}
