import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { applyProjectData } from '../utils/project';
import {
  projectSnapshotHasContent,
  selectProjectSnapshot,
  selectProjectSnapshotEditorFields,
  type ProjectSnapshot,
} from '../utils/project/snapshot';
import type { EditSnapshot } from '../utils/editHistory';
import {
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_INTERVAL_MS,
  buildAutoSaveProject,
  buildAutoSaveSession,
  clearAutoSave,
  hashAutoSaveState,
  readAutoSaveOffer,
  readAutoSaveSession,
  sessionHasRecoverableWork,
  writeAutoSaveSession,
  type AutoSaveOffer,
} from '../utils/autoSave';

import { settingsStore } from '../store/settingsStore';
import { editorStore } from '../store/editorStore';

/**
 * Autosave and crash recovery. The saved state is the same
 * {@link ProjectSnapshot} a manual save writes, subscribed field by field, so
 * any project edit (a grade, the master bus, a caption…) schedules a save.
 */
export function useAutoSave({
  resetHistory,
  enabled = true,
}: {
  resetHistory: (snapshot: EditSnapshot) => void;
  enabled?: boolean;
}) {
  const exportSettings = useStore(settingsStore, (s) => s.exportSettings);
  const selectedClipId = useStore(editorStore, (s) => s.selectedClipId);
  const editorFields = useStore(editorStore, useShallow(selectProjectSnapshotEditorFields));
  const finishing = useStore(settingsStore, (s) => s.finishing);
  const colorManagement = useStore(settingsStore, (s) => s.colorManagement);
  const [recoveryOffer, setRecoveryOffer] = useState<AutoSaveOffer | null>(() =>
    readAutoSaveOffer(),
  );
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryResolved, setRecoveryResolved] = useState(() => !readAutoSaveOffer());
  const lastSavedHashRef = useRef<string | null>(null);
  const persistInFlightRef = useRef(false);

  const persist = useCallback(async () => {
    if (!enabled || !recoveryResolved || persistInFlightRef.current) return;

    const snapshot: ProjectSnapshot = selectProjectSnapshot(editorFields, {
      finishing,
      colorManagement,
    });
    const stateHash = hashAutoSaveState(snapshot, selectedClipId, exportSettings);
    if (stateHash === lastSavedHashRef.current) return;

    if (!projectSnapshotHasContent(snapshot)) {
      clearAutoSave();
      lastSavedHashRef.current = stateHash;
      return;
    }

    persistInFlightRef.current = true;
    try {
      let project = await buildAutoSaveProject(snapshot);
      let session = buildAutoSaveSession(project, selectedClipId, exportSettings);
      let result = writeAutoSaveSession(session);

      if (!result.ok && result.reason === 'quota') {
        project = await buildAutoSaveProject(snapshot, { forceMetadataOnly: true });
        session = buildAutoSaveSession(project, selectedClipId, exportSettings);
        result = writeAutoSaveSession(session);
      }

      if (result.ok) {
        lastSavedHashRef.current = stateHash;
      }
    } catch (error) {
      console.warn('Autosave failed:', error);
    } finally {
      persistInFlightRef.current = false;
    }
  }, [
    enabled,
    recoveryResolved,
    editorFields,
    finishing,
    colorManagement,
    selectedClipId,
    exportSettings,
  ]);

  useEffect(() => {
    if (!enabled || !recoveryResolved) return;
    const timer = window.setTimeout(() => {
      void persist();
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, recoveryResolved, persist]);

  useEffect(() => {
    if (!enabled || !recoveryResolved) return;
    const timer = window.setInterval(() => {
      void persist();
    }, AUTO_SAVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, recoveryResolved, persist]);

  const handleDiscardRecovery = useCallback(() => {
    clearAutoSave();
    setRecoveryOffer(null);
    setRecoveryResolved(true);
    settingsStore.getState().setStatus('Autosave discarded. Starting with an empty project.');
  }, []);

  const handleRecover = useCallback(async () => {
    const session = readAutoSaveSession();
    if (!session || !sessionHasRecoverableWork(session)) {
      handleDiscardRecovery();
      return;
    }

    setIsRecovering(true);
    try {
      const {
        clips: restoredClips,
        tracks: restoredTracks,
        clipGroups: restoredGroups,
        transitions: restoredTransitions,
        textOverlays: restoredOverlays,
        captions: restoredCaptions,
        captionStyle: restoredCaptionStyle,
        skippedClipCount,
        skippedClipFileNames,
        invalidColorWarnings,
        mediaDownloadWarnings,
        colorManagement: restoredColor,
        finishing: restoredFinishing,
        masterAudio: restoredMasterAudio,
        masterAudioMarkers: restoredMarkers,
        masterBus: restoredMasterBus,
      } = await applyProjectData(session.project, []);

      const selectedId =
        session.selectedClipId &&
        restoredClips.some((clip) => clip.id === session.selectedClipId)
          ? session.selectedClipId
          : restoredClips.length > 0
            ? restoredClips[restoredClips.length - 1].id
            : null;

      // Restore everything the snapshot holds — the same fields a save wrote.
      const restored: ProjectSnapshot = {
        clips: restoredClips,
        tracks: restoredTracks,
        clipGroups: restoredGroups,
        transitions: restoredTransitions,
        textOverlays: restoredOverlays,
        captions: restoredCaptions,
        captionStyle: restoredCaptionStyle,
        masterAudio: restoredMasterAudio,
        masterAudioMarkers: restoredMarkers,
        masterBus: restoredMasterBus,
        finishing: restoredFinishing,
        colorManagement: restoredColor,
      };
      settingsStore.getState().setColorManagement(restored.colorManagement);
      settingsStore.getState().setFinishing(restored.finishing);
      resetHistory({
        clips: restored.clips,
        tracks: restored.tracks,
        clipGroups: restored.clipGroups,
        transitions: restored.transitions,
        textOverlays: restored.textOverlays,
        captions: restored.captions,
        captionStyle: restored.captionStyle,
        masterAudioMarkers: restored.masterAudioMarkers,
        selectedClipId: selectedId,
        masterAudio: restored.masterAudio,
        masterBus: restored.masterBus,
      });
      const { setStatus, setExportSettings } = settingsStore.getState();
      if (session.exportSettings) {
        setExportSettings(session.exportSettings);
      }

      let message = `Recovered autosave (${restoredClips.length} clip${restoredClips.length === 1 ? '' : 's'}).`;
      if (skippedClipCount > 0) {
        message += ` ${skippedClipCount} clip(s) skipped — re-import: ${skippedClipFileNames.join(', ')}.`;
      }
      if (mediaDownloadWarnings.length > 0) {
        message += ` Media warnings: ${mediaDownloadWarnings.join('; ')}`;
      }
      if (invalidColorWarnings.length > 0) {
        message += ` ${invalidColorWarnings.join(' ')}`;
      }
      setStatus(message);
      setRecoveryOffer(null);
      setRecoveryResolved(true);
      lastSavedHashRef.current = hashAutoSaveState(
        restored,
        selectedId,
        session.exportSettings ?? exportSettings,
      );
    } catch (error) {
      settingsStore.getState().setStatus(`Could not recover autosave: ${(error as Error).message}`);
      handleDiscardRecovery();
    } finally {
      setIsRecovering(false);
    }
  }, [exportSettings, handleDiscardRecovery, resetHistory]);

  return {
    recoveryOffer,
    isRecovering,
    handleRecover,
    handleDiscardRecovery,
  };
}
