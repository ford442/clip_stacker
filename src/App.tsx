import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStableObject } from "./hooks/useStableObject";
import { useProjectSaveLoad } from "./hooks/useProjectSaveLoad";
import { useEditHistory } from "./hooks/useEditHistory";
import { useAutoSave } from "./hooks/useAutoSave";
import { useClipBeatAnalysis } from "./hooks/useClipBeatAnalysis";
import { useClipStabilization } from "./hooks/useClipStabilization";
import { useProxyBuilder } from "./hooks/useProxyBuilder";
import { useMasterAudioBeatAnalysis } from "./hooks/useMasterAudioBeatAnalysis";
import { useClipImportChores } from "./hooks/useClipImportChores";
import { visibleTextOverlays } from "./timeline/trackModel";
import { selectTimelineClips } from "./store/selectors";
import { editorStore, playbackStore, setPlayheadTime, uiActions, useEditorTimelineClips } from "./store";
import { playheadForSelectedClip, resolveClipOutputWindow } from "./composition/previewComposition";
import { useClipActions } from "./hooks/useClipActions";
import { useIntercutActions } from "./hooks/useIntercutActions";
import { useRenderActions } from "./hooks/useRenderActions";
import { useInspectorActions } from "./hooks/useInspectorActions";
import { useBatchClipProcessing } from "./hooks/useBatchClipProcessing";
import { useTimelineActions } from "./hooks/useTimelineActions";
import { useTransitionActions } from "./hooks/useTransitionActions";
import {
  useTextOverlayActions,
  useLayoutCommitHandlers,
} from "./hooks/useTextOverlayActions";
import { useCaptionActions } from "./hooks/useCaptionActions";
import { useAppKeyboardShortcuts } from "./hooks/useAppKeyboardShortcuts";
import { AppShell } from "./components/AppShell";
import { renderJobActions } from './store/renderJobStore';
import { harnessBindings } from './app/harnessBindings';

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
  useProxyBuilder(clips, setClips);
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
  } = useAutoSave({ resetHistory });

  const toolbarRef = useRef<{ triggerLoadDialog: () => void }>(null!);
  // Speed (and every other clip edit) replaces `clips`. Re-running the
  // playhead jump on that would seek back to the in-point on every slider
  // tick, so the only visible change was the clip block changing length.
  const playheadPositionedForClipId = useRef<string | null>(null);

  // Selecting a clip parks the (output-time) playhead on it, unless the
  // playhead is already inside the clip — then it stays put.
  useEffect(() => {
    if (!selectedClipId) {
      playheadPositionedForClipId.current = null;
      setPlayheadTime(null);
      return;
    }
    const state = editorStore.getState();
    const placed = resolveClipOutputWindow(
      selectTimelineClips(state),
      state.clipGroups,
      state.transitions,
      selectedClipId,
    );
    if (!placed) return;
    setPlayheadTime(
      playheadForSelectedClip(playbackStore.getState().playheadTime, placed),
    );
  }, [selectedClipId]);

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

  // Titles on a muted text lane are excluded from the render, matching what the
  // preview draws (#168 Phase C).
  const visibleOverlays = useMemo(
    () => visibleTextOverlays(tracks, textOverlays),
    [tracks, textOverlays],
  );

  const renderActions = useRenderActions({
    clips,
    tracks,
    clipGroups,
    transitions,
    textOverlays: visibleOverlays,
  });
  // `?test_harness` drives the real Render action (src/app/testHarness) and
  // can crash this tree on purpose, to exercise RootErrorBoundary recovery.
  useEffect(() => {
    harnessBindings.performRender = renderActions.performRender;
  }, [renderActions.performRender]);
  const [harnessCrash, setHarnessCrash] = useState<Error | null>(null);
  useEffect(() => {
    harnessBindings.crash = setHarnessCrash;
    return () => {
      harnessBindings.crash = null;
    };
  }, []);

  const inspectorActions = useInspectorActions({
    clips,
    selectedClipId,
    setClips,
    pushHistory,
    pushHistoryDebounced,
  });
  const batchProcessingActions = useBatchClipProcessing({
    clips,
    setClips,
    pushHistory,
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

  const timelineClips = useEditorTimelineClips();

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
    handleEditNudge: timelineActions.handleEditNudge,
    handleRippleDelete: timelineActions.handleRippleDelete,
    handleAddCaptionAtPlayhead: captionActions.handleAddCaption,
    undo,
    redo,
    setShowKeyboardShortcuts: uiActions.setShowKeyboardShortcuts,
    setStatus: renderJobActions.setStatus,
  });

  const { setRenderFailureMessage } = renderActions;
  const onDismissRenderFailure = useCallback(
    () => setRenderFailureMessage(null),
    [setRenderFailureMessage],
  );

  const history = useStableObject({ onUndo: handleUndo, onRedo: handleRedo });
  const project = useStableObject({
    onSaveProject: handleSaveProject,
    onLoadProject: handleLoadProject,
    onSaveRemote: handleSaveRemote,
    onLoadRemote: handleLoadRemote,
    onResolveRemoteUploadError: resolveRemoteUploadError,
    isRemoteSaving,
    isRemoteLoading,
    remoteLoadStage,
    remoteLoadProgress,
    remoteLoadIndeterminate,
    remoteUploadItems,
    pendingRemoteUploadError,
    recoveryOffer,
    isRecovering,
    onRecover: handleRecover,
    onDiscardRecovery: handleDiscardRecovery,
  });
  const render = useStableObject({
    onMerge: renderActions.handleMerge,
    onGpuStitch: renderActions.handleGpuStitch,
    onDebugResetFFmpeg: renderActions.handleDebugResetFFmpeg,
    onRetryFfmpegLoad: renderActions.handleRetryFfmpegLoad,
    onCopyDebugInfo: renderActions.handleCopyDebugInfo,
    onPerformRender: renderActions.performRender,
    renderFailureMessage: renderActions.renderFailureMessage,
    onDismissRenderFailure,
    showMemoryWarning: renderActions.showMemoryWarning,
    onMemoryWarningConfirm: renderActions.handleMemoryWarningConfirm,
    onMemoryWarningCancel: renderActions.handleMemoryWarningCancel,
  });
  const clipBundle = useStableObject({
    onAddClips: clipActions.handleAddClips,
    onAddLibraryClip: clipActions.handleAddLibraryClip,
    onToggleVariant: clipActions.handleToggleVariant,
    onDeleteClip: timelineActions.handleDeleteClip,
    onGenerateIntercut: handleGenerateIntercut,
    onBatchProcess: batchProcessingActions.handleBatchProcess,
  });
  const preview = useStableObject({
    onClipLayoutCommit: handleClipLayoutCommit,
    onTextOverlayLayoutCommit: handleTextOverlayLayoutCommit,
    onPreviewDragStart: textOverlayActions.handlePreviewDragStart,
  });
  const inspector = useStableObject({
    onInspectorChange: inspectorActions.handleInspectorChange,
    onKeyframesChange: inspectorActions.handleClipKeyframesChange,
    onAutomationChange: inspectorActions.handleClipAutomationChange,
    onAudioEffectsChange: inspectorActions.handleClipAudioEffectsChange,
    onApplyKenBurns: inspectorActions.handleApplyKenBurns,
    onExtractAudio: inspectorActions.handleExtractAudio,
    onRife: inspectorActions.handleRife,
    onStabilizeChange: inspectorActions.handleStabilizeChange,
    onReverseChange: inspectorActions.handleReverseChange,
    onColorSpaceOverrideChange: inspectorActions.handleColorSpaceOverrideChange,
  });
  const timeline = useStableObject({
    onMoveUp: timelineActions.handleMoveUp,
    onMoveDown: timelineActions.handleMoveDown,
    onReorder: timelineActions.handleReorder,
    onMoveToTrack: timelineActions.handleMoveToTrack,
    onTransitionUpdate: transitionActions.handleTransitionUpdate,
    onCaptionResize: captionActions.handleResizeCaption,
    morphProcessingIndex: transitionActions.morphProcessingIndex,
  });
  const textOverlayBundle = useStableObject({
    onAddTextOverlay: textOverlayActions.handleAddTextOverlay,
    onUpdateTextOverlay: textOverlayActions.handleUpdateTextOverlay,
    onDeleteTextOverlay: textOverlayActions.handleDeleteTextOverlay,
  });

  if (harnessCrash) throw harnessCrash;

  return (
    <AppShell
      toolbarRef={toolbarRef}
      history={history}
      project={project}
      render={render}
      clips={clipBundle}
      preview={preview}
      inspector={inspector}
      timeline={timeline}
      captions={captionPanelProps}
      textOverlays={textOverlayBundle}
    />
  );
}
