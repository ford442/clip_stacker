import { useCallback, useState } from "react";
import type { Clip, ClipGroup, ClipTransition, TextOverlay } from "../types";
import {
  serializeProjectWithMedia,
  applyProjectData,
  loadRemoteProject,
  ContaboStorageManagerClient,
  type RemoteProjectLoadProgressEvent,
  type RemoteUploadProgressEvent,
  type RemoteUploadErrorEvent,
} from "../utils/project";

function formatSkippedClipMessage(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, and ${names.length - 3} more`;
}

export type PendingRemoteUploadError = RemoteUploadErrorEvent & {
  resumeCb: (action: "retry" | "skip" | "abort") => void;
};

export function useProjectSaveLoad({
  clips,
  clipGroups,
  transitions,
  textOverlays,
  setClips,
  setClipGroups,
  setSelectedClipId,
  setTransitions,
  setTextOverlays,
  setStatus,
}: {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  setClips: (c: Clip[]) => void;
  setClipGroups: (cg: ClipGroup[]) => void;
  setSelectedClipId: (id: string | null) => void;
  setTransitions: (t: ClipTransition[]) => void;
  setTextOverlays: (to: TextOverlay[]) => void;
  setStatus: (s: string) => void;
}) {
  const [isRemoteSaving, setIsRemoteSaving] = useState(false);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteLoadStage, setRemoteLoadStage] = useState("");
  const [remoteLoadProgress, setRemoteLoadProgress] = useState<number | null>(
    null,
  );
  const [remoteLoadIndeterminate, setRemoteLoadIndeterminate] = useState(false);
  const [remoteUploadItems, setRemoteUploadItems] = useState<
    RemoteUploadProgressEvent[]
  >([]);
  const [pendingRemoteUploadError, setPendingRemoteUploadError] =
    useState<PendingRemoteUploadError | null>(null);

  const resolveRemoteUploadError = useCallback(
    (action: "retry" | "skip" | "abort") => {
      if (pendingRemoteUploadError) {
        pendingRemoteUploadError.resumeCb(action);
        setPendingRemoteUploadError(null);
      }
    },
    [pendingRemoteUploadError],
  );

  const handleSaveProject = useCallback(async () => {
    try {
      setStatus("Exporting project JSON with source media...");
      const embedWarnings: string[] = [];
      const project = await serializeProjectWithMedia(
        clips,
        transitions,
        textOverlays,
        clipGroups,
        {
          mediaMode: "embed",
          onEmbedWarning: (message) => embedWarnings.push(message),
        },
      );
      const payload = JSON.stringify(project, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "clip_stacker-project.json";
      anchor.click();
      URL.revokeObjectURL(url);
      let msg = "Project JSON exported with source media.";
      if (embedWarnings.length > 0) {
        msg += ` ⚠️ ${embedWarnings.join(" ")}`;
      }
      setStatus(msg);
    } catch (error) {
      setStatus(`Could not export project: ${(error as Error).message}`);
    }
  }, [clips, clipGroups, transitions, textOverlays, setStatus]);

  const handleLoadProject = useCallback(
    async (file: File) => {
      try {
        const parsed = JSON.parse(await file.text());
        const {
          clips: updatedClips,
          clipGroups: loadedClipGroups,
          transitions: loadedTransitions,
          textOverlays: loadedOverlays,
          skippedClipCount,
          skippedClipFileNames,
          invalidColorWarnings,
        } = await applyProjectData(parsed, clips);
        if (updatedClips.length > 0) {
          setClips(updatedClips);
          setClipGroups(loadedClipGroups);
          setSelectedClipId(updatedClips[updatedClips.length - 1].id);
        }
        setTransitions(loadedTransitions);
        setTextOverlays(loadedOverlays);
        let msg = `Project JSON loaded (${updatedClips.length} clips applied).`;
        if (skippedClipCount > 0) {
          msg += ` ⚠️ ${skippedClipCount} clip(s) skipped — missing media: ${formatSkippedClipMessage(skippedClipFileNames)}.`;
        }
        if (invalidColorWarnings.length > 0) {
          msg += ` ⚠️ ${invalidColorWarnings.join(" ")}`;
        }
        setStatus(msg);
      } catch (error) {
        setStatus(`Could not load project: ${(error as Error).message}`);
      }
    },
    [
      clips,
      setClips,
      setClipGroups,
      setSelectedClipId,
      setTransitions,
      setTextOverlays,
      setStatus,
    ],
  );

  const handleSaveRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      try {
        setIsRemoteSaving(true);
        setRemoteUploadItems(
          clips.map((clip, i) => ({
            clipId: clip.id,
            fileName: clip.file.name,
            index: i + 1,
            total: clips.length,
            progress: 0,
            status: "uploading" as const,
          })),
        );
        setStatus(
          clips.length > 0
            ? `Uploading clip 1/${clips.length}: ${clips[0].file.name} (0%)`
            : "Saving project to remote storage...",
        );
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const project = await serializeProjectWithMedia(
          clips,
          transitions,
          textOverlays,
          clipGroups,
          {
            mediaMode: "remote",
            mediaClient: client,
            onRemoteUploadProgress: (event) => {
              setRemoteUploadItems((prev) => {
                const next = [...prev];
                const idx = next.findIndex(
                  (item) => item.clipId === event.clipId,
                );
                if (idx !== -1) {
                  next[idx] = event;
                }
                return next;
              });
              if (event.status === "uploading") {
                setStatus(
                  `Uploading clip ${event.index}/${event.total}: ${event.fileName} (${Math.round(event.progress * 100)}%)`,
                );
              }
            },
            onRemoteUploadError: (event) => {
              return new Promise<"retry" | "skip" | "abort">((resolve) => {
                setPendingRemoteUploadError({
                  ...event,
                  resumeCb: resolve,
                });
              });
            },
          },
        );
        setStatus("Saving project manifest to remote storage...");
        await client.save(projectName, project);
        setStatus(`Remote save complete (${projectName})`);
      } catch (error) {
        setStatus(
          `Could not save project to remote storage: ${(error as Error).message}`,
        );
      } finally {
        setIsRemoteSaving(false);
      }
    },
    [clips, clipGroups, transitions, textOverlays, setStatus],
  );

  const handleLoadRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      try {
        setIsRemoteLoading(true);
        setStatus("Loading project from remote storage...");
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const {
          clips: updatedClips,
          clipGroups: loadedClipGroups,
          transitions: loadedTransitions,
          textOverlays: loadedOverlays,
          skippedClipCount,
          skippedClipFileNames,
          invalidColorWarnings,
        } = await loadRemoteProject(client, projectName, clips, {
          onProgress: (event: RemoteProjectLoadProgressEvent) => {
            setRemoteLoadStage(event.stage);
            if (event.indeterminate) {
              setRemoteLoadProgress(null);
              setRemoteLoadIndeterminate(true);
            } else if (typeof event.progress === "number") {
              setRemoteLoadProgress(event.progress);
              setRemoteLoadIndeterminate(false);
            }
          },
        });

        if (updatedClips.length > 0) {
          setClips(updatedClips);
          setClipGroups(loadedClipGroups);
          setSelectedClipId(updatedClips[updatedClips.length - 1].id);
        }
        setTransitions(loadedTransitions);
        setTextOverlays(loadedOverlays);

        let msg = `Remote project loaded (${updatedClips.length} clips applied).`;
        if (skippedClipCount > 0) {
          msg += ` ⚠️ ${skippedClipCount} clip(s) skipped — missing media: ${formatSkippedClipMessage(skippedClipFileNames)}.`;
        }
        if (invalidColorWarnings.length > 0) {
          msg += ` ⚠️ ${invalidColorWarnings.join(" ")}`;
        }
        setStatus(msg);
      } catch (error) {
        setStatus(
          `Could not load project from remote storage: ${(error as Error).message}`,
        );
      } finally {
        setIsRemoteLoading(false);
        setRemoteLoadStage("");
      }
    },
    [
      clips,
      setClips,
      setClipGroups,
      setSelectedClipId,
      setTransitions,
      setTextOverlays,
      setStatus,
    ],
  );

  return {
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
  };
}
