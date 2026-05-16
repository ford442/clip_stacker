import { useCallback, useState } from 'react';
import type { Clip } from './types';
import { mergeClips } from './ffmpeg/ffmpegService';
import { getMediaInfo, createClipId, MIN_CLIP_DURATION } from './utils/media';
import {
  sanitizeClipAdjustments,
  serializeProject,
  applyProjectData,
  ContaboStorageManagerClient,
} from './utils/project';
import { Toolbar } from './components/Toolbar';
import { StorageRow } from './components/StorageRow';
import { ClipLibrary } from './components/ClipLibrary';
import { Inspector } from './components/Inspector';
import type { ClipValues } from './components/Inspector';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';

export function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [outputUrl, setOutputUrl] = useState<string | null>(null);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  const handleAddClips = useCallback(async (files: File[]) => {
    setStatus('Importing clips...');
    const newClips: Clip[] = [];

    for (const file of files) {
      const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4');
      const isAudio = file.type.startsWith('audio/') || /\.(wav|mp3)$/i.test(file.name);
      if (!isVideo && !isAudio) continue;

      try {
        const { duration, objectUrl } = await getMediaInfo(file);
        const clip: Clip = {
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
        newClips.push(clip);
      } catch (error) {
        setStatus(`Failed to import ${file.name}: ${(error as Error).message}`);
      }
    }

    if (newClips.length > 0) {
      setClips((prev) => [...prev, ...newClips]);
      setSelectedClipId(newClips[newClips.length - 1].id);
      setOutputUrl(null);
      setStatus(
        `${newClips.length} clip(s) imported. Existing clips were kept and the newest clip was selected.`,
      );
    } else {
      setStatus(
        'No media files could be imported. Check that files are valid video (MP4) or audio (WAV, MP3) formats.',
      );
    }
  }, []);

  const handleMerge = useCallback(async () => {
    if (clips.length === 0) {
      setStatus('Upload clips before rendering.');
      return;
    }
    try {
      const blob = await mergeClips(clips, setStatus);
      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
      setStatus('Render complete. Download your merged MP4.');
    } catch (error) {
      setStatus(`Render failed: ${(error as Error).message}`);
    }
  }, [clips]);

  const handleSaveProject = useCallback(() => {
    const payload = JSON.stringify(serializeProject(clips), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'clip_stacker-project.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Project JSON exported.');
  }, [clips]);

  const handleLoadProject = useCallback(
    async (file: File) => {
      try {
        const parsed = JSON.parse(await file.text());
        const updated = applyProjectData(parsed, clips);
        if (updated.length > 0) {
          setClips(updated);
          setSelectedClipId(updated[updated.length - 1].id);
        }
        setStatus('Project JSON loaded (matching clips applied).');
      } catch (error) {
        setStatus(`Could not load project: ${(error as Error).message}`);
      }
    },
    [clips],
  );

  const handleSaveRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      try {
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        await client.save(projectName || 'default-project', serializeProject(clips));
        setStatus('Project saved to contabo_storage_manager endpoint.');
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [clips],
  );

  const handleLoadRemote = useCallback(
    async (endpoint: string, authToken: string, projectName: string) => {
      try {
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        const payload = await client.load(projectName || 'default-project');
        const updated = applyProjectData(payload, clips);
        if (updated.length > 0) {
          setClips(updated);
          setSelectedClipId(updated[updated.length - 1].id);
        }
        setStatus('Project loaded from contabo_storage_manager endpoint.');
      } catch (error) {
        setStatus((error as Error).message);
      }
    },
    [clips],
  );

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

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    setClips((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const handleMoveDown = useCallback((index: number) => {
    setClips((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
  }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>clip_stacker</h1>
        <p>Upload, trim, reorder, fade, and merge clips into one MP4.</p>
      </header>

      <section className="panel">
        <Toolbar
          onAddClips={handleAddClips}
          onMerge={handleMerge}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
          status={status}
        />
        <StorageRow onSaveRemote={handleSaveRemote} onLoadRemote={handleLoadRemote} />
      </section>

      <section className="layout-grid">
        <ClipLibrary clips={clips} selectedClipId={selectedClipId} onSelect={setSelectedClipId} />
        <Inspector clip={selectedClip} onChange={handleInspectorChange} />
        <Preview clip={selectedClip} outputUrl={outputUrl} />
      </section>

      <Timeline
        clips={clips}
        selectedClipId={selectedClipId}
        onSelect={setSelectedClipId}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
      />
    </main>
  );
}
