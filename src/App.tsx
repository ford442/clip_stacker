import { useCallback, useMemo, useRef, useState } from 'react';
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay, RenderPlan } from './types';
import { DEFAULT_EXPORT_SETTINGS } from './types';
import { getMediaInfo, createClipId, MIN_CLIP_DURATION } from './utils/media';
import {
  sanitizeClipAdjustments,
  serializeProjectWithMedia,
  applyProjectData,
  loadRemoteProject,
  ContaboStorageManagerClient,
  type RemoteProjectLoadProgressEvent,
} from './utils/project';
import { findMatchingClipIndex } from './utils/clipMatching';
import { reindexTransitions } from './utils/transitions';
import { hybridMergeClips } from './utils/hybrid-encoder';
import {
  extractAudioToWav,
  extractTrimmedVideoClip,
  calculateRenderPlan,
  aggressiveCleanupFFmpegVFS,
  resetFFmpegInstance,
  getLastFfmpegLogs,
  getLastFfmpegError,
  getFfmpegEnvironmentDiagnostics,
  clearFfmpegLogs,
  isFfmpegLoadFailed,
  isFfmpegLoading,
  ensureFfmpeg,
} from './ffmpeg/ffmpegService';
import type { RenderProgressUpdate } from './ffmpeg/ffmpegService';
import { isHighMemoryUsage, getMemoryStatus, formatBytes } from './utils/memory';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Toolbar } from './components/Toolbar';
import { StorageRow } from './components/StorageRow';
import { ClipLibrary } from './components/ClipLibrary';
import { Inspector } from './components/Inspector';
import type { ClipValues } from './components/Inspector';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';
import { TextOverlayPanel } from './components/TextOverlayPanel';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { MemoryWarningModal } from './components/MemoryWarningModal';

function formatSkippedClipMessage(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, and ${names.length - 3} more`;
}

type RemoteUploadItem = {
  clipId: string;
  fileName: string;
  index: number;
  total: number;
  progress: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed' | 'skipped';
  error?: string;
};

type PendingRemoteUploadError = {
  fileName: string;
  index: number;
  total: number;
  error: string;
};

export function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipGroups, setClipGroups] = useState<ClipGroup[]>([]);
  const [transitions, setTransitions] = useState<ClipTransition[]>([]);
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [forceFFmpeg, setForceFFmpeg] = useState(false);
  const [useCanvasRenderer, setUseCanvasRenderer] = useState(false);
  const [audioReactive, setAudioReactive] = useState(true);
  const [forceReencode, setForceReencode] = useState(false);
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [showMemoryWarning, setShowMemoryWarning] = useState(false);
  const pendingRenderRef = useRef<(() => Promise<void>) | null>(null);

  // Ref to access Toolbar's triggerLoadDialog
  const toolbarRef = useRef<{ triggerLoadDialog: () => void }>(null);

  /** Toggle canvas renderer; canvas and forceFFmpeg are mutually exclusive. */
  const handleToggleCanvasRenderer = useCallback((v: boolean) => {
    setUseCanvasRenderer(v);
    if (v) setForceFFmpeg(false); // canvas overrides CPU-only mode
  }, []);
  const [status, setStatus] = useState('');
  const [progressStage, setProgressStage] = useState('');
  const [progressValue, setProgressValue] = useState<number | null>(null);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [ffmpegFailed, setFfmpegFailed] = useState(false);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [encoderPath, setEncoderPath] = useState<string>('');
  const [renderPlan, setRenderPlan] = useState<RenderPlan | null>(null);
  const [storageEndpoint, setStorageEndpoint] = useState('https://storage.noahcohn.com/webhook/clip-stacker');
  const [storageAuthToken, setStorageAuthToken] = useState('');
  const [isRemoteSaving, setIsRemoteSaving] = useState(false);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteLoadStage, setRemoteLoadStage] = useState('');
  const [remoteLoadProgress, setRemoteLoadProgress] = useState<number | null>(null);
  const [remoteLoadIndeterminate, setRemoteLoadIndeterminate] = useState(false);
  const [remoteUploadItems, setRemoteUploadItems] = useState<RemoteUploadItem[]>([]);
  const [pendingRemoteUploadError, setPendingRemoteUploadError] = useState<PendingRemoteUploadError | null>(null);
  const pendingRemoteUploadResolver = useRef<((action: 'retry' | 'skip' | 'abort') => void) | null>(null);
  const isRemoteLoadingRef = useRef(false);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  const resolveRemoteUploadError = useCallback((action: 'retry' | 'skip' | 'abort') => {
    pendingRemoteUploadResolver.current?.(action);
    pendingRemoteUploadResolver.current = null;
    setPendingRemoteUploadError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Clip management helpers
  // ---------------------------------------------------------------------------

  /** Add a new clip to the state and set up A/B grouping if a matching clip exists. */
  const addClipToState = useCallback(
    (newClip: Clip) => {
      setClips((prevClips) => {
        const existingNames = prevClips.map((c) => c.file.name);
        const matchIndex = findMatchingClipIndex(existingNames, newClip.file.name);

        if (matchIndex >= 0) {
          // Found a match — assign to existing group as variant B
          const matchedClip = prevClips[matchIndex];
          const groupId = matchedClip.groupId ?? createClipId();

          setClipGroups((prevGroups) => {
            const existingGroup = prevGroups.find((g) => g.id === groupId);
            if (existingGroup) {
              // Update existing group
              return prevGroups.map((g) =>
                g.id === groupId
                  ? { ...g, variants: { ...g.variants, B: { ...newClip, groupId, groupVariant: 'B' } } }
                  : g,
              );
            }
            // Create new group from matched clip + new clip
            return [
              ...prevGroups,
              {
                id: groupId,
                variants: {
                  A: { ...matchedClip, groupId, groupVariant: 'A' },
                  B: { ...newClip, groupId, groupVariant: 'B' },
                },
                activeVariant: 'B', // auto-select the new edited version
              },
            ];
          });

          // Tag the matched clip with its group
          const taggedMatch = { ...matchedClip, groupId, groupVariant: 'A' as const };
          const taggedNew = { ...newClip, groupId, groupVariant: 'B' as const };

          return prevClips.map((c, i) => (i === matchIndex ? taggedMatch : c)).concat(taggedNew);
        }

        // No match — just append
        return [...prevClips, newClip];
      });
    },
    [],
  );

  const handleAddClips = useCallback(
    async (files: File[]) => {
      setStatus('Importing clips...');
      let added = 0;

      for (const file of files) {
        const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4');
        const isAudio = file.type.startsWith('audio/') || /\.(wav|mp3)$/i.test(file.name);
        if (!isVideo && !isAudio) continue;

        try {
          const { duration, objectUrl } = await getMediaInfo(file);
          const newClip: Clip = {
            id: createClipId(),
            file,
            objectUrl,
            title: file.name,
            kind: isVideo ? 'video' : 'audio',
            duration: Math.max(MIN_CLIP_DURATION, duration),
            trimStart: 0,
            trimEnd: NaN,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
          };
          addClipToState(newClip);
          setSelectedClipId(newClip.id);
          added++;
        } catch (error) {
          setStatus(`Failed to import ${file.name}: ${(error as Error).message}`);
        }
      }

      if (added > 0) {
        setOutputUrl(null);
        setStatus(`${added} clip(s) imported.`);
      } else {
        setStatus('No media files could be imported. Check that files are valid MP4/WAV/MP3.');
      }
    },
    [addClipToState],
  );

  // ---------------------------------------------------------------------------
  // A/B group toggle
  // ---------------------------------------------------------------------------

  const handleToggleVariant = useCallback((groupId: string, variant: 'A' | 'B') => {
    setClipGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, activeVariant: variant } : g)),
    );
    setClips((prevClips) => {
      // Find the group
      // We need the latest groups state — use functional update pattern
      // The newly selected variant clip becomes the one on the timeline
      return prevClips.map((c) => {
        if (c.groupId !== groupId) return c;
        // The clip that matches the chosen variant stays, the other is "background"
        return c;
      });
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Render / merge
  // ---------------------------------------------------------------------------

  const performRender = useCallback(async () => {
    // Resolve which clips are on the timeline (active variants for grouped clips)
    const timelineClips = getTimelineClips(clips, clipGroups);
    if (timelineClips.length === 0) {
      setStatus('Upload clips before rendering.');
      return;
    }

    try {
      // Reset FFmpeg load-failure state on a new render attempt.
      setFfmpegFailed(false);

      // Clean up previous render output URL before starting a new render
      if (outputUrl) {
        URL.revokeObjectURL(outputUrl);
      }

      setEncoderPath('');
      setRenderPlan(null);
      setOutputUrl(null);
      setIsRendering(true);
      setProgressStage('Preparing render');
      setProgressValue(0);
      setProgressIndeterminate(false);
      
      // Calculate render plan before starting
      const plan = calculateRenderPlan(timelineClips, transitions, textOverlays, exportSettings);
      setRenderPlan(plan);
      setStatus(`Render plan: ${plan.description} (${plan.reason})`);

      // Track FFmpeg loading phase via the exported helper so we don't couple to
      // status message strings.
      const trackFfmpegLoading = (msg: string) => {
        setStatus(msg);
        setFfmpegLoading(isFfmpegLoading());
      };
      
      const handleProgress = (update: RenderProgressUpdate) => {
        setProgressStage(update.stage);
        setProgressIndeterminate(update.indeterminate === true);
        if (typeof update.progress === 'number') {
          setProgressValue(Math.max(0, Math.min(1, update.progress)));
        } else {
          setProgressValue(null);
        }
      };
      const result = await hybridMergeClips(
        timelineClips,
        transitions,
        exportSettings,
        trackFfmpegLoading,
        handleProgress,
        forceFFmpeg,
        textOverlays,
        useCanvasRenderer,
        audioReactive,
        forceReencode,
        plan,
      );
      const url = URL.createObjectURL(result.blob);
      setOutputUrl(url);
      setEncoderPath(result.path);
      
      // Update render plan if available from FFmpeg path
      if (result.renderPlan) {
        setRenderPlan(result.renderPlan);
      }
      
      const pathLabel =
        result.path === 'canvas'
          ? '🎨 Canvas (audio-reactive)'
          : result.path === 'webcodecs'
          ? '⚡ GPU (WebCodecs)'
          : '🖥 FFmpeg';
      setStatus(`Render complete via ${pathLabel}. Download your merged MP4.`);
      setProgressStage(`Render complete via ${pathLabel}`);
      setProgressValue(1);
      setProgressIndeterminate(false);
    } catch (error) {
      const err = error as Error;
      // Always log the full detailed message (includes embedded FFmpeg logs from our safe wrappers).
      console.error('Render failed (full details):', err);
      const recentLogs = getLastFfmpegLogs(30).join('\n');
      if (recentLogs) {
        console.error('Last captured FFmpeg logs:\n' + recentLogs);
      }
      const message = /FFmpeg failed to/i.test(err.message)
        ? err.message
        : `Render failed: ${err.message}`;
      setStatus(message);
      // Surface FFmpeg load failures separately so the retry button appears.
      if (isFfmpegLoadFailed()) {
        setFfmpegFailed(true);
      }
      // Leave logs in buffer so user can click "Copy Debug Info" to grab them.
    } finally {
      setFfmpegLoading(false);
      setIsRendering(false);
      // Always clean up FFmpeg VFS after each render attempt (success or failure)
      // to prevent memory pressure from accumulated temporary files.
      aggressiveCleanupFFmpegVFS().catch((err) => {
        console.warn('Error during FFmpeg cleanup:', err);
      });
    }
  }, [clips, clipGroups, transitions, textOverlays, exportSettings, forceFFmpeg, useCanvasRenderer, audioReactive, forceReencode, outputUrl]);

  const handleMerge = useCallback(async () => {
    // Check if high memory usage is detected based on actual timeline clips
    const timelineClipsForMemoryCheck = getTimelineClips(clips, clipGroups);
    if (isHighMemoryUsage(timelineClipsForMemoryCheck)) {
      // Show warning modal; actual render happens in handleMemoryWarningConfirm
      pendingRenderRef.current = performRender;
      setShowMemoryWarning(true);
      return;
    }

    // Otherwise, proceed directly
    await performRender();
  }, [clips, clipGroups, performRender]);

  const handleMemoryWarningConfirm = useCallback(() => {
    setShowMemoryWarning(false);
    if (pendingRenderRef.current) {
      pendingRenderRef.current();
      pendingRenderRef.current = null;
    }
  }, []);

  const handleMemoryWarningCancel = useCallback(() => {
    setShowMemoryWarning(false);
    pendingRenderRef.current = null;
    setStatus('Render cancelled.');
  }, []);

  /** Copy rich diagnostics (status + render plan + last FFmpeg logs + browser info) to clipboard. */
  const handleCopyDebugInfo = useCallback(async () => {
    const lines: string[] = [];
    lines.push(`clip_stacker debug report — ${new Date().toISOString()}`);
    lines.push(`Status: ${status || '(empty)'}`);
    if (renderPlan) {
      lines.push(`Render plan: ${renderPlan.description} | ${renderPlan.reason} | willReencode=${renderPlan.willReencode}`);
    }
    lines.push(`Encoder last used: ${encoderPath || 'n/a'}`);
    lines.push(`Clips on timeline: ${getTimelineClips(clips, clipGroups).length}`);
    const lastErr = getLastFfmpegError();
    if (lastErr) lines.push(`Last FFmpeg error log: ${lastErr}`);
    const logs = getLastFfmpegLogs(60);
    if (logs.length > 0) {
      lines.push('--- Last FFmpeg logs ---');
      lines.push(...logs);
      lines.push('--- End logs ---');
    } else {
      lines.push('(no FFmpeg logs captured in buffer)');
    }
    lines.push(`UA: ${navigator.userAgent}`);
    lines.push(`CrossOriginIsolated: ${window.crossOriginIsolated}`);
    lines.push('--- FFmpeg environment ---');
    lines.push(...getFfmpegEnvironmentDiagnostics());
    lines.push('--- End debug report ---');

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Debug info copied to clipboard (include in bug reports).');
    } catch {
      // Fallback: show in console + alert the first chunk
      console.log(text);
      setStatus('Debug info logged to console (clipboard blocked).');
      window.alert('Debug info in console. First 800 chars:\n\n' + text.slice(0, 800));
    }
  }, [status, renderPlan, encoderPath, clips, clipGroups]);

  const handleDebugResetFFmpeg = useCallback(async () => {
    setStatus('Resetting FFmpeg instance (debug action)...');
    try {
      await resetFFmpegInstance();
      const memoryStatus = getMemoryStatus();
      const message = memoryStatus 
        ? `FFmpeg instance reset. Memory: ${memoryStatus}`
        : 'FFmpeg instance reset.';
      setStatus(message);
    } catch (err) {
      setStatus(`Error resetting FFmpeg: ${(err as Error).message}`);
    }
  }, []);

  const handleRetryFfmpegLoad = useCallback(async () => {
    setStatus('Resetting FFmpeg and retrying load...');
    setFfmpegFailed(false);
    setFfmpegLoading(true);
    try {
      await resetFFmpegInstance();
      await ensureFfmpeg(
        (msg) => setStatus(msg),
        (update) => {
          setProgressStage(update.stage);
          setProgressIndeterminate(update.indeterminate === true);
        },
      );
      setStatus('FFmpeg loaded successfully. Click Render to start.');
    } catch (err) {
      const message = (err as Error).message;
      setStatus(message);
      setFfmpegFailed(true);
    } finally {
      setFfmpegLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Project save / load
  // ---------------------------------------------------------------------------

  const handleSaveProject = useCallback(async () => {
    try {
      setStatus('Exporting project JSON with source media...');
      const project = await serializeProjectWithMedia(clips, transitions, textOverlays, clipGroups, {
        mediaMode: 'embed',
      });
      const payload = JSON.stringify(project, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'clip_stacker-project.json';
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus('Project JSON exported with source media.');
    } catch (error) {
      setStatus(`Could not export project: ${(error as Error).message}`);
    }
  }, [clips, clipGroups, transitions, textOverlays]);

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
        setStatus(msg);
      } catch (error) {
        setStatus(`Could not load project: ${(error as Error).message}`);
      }
    },
    [clips],
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
            status: 'pending',
          })),
        );
        setStatus(
          clips.length > 0
            ? `Uploading clip 1/${clips.length}: ${clips[0].file.name} (0%)`
            : 'Saving project to remote storage...',
        );
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const project = await serializeProjectWithMedia(clips, transitions, textOverlays, clipGroups, {
          mediaMode: 'remote',
          mediaClient: client,
          onRemoteUploadProgress: ({ clipId, fileName, index, total, progress, status: uploadStatus, message }) => {
            setRemoteUploadItems((prev) => {
              const next = [...prev];
              const existingIndex = next.findIndex((item) => item.clipId === clipId);
              const updated: RemoteUploadItem = {
                clipId,
                fileName,
                index,
                total,
                progress,
                status: uploadStatus,
                error: message,
              };
              if (existingIndex >= 0) next[existingIndex] = updated;
              else next.push(updated);
              next.sort((a, b) => a.index - b.index);
              return next;
            });

            if (uploadStatus === 'uploading' || uploadStatus === 'uploaded') {
              const percent = Math.round(progress * 100);
              setStatus(
                `${uploadStatus === 'uploaded' ? 'Uploaded' : 'Uploading'} clip ${index}/${total}: ${fileName} (${percent}%)`,
              );
            } else if (uploadStatus === 'failed') {
              setStatus(`Upload failed for clip ${index}/${total}: ${fileName}. Choose retry, skip, or abort.`);
            } else if (uploadStatus === 'skipped') {
              setStatus(`Skipped clip ${index}/${total}: ${fileName}`);
            }
          },
          onRemoteUploadError: async ({ fileName, index, total, error }) =>
            await new Promise<'retry' | 'skip' | 'abort'>((resolve) => {
              pendingRemoteUploadResolver.current = resolve;
              setPendingRemoteUploadError({
                fileName,
                index,
                total,
                error: error.message,
              });
            }),
        });
        await client.save(projectName || 'default-project', project);
        const uploadedCount = project.clips.filter((clip) => Boolean(clip.sourceMediaUrl)).length;
        const failedCount = project.clips.length - uploadedCount;
        if (failedCount > 0) {
          setStatus(
            `Saved with ${uploadedCount}/${project.clips.length} media files (${failedCount} failed - project saved without those sourceMediaUrls; use local files as fallback).`,
          );
        } else {
          setStatus(`Saved with ${uploadedCount}/${project.clips.length} media files.`);
        }
      } catch (error) {
        setStatus((error as Error).message);
      } finally {
        pendingRemoteUploadResolver.current = null;
        setPendingRemoteUploadError(null);
        setIsRemoteSaving(false);
      }
    },
    [clips, clipGroups, transitions, textOverlays],
  );

  const handleLoadRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      if (isRemoteLoadingRef.current) return;
      isRemoteLoadingRef.current = true;
      setIsRemoteLoading(true);
      setRemoteLoadStage('Fetching project manifest...');
      setRemoteLoadProgress(0);
      setRemoteLoadIndeterminate(true);

      const handleRemoteLoadProgress = (event: RemoteProjectLoadProgressEvent) => {
        setRemoteLoadStage(event.stage);
        setRemoteLoadProgress(event.progress);
        setRemoteLoadIndeterminate(event.indeterminate);
        setStatus(event.stage);
      };

      try {
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const {
          clips: updatedClips,
          clipGroups: loadedClipGroups,
          transitions: loadedTransitions,
          textOverlays: loadedOverlays,
          skippedClipCount,
          skippedClipFileNames,
        } = await loadRemoteProject(client, projectName || 'default-project', clips, {
          onProgress: handleRemoteLoadProgress,
        });
        if (updatedClips.length > 0) {
          setClips(updatedClips);
          setClipGroups(loadedClipGroups);
          setSelectedClipId(updatedClips[updatedClips.length - 1].id);
        }
        setTransitions(loadedTransitions);
        setTextOverlays(loadedOverlays);
        setRemoteLoadStage('Remote project load complete');
        setRemoteLoadProgress(1);
        setRemoteLoadIndeterminate(false);
        let msg = `Project loaded from contabo_storage_manager endpoint (${updatedClips.length} clips applied).`;
        if (skippedClipCount > 0) {
          msg += ` ⚠️ ${skippedClipCount} clip(s) skipped — missing media: ${formatSkippedClipMessage(skippedClipFileNames)}.`;
        }
        setStatus(msg);
      } catch (error) {
        setStatus((error as Error).message);
      } finally {
        isRemoteLoadingRef.current = false;
        setIsRemoteLoading(false);
        setRemoteLoadStage('');
        setRemoteLoadProgress(null);
        setRemoteLoadIndeterminate(false);
      }
    },
    [clips],
  );

  const handleExtractAudio = useCallback(async () => {
    if (!selectedClip) return;

    // Capture id and filename at the start so they remain stable across awaits.
    const clipId = selectedClip.id;
    const baseName = selectedClip.file.name.replace(/\.[^.]+$/, '');
    const wavFileName = `${baseName}.wav`;

    try {
      const wavBlob = await extractAudioToWav(selectedClip, setStatus);

      let remoteUrl: string | undefined;
      if (storageEndpoint) {
        try {
          setStatus('Uploading WAV to remote storage...');
          const client = new ContaboStorageManagerClient(storageEndpoint, storageAuthToken);
          remoteUrl = await client.uploadMedia(wavFileName, wavBlob);
        } catch (uploadError) {
          setStatus(
            `Audio extracted but upload failed: ${(uploadError as Error).message}. Downloading locally.`,
          );
        }
      }

      // Update clip state after all async operations complete.
      if (remoteUrl) {
        setClips((prev) =>
          prev.map((c) => (c.id === clipId ? { ...c, remoteAudioUrl: remoteUrl } : c)),
        );
      }

      // Always trigger a local download of the WAV.
      const url = URL.createObjectURL(wavBlob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = wavFileName;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }

      if (remoteUrl) {
        setStatus(`Audio extracted and uploaded as "${wavFileName}". Remote URL stored in clip.`);
      } else if (!storageEndpoint) {
        setStatus(`Audio extracted and downloaded as "${wavFileName}".`);
      } else {
        setStatus(`Audio extracted as "${wavFileName}".`);
      }
    } catch (error) {
      const err = error as Error;
      console.error('Audio extraction failed (full details):', err);
      const recentLogs = getLastFfmpegLogs(20).join('\n');
      if (recentLogs) console.error('Last FFmpeg logs for extract:\n' + recentLogs);
      setStatus(`Audio extraction failed: ${err.message}`);
    }
  }, [selectedClip, storageEndpoint, storageAuthToken]);

  // ---------------------------------------------------------------------------
  // Inspector
  // ---------------------------------------------------------------------------

  const handleInspectorChange = useCallback(
    (values: ClipValues) => {
      setClips((prev) =>
        prev.map((clip) => {
          if (clip.id !== selectedClipId) return clip;
          const updated: Clip = {
            ...clip,
            title: values.title.trim() || clip.file.name,
            trimStart: Number(values.trimStart || 0),
            trimEnd: values.trimEnd === '' ? NaN : Number(values.trimEnd),
            videoFadeIn: Number(values.videoFadeIn || 0),
            videoFadeOut: Number(values.videoFadeOut || 0),
            audioFadeIn: Number(values.audioFadeIn || 0),
            audioFadeOut: Number(values.audioFadeOut || 0),
            layerIndex: Math.max(0, Math.round(Number(values.layerIndex || 0))),
            x: Number(values.x || 0),
            y: Number(values.y || 0),
            width: Math.max(0, Number(values.width || 0)),
            height: Math.max(0, Number(values.height || 0)),
            opacity: Math.min(1, Math.max(0, Number(values.opacity ?? 1))),
          };
          sanitizeClipAdjustments(updated);
          return updated;
        }),
      );
    },
    [selectedClipId],
  );

  // ---------------------------------------------------------------------------
  // RIFE frame interpolation
  // ---------------------------------------------------------------------------

  const [rifeProcessingClipId, setRifeProcessingClipId] = useState<string | null>(null);

  const handleRife = useCallback(
    async (mode: 'interpolation' | 'boomerang', multiplier: 2 | 4) => {
      if (!selectedClip || selectedClip.kind !== 'video') return;
      if (rifeProcessingClipId) return; // Already processing

      // Capture the clip's current state (including originalFps if already set)
      // before any async work so we have a stable snapshot.
      const clipSnapshot = selectedClip;

      setRifeProcessingClipId(clipSnapshot.id);
      setStatus('Preparing trimmed clip for RIFE…');

      try {
        // Step 1: Export the trimmed segment via FFmpeg (lossless copy).
        // RIFE must operate on the trimmed portion only — running it on the
        // merged video would cause morphing artifacts across scene cuts.
        const trimmedBlob = await extractTrimmedVideoClip(clipSnapshot, setStatus);

        // Step 2: Dynamically import to keep initial bundle lean
        const { processClipWithRIFE } = await import('./utils/huggingface');

        setStatus('Sending trimmed clip to RIFE (HuggingFace)…');
        const { blob } = await processClipWithRIFE(
          trimmedBlob,
          multiplier,
          mode,
          (event) => {
            setStatus(event.message ?? `RIFE: ${event.stage}…`);
          },
        );

        const modeLabel = mode === 'boomerang' ? 'boomerang' : `${multiplier}x`;
        const processedFile = new File(
          [blob],
          `rife_${modeLabel}_${clipSnapshot.file.name}`,
          { type: blob.type || 'video/mp4' },
        );
        const processedUrl = URL.createObjectURL(processedFile);
        const { duration } = await getMediaInfo(processedFile);

        setClips((prev) =>
          prev.map((c) => {
            if (c.id !== clipSnapshot.id) return c;
            // Revoke old object URL to free memory
            URL.revokeObjectURL(c.objectUrl);
            return {
              ...c,
              file: processedFile,
              objectUrl: processedUrl,
              duration,
              // The processed file is already the trimmed segment — reset trim to full.
              trimStart: 0,
              trimEnd: NaN,
              rifeProcessed: true,
              rifeMultiplier: multiplier,
              rifeMode: mode,
              // Preserve originalFps if it was already set (e.g. from a previous run)
              originalFps: c.originalFps,
            };
          }),
        );

        const modeDisplay = mode === 'boomerang' ? 'Boomerang' : `${multiplier}×`;
        setStatus(`✨ RIFE ${modeDisplay} applied to "${clipSnapshot.title}".`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`RIFE failed: ${message}`);
        console.error('RIFE processing error:', err);
      } finally {
        setRifeProcessingClipId(null);
      }
    },
    [selectedClip, rifeProcessingClipId],
  );

  // ---------------------------------------------------------------------------
  // Timeline reorder
  // ---------------------------------------------------------------------------

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setClips((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index - 1, index));
  }, []);

  const handleMoveDown = useCallback((index: number) => {
    setClips((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
    setTransitions((prev) => reindexAfterSwap(prev, index, index + 1));
  }, []);

  /**
   * Drag-and-drop reorder: move clip at `fromIndex` to be inserted before
   * position `insertBefore` in the original array (0 = before first clip,
   * clips.length = after last clip).  Transitions stay positional (slots).
   */
  const handleReorder = useCallback((fromIndex: number, insertBefore: number) => {
    // No-op when the clip would remain in its current position:
    // insertBefore === fromIndex means "insert before itself",
    // insertBefore === fromIndex + 1 means "insert after itself" — both are identity moves.
    if (insertBefore === fromIndex || insertBefore === fromIndex + 1) return;
    setClips((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      const target = insertBefore > fromIndex ? insertBefore - 1 : insertBefore;
      next.splice(target, 0, moved);
      return next;
    });
    // Transitions are positional (slot-based) so no index remapping is needed.
  }, []);

  // ---------------------------------------------------------------------------
  // Clip deletion
  // ---------------------------------------------------------------------------

  const handleDeleteClip = useCallback(
    (clipId: string) => {
      // Find the clip
      const clipIndex = clips.findIndex((c) => c.id === clipId);
      if (clipIndex < 0) return;
      const clipToDelete = clips[clipIndex];

      // Confirm deletion
      const clipTitle = clipToDelete.title || clipToDelete.file.name;
      if (!window.confirm(`Delete clip "${clipTitle}"?`)) {
        return;
      }

      // Revoke the object URL to free memory
      URL.revokeObjectURL(clipToDelete.objectUrl);

      // Get the timeline index before removing the clip (for transition reindexing)
      const timelineClipsBeforeDeletion = getTimelineClips(clips, clipGroups);
      const timelineIndex = timelineClipsBeforeDeletion.findIndex((c) => c.id === clipId);

      // Remove the clip from the clips array
      setClips((prev) => prev.filter((c) => c.id !== clipId));

      // Handle A/B group cleanup
      if (clipToDelete.groupId) {
        setClipGroups((prev) =>
          prev
            .map((group) => {
              if (group.id !== clipToDelete.groupId) return group;
              // Set the variant to null
              const updated =
                clipToDelete.groupVariant === 'A'
                  ? { ...group, variants: { ...group.variants, A: null } }
                  : { ...group, variants: { ...group.variants, B: null } };
              return updated;
            })
            // Remove groups where both variants are now null
            .filter((g) => g.variants.A !== null || g.variants.B !== null),
        );
      }

      // Clear selection if the deleted clip was selected
      if (selectedClipId === clipId) {
        setSelectedClipId(null);
      }

      // Reindex transitions if the clip was on the timeline
      if (timelineIndex >= 0) {
        setTransitions((prev) => reindexTransitions(prev, timelineIndex));
      }

      setStatus(`Deleted "${clipTitle}".`);
    },
    [clips, clipGroups, selectedClipId],
  );

  // ---------------------------------------------------------------------------
  // Transition management
  // ---------------------------------------------------------------------------

  const handleTransitionUpdate = useCallback((updated: ClipTransition) => {
    setTransitions((prev) => {
      const exists = prev.find((t) => t.afterClipIndex === updated.afterClipIndex);
      if (exists) {
        return prev.map((t) => (t.afterClipIndex === updated.afterClipIndex ? updated : t));
      }
      return [...prev, updated];
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Text overlay management
  // ---------------------------------------------------------------------------

  const handleAddTextOverlay = useCallback(() => {
    const newOverlay: TextOverlay = {
      id: createClipId(),
      text: 'Add your text here',
      fontsize: 40,
      fontcolor: '#ffffff',
      x: 50,
      y: 650,
      scrolling: false,
      scrollSpeed: 100,
      box: true,
      boxColor: 'black@0.5',
    };
    setTextOverlays((prev) => [...prev, newOverlay]);
  }, []);

  const handleUpdateTextOverlay = useCallback((overlay: TextOverlay) => {
    setTextOverlays((prev) => prev.map((o) => (o.id === overlay.id ? overlay : o)));
  }, []);

  const handleDeleteTextOverlay = useCallback((id: string) => {
    setTextOverlays((prev) => prev.filter((o) => o.id !== id));
  }, []);

  // Helper functions for keyboard shortcuts
  // Memoize timeline clips computation to avoid unnecessary recalculation during re-renders
  const timelineClips = useMemo(() => getTimelineClips(clips, clipGroups), [clips, clipGroups]);

  const handleMoveSelectedLeft = useCallback(() => {
    const index = timelineClips.findIndex((c) => c.id === selectedClipId);
    if (index > 0) handleReorder(index, index - 1);
  }, [selectedClipId, timelineClips, handleReorder]);

  const handleMoveSelectedRight = useCallback(() => {
    const index = timelineClips.findIndex((c) => c.id === selectedClipId);
    if (index >= 0 && index < timelineClips.length - 1) {
      // Move one position to the right
      handleReorder(index, index + 2);
    }
  }, [selectedClipId, timelineClips, handleReorder]);

  const handleDeleteSelectedClip = useCallback(() => {
    if (selectedClipId) handleDeleteClip(selectedClipId);
  }, [selectedClipId, handleDeleteClip]);

  // Set up keyboard shortcuts with memoization to avoid unnecessary re-renders
  const shortcutsMap = useMemo(
    () => ({
      r: handleMerge,
      s: handleSaveProject,
      l: () => toolbarRef.current?.triggerLoadDialog(),
      delete: handleDeleteSelectedClip,
      backspace: handleDeleteSelectedClip,
      'ctrl+arrowleft': handleMoveSelectedLeft,
      'ctrl+arrowright': handleMoveSelectedRight,
      'meta+arrowleft': handleMoveSelectedLeft,
      'meta+arrowright': handleMoveSelectedRight,
      '?': () => setShowKeyboardShortcuts(true),
    }),
    [
      handleMerge,
      handleSaveProject,
      handleDeleteSelectedClip,
      handleMoveSelectedLeft,
      handleMoveSelectedRight,
    ],
  );

  useKeyboardShortcuts(shortcutsMap, true);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>clip_stacker</h1>
        <p>Upload, trim, reorder, fade, and merge clips into one MP4.</p>
        {encoderPath && (
          <span className="encoder-used-badge">
            Last render:{' '}
            {encoderPath === 'canvas'
              ? '🎨 Canvas (audio-reactive)'
              : encoderPath === 'webcodecs'
              ? '⚡ GPU (WebCodecs)'
              : '🖥 FFmpeg'}
          </span>
        )}
      </header>

      <section className="panel">
        <Toolbar
          ref={toolbarRef}
          onAddClips={handleAddClips}
          onMerge={handleMerge}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
          onShowKeyboardShortcuts={() => setShowKeyboardShortcuts(true)}
          onDebugResetFFmpeg={handleDebugResetFFmpeg}
          onRetryFfmpegLoad={handleRetryFfmpegLoad}
          ffmpegLoading={ffmpegLoading}
          ffmpegLoadFailed={ffmpegFailed}
          onCopyDebugInfo={handleCopyDebugInfo}
          status={status}
          forceFFmpeg={forceFFmpeg}
          onToggleForceFFmpeg={setForceFFmpeg}
          useCanvasRenderer={useCanvasRenderer}
          onToggleCanvasRenderer={handleToggleCanvasRenderer}
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
        <StorageRow
          endpoint={storageEndpoint}
          authToken={storageAuthToken}
          onAuthTokenChange={setStorageAuthToken}
          onSaveRemote={handleSaveRemote}
          onLoadRemote={handleLoadRemote}
          isRemoteSaving={isRemoteSaving}
          isRemoteLoading={isRemoteLoading}
          remoteLoadStage={remoteLoadStage}
          remoteLoadProgress={remoteLoadProgress}
          remoteLoadIndeterminate={remoteLoadIndeterminate}
          remoteUploadItems={remoteUploadItems}
          pendingRemoteUploadError={pendingRemoteUploadError}
          onResolveRemoteUploadError={resolveRemoteUploadError}
        />
      </section>

      <section className="layout-grid">
        <ClipLibrary
          clips={clips}
          selectedClipId={selectedClipId}
          clipGroups={clipGroups}
          onSelect={setSelectedClipId}
          onToggleVariant={handleToggleVariant}
          onDelete={handleDeleteClip}
        />
        <Preview clip={selectedClip} outputUrl={outputUrl} exportFilename={exportSettings.filename} />
        <Inspector
          clip={selectedClip}
          exportSettings={exportSettings}
          onChange={handleInspectorChange}
          onExportSettingsChange={setExportSettings}
          onExtractAudio={handleExtractAudio}
          onRife={handleRife}
          rifeProcessing={rifeProcessingClipId !== null}
        />
      </section>

      <Timeline
        clips={timelineClips}
        selectedClipId={selectedClipId}
        transitions={transitions}
        onSelect={setSelectedClipId}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
        onReorder={handleReorder}
        onTransitionUpdate={handleTransitionUpdate}
        onDelete={handleDeleteClip}
      />

      <TextOverlayPanel
        overlays={textOverlays}
        onAdd={handleAddTextOverlay}
        onUpdate={handleUpdateTextOverlay}
        onDelete={handleDeleteTextOverlay}
      />

      <KeyboardShortcutsModal
        isOpen={showKeyboardShortcuts}
        onClose={() => setShowKeyboardShortcuts(false)}
      />

      <MemoryWarningModal
        isOpen={showMemoryWarning}
        clips={clips}
        onConfirm={handleMemoryWarningConfirm}
        onCancel={handleMemoryWarningCancel}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the clips that are currently "on the timeline" — resolving A/B groups
 * to their active variant.
 */
function getTimelineClips(clips: Clip[], groups: ClipGroup[]): Clip[] {
  if (groups.length === 0) return clips;

  const activeGroupClipIds = new Set<string>();
  const inactiveGroupClipIds = new Set<string>();

  for (const group of groups) {
    const active = group.variants[group.activeVariant];
    const other = group.variants[group.activeVariant === 'A' ? 'B' : 'A'];
    if (active) activeGroupClipIds.add(active.id);
    if (other) inactiveGroupClipIds.add(other.id);
  }

  return clips.filter((c) => !inactiveGroupClipIds.has(c.id));
}

/**
 * After swapping two adjacent clips at indices i and j (j = i+1),
 * transitions are positional and stay at their slots — no remapping needed.
 * Users can adjust transition types after reordering via the TransitionEditor.
 */
function reindexAfterSwap(transitions: ClipTransition[], _i: number, _j: number): ClipTransition[] {
  return transitions;
}
