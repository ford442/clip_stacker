import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from '../types';
import { applyProjectData } from '../utils/project';
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

export function useAutoSave({
  clips,
  clipGroups,
  transitions,
  textOverlays,
  selectedClipId,
  exportSettings,
  setExportSettings,
  resetHistory,
  setStatus,
  enabled = true,
}: {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  selectedClipId: string | null;
  exportSettings: ExportSettings;
  setExportSettings: (settings: ExportSettings) => void;
  resetHistory: (snapshot: EditSnapshot) => void;
  setStatus: (message: string) => void;
  enabled?: boolean;
}) {
  const [recoveryOffer, setRecoveryOffer] = useState<AutoSaveOffer | null>(() =>
    readAutoSaveOffer(),
  );
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryResolved, setRecoveryResolved] = useState(() => !readAutoSaveOffer());
  const lastSavedHashRef = useRef<string | null>(null);
  const persistInFlightRef = useRef(false);

  const persist = useCallback(async () => {
    if (!enabled || !recoveryResolved || persistInFlightRef.current) return;

    const stateHash = hashAutoSaveState(
      clips,
      transitions,
      textOverlays,
      clipGroups,
      selectedClipId,
      exportSettings,
    );
    if (stateHash === lastSavedHashRef.current) return;

    if (
      clips.length === 0 &&
      textOverlays.length === 0 &&
      transitions.length === 0
    ) {
      clearAutoSave();
      lastSavedHashRef.current = stateHash;
      return;
    }

    persistInFlightRef.current = true;
    try {
      let project = await buildAutoSaveProject(
        clips,
        transitions,
        textOverlays,
        clipGroups,
      );
      let session = buildAutoSaveSession(project, selectedClipId, exportSettings);
      let result = writeAutoSaveSession(session);

      if (!result.ok && result.reason === 'quota') {
        project = await buildAutoSaveProject(
          clips,
          transitions,
          textOverlays,
          clipGroups,
          { forceMetadataOnly: true },
        );
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
    clips,
    transitions,
    textOverlays,
    clipGroups,
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
    setStatus('Autosave discarded. Starting with an empty project.');
  }, [setStatus]);

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
        clipGroups: restoredGroups,
        transitions: restoredTransitions,
        textOverlays: restoredOverlays,
        skippedClipCount,
        skippedClipFileNames,
        invalidColorWarnings,
        mediaDownloadWarnings,
      } = await applyProjectData(session.project, []);

      const selectedId =
        session.selectedClipId &&
        restoredClips.some((clip) => clip.id === session.selectedClipId)
          ? session.selectedClipId
          : restoredClips.length > 0
            ? restoredClips[restoredClips.length - 1].id
            : null;

      resetHistory({
        clips: restoredClips,
        clipGroups: restoredGroups,
        transitions: restoredTransitions,
        textOverlays: restoredOverlays,
        selectedClipId: selectedId,
      });
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
        restoredClips,
        restoredTransitions,
        restoredOverlays,
        restoredGroups,
        selectedId,
        session.exportSettings ?? exportSettings,
      );
    } catch (error) {
      setStatus(`Could not recover autosave: ${(error as Error).message}`);
      handleDiscardRecovery();
    } finally {
      setIsRecovering(false);
    }
  }, [exportSettings, handleDiscardRecovery, resetHistory, setExportSettings, setStatus]);

  return {
    recoveryOffer,
    isRecovering,
    handleRecover,
    handleDiscardRecovery,
  };
}
