import { useCallback, useState } from 'react';
import type { Clip, ClipGroup, ClipTransition, ExportSettings } from './types';
import { DEFAULT_EXPORT_SETTINGS } from './types';
import { getMediaInfo, createClipId, MIN_CLIP_DURATION } from './utils/media';
import {
  sanitizeClipAdjustments,
  serializeProject,
  applyProjectData,
  ContaboStorageManagerClient,
} from './utils/project';
import { findMatchingClipIndex } from './utils/clipMatching';
import { reindexTransitions } from './utils/transitions';
import { hybridMergeClips } from './utils/hybrid-encoder';
import { extractAudioToWav } from './ffmpeg/ffmpegService';
import { Toolbar } from './components/Toolbar';
import { StorageRow } from './components/StorageRow';
import { ClipLibrary } from './components/ClipLibrary';
import { Inspector } from './components/Inspector';
import type { ClipValues } from './components/Inspector';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';

export function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipGroups, setClipGroups] = useState<ClipGroup[]>([]);
  const [transitions, setTransitions] = useState<ClipTransition[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [forceFFmpeg, setForceFFmpeg] = useState(false);
  const [status, setStatus] = useState('');
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [encoderPath, setEncoderPath] = useState<string>('');
  const [storageEndpoint, setStorageEndpoint] = useState('');
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
      const result = await hybridMergeClips(
        timelineClips,
        transitions,
        exportSettings,
        setStatus,
        forceFFmpeg,
      );
      const url = URL.createObjectURL(result.blob);
      setOutputUrl(url);
      setEncoderPath(result.path);
      setStatus(
        `Render complete via ${result.path === 'webcodecs' ? '⚡ GPU (WebCodecs)' : '🖥 FFmpeg'}. Download your merged MP4.`,
      );
    } catch (error) {
      setStatus(`Render failed: ${(error as Error).message}`);
    }
  }, [clips, clipGroups, transitions, exportSettings, forceFFmpeg]);

  // ---------------------------------------------------------------------------
  // Project save / load
  // ---------------------------------------------------------------------------

  const handleSaveProject = useCallback(() => {
    const timelineClips = getTimelineClips(clips, clipGroups);
    const payload = JSON.stringify(serializeProject(timelineClips, transitions), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'clip_stacker-project.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Project JSON exported.');
  }, [clips, clipGroups, transitions]);

  const handleLoadProject = useCallback(
    async (file: File) => {
      try {
        const parsed = JSON.parse(await file.text());
        const { clips: updatedClips, transitions: loadedTransitions, skippedClipCount } = applyProjectData(parsed, clips);
        if (updatedClips.length > 0) {
          setClips(updatedClips);
          setSelectedClipId(updatedClips[updatedClips.length - 1].id);
        }
        setTransitions(loadedTransitions);
        let msg = `Project JSON loaded (${updatedClips.length} clips applied).`;
        if (skippedClipCount > 0) {
          msg += ` ⚠️ ${skippedClipCount} clip(s) skipped — original media files not found.`;
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
        const timelineClips = getTimelineClips(clips, clipGroups);
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        await client.save(projectName || 'default-project', serializeProject(timelineClips, transitions));
        setStatus('Project saved to contabo_storage_manager endpoint.');
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [clips, clipGroups, transitions],
  );

  const handleLoadRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      try {
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const payload = await client.load(projectName || 'default-project');
        const { clips: updatedClips, transitions: loadedTransitions, skippedClipCount } = applyProjectData(payload, clips);
        if (updatedClips.length > 0) {
          setClips(updatedClips);
          setSelectedClipId(updatedClips[updatedClips.length - 1].id);
        }
        setTransitions(loadedTransitions);
        let msg = `Project loaded from contabo_storage_manager endpoint (${updatedClips.length} clips applied).`;
        if (skippedClipCount > 0) {
          msg += ` ⚠️ ${skippedClipCount} clip(s) skipped — original media files not found.`;
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

    try {
      const wavBlob = await extractAudioToWav(selectedClip, setStatus);
      const baseName = selectedClip.file.name.replace(/\.[^.]+$/, '');
      const wavFileName = `${baseName}.wav`;

      let remoteUrl: string | undefined;
      if (storageEndpoint) {
        try {
          setStatus('Uploading WAV to remote storage...');
          const client = new ContaboStorageManagerClient(storageEndpoint, storageAuthToken);
          remoteUrl = await client.uploadMedia(wavFileName, wavBlob);
          setClips((prev) =>
            prev.map((c) => (c.id === selectedClip.id ? { ...c, remoteAudioUrl: remoteUrl } : c)),
          );
          setStatus(`Audio extracted and uploaded. Remote URL stored in clip.`);
        } catch (uploadError) {
          setStatus(
            `Audio extracted but upload failed: ${(uploadError as Error).message}. Downloading locally.`,
          );
        }
      }

      // Always trigger a local download of the WAV.
      const url = URL.createObjectURL(wavBlob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = wavFileName;
      anchor.click();
      URL.revokeObjectURL(url);

      if (!storageEndpoint && !remoteUrl) {
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

  // Sync transitions when clips list changes (ensure valid indices)
  const timelineClips = getTimelineClips(clips, clipGroups);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>clip_stacker</h1>
        <p>Upload, trim, reorder, fade, and merge clips into one MP4.</p>
        {encoderPath && (
          <span className="encoder-used-badge">
            Last render: {encoderPath === 'webcodecs' ? '⚡ GPU (WebCodecs)' : '🖥 FFmpeg'}
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
        />
        <StorageRow
          endpoint={storageEndpoint}
          authToken={storageAuthToken}
          onEndpointChange={setStorageEndpoint}
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
        onTransitionUpdate={handleTransitionUpdate}
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

