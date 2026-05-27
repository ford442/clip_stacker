import { useCallback, useState } from 'react';
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay, RenderPlan } from './types';
import { DEFAULT_EXPORT_SETTINGS } from './types';
import { getMediaInfo, createClipId, MIN_CLIP_DURATION } from './utils/media';
import {
  sanitizeClipAdjustments,
  serializeProjectWithMedia,
  applyProjectData,
  ContaboStorageManagerClient,
} from './utils/project';
import { findMatchingClipIndex } from './utils/clipMatching';
import { reindexTransitions } from './utils/transitions';
import { hybridMergeClips } from './utils/hybrid-encoder';
import { extractAudioToWav, calculateRenderPlan } from './ffmpeg/ffmpegService';
import type { RenderProgressUpdate } from './ffmpeg/ffmpegService';
import { Toolbar } from './components/Toolbar';
import { StorageRow } from './components/StorageRow';
import { ClipLibrary } from './components/ClipLibrary';
import { Inspector } from './components/Inspector';
import type { ClipValues } from './components/Inspector';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';
import { TextOverlayPanel } from './components/TextOverlayPanel';

function formatSkippedClipMessage(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, and ${names.length - 3} more`;
}

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
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [encoderPath, setEncoderPath] = useState<string>('');
  const [renderPlan, setRenderPlan] = useState<RenderPlan | null>(null);
  const [storageEndpoint, setStorageEndpoint] = useState('https://storage.noahcohn.com/webhook/clip-stacker');
  const [storageAuthToken, setStorageAuthToken] = useState('');

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

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

  const handleMerge = useCallback(async () => {
    // Resolve which clips are on the timeline (active variants for grouped clips)
    const timelineClips = getTimelineClips(clips, clipGroups);
    if (timelineClips.length === 0) {
      setStatus('Upload clips before rendering.');
      return;
    }
    try {
      setEncoderPath('');
      setRenderPlan(null);
      setIsRendering(true);
      setProgressStage('Preparing render');
      setProgressValue(0);
      setProgressIndeterminate(false);
      
      // Calculate render plan before starting
      const plan = calculateRenderPlan(timelineClips, transitions, textOverlays);
      setRenderPlan(plan);
      setStatus(`Render plan: ${plan.description} (${plan.reason})`);
      
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
        setStatus,
        handleProgress,
        forceFFmpeg,
        textOverlays,
        useCanvasRenderer,
        audioReactive,
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
      setStatus(`Render failed: ${(error as Error).message}`);
    } finally {
      setIsRendering(false);
    }
  }, [clips, clipGroups, transitions, textOverlays, exportSettings, forceFFmpeg, useCanvasRenderer, audioReactive]);

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
        setStatus('Uploading project and source media...');
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const project = await serializeProjectWithMedia(clips, transitions, textOverlays, clipGroups, {
          mediaMode: 'remote',
          mediaClient: client,
        });
        await client.save(projectName || 'default-project', project);
        setStatus('Project saved to contabo_storage_manager endpoint.');
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [clips, clipGroups, transitions, textOverlays],
  );

  const handleLoadRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      try {
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const payload = await client.load(projectName || 'default-project');
        const {
          clips: updatedClips,
          clipGroups: loadedClipGroups,
          transitions: loadedTransitions,
          textOverlays: loadedOverlays,
          skippedClipCount,
          skippedClipFileNames,
        } = await applyProjectData(payload, clips);
        if (updatedClips.length > 0) {
          setClips(updatedClips);
          setClipGroups(loadedClipGroups);
          setSelectedClipId(updatedClips[updatedClips.length - 1].id);
        }
        setTransitions(loadedTransitions);
        setTextOverlays(loadedOverlays);
        let msg = `Project loaded from contabo_storage_manager endpoint (${updatedClips.length} clips applied).`;
        if (skippedClipCount > 0) {
          msg += ` ⚠️ ${skippedClipCount} clip(s) skipped — missing media: ${formatSkippedClipMessage(skippedClipFileNames)}.`;
        }
        setStatus(msg);
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [clips],
  );

  const handleExtractAudio = useCallback(async () => {
    if (!selectedClip) return;
    if (selectedClip.kind !== 'video') {
      setStatus('Audio extraction is only available for video clips.');
      return;
    }

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
        setStatus(`Audio extracted and uploaded. Remote URL stored in clip.`);
      } else if (!storageEndpoint) {
        setStatus(`Audio extracted and downloaded as "${wavFileName}".`);
      }
    } catch (error) {
      setStatus(`Audio extraction failed: ${(error as Error).message}`);
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

  // Sync transitions when clips list changes (ensure valid indices)
  const timelineClips = getTimelineClips(clips, clipGroups);

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
          onAddClips={handleAddClips}
          onMerge={handleMerge}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
          status={status}
          forceFFmpeg={forceFFmpeg}
          onToggleForceFFmpeg={setForceFFmpeg}
          useCanvasRenderer={useCanvasRenderer}
          onToggleCanvasRenderer={handleToggleCanvasRenderer}
          audioReactive={audioReactive}
          onToggleAudioReactive={setAudioReactive}
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
        <Preview clip={selectedClip} outputUrl={outputUrl} />
        <Inspector
          clip={selectedClip}
          exportSettings={exportSettings}
          onChange={handleInspectorChange}
          onExportSettingsChange={setExportSettings}
          onExtractAudio={handleExtractAudio}
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
