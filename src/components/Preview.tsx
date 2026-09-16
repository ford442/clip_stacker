import { memo, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { setPlayheadTime } from '../store/playbackStore';
import { useMediaVolume } from '../hooks/useMediaVolume';
import {
  editorActions,
  settingsStore,
  uiActions,
  useEditorClip,
  useEditorCaptions,
  useEditorCaptionStyle,
  useEditorClipGroups,
  useEditorTextOverlays,
  useEditorTimelineClips,
  useEditorTracks,
  useEditorTransitions,
  useSelectedClipId,
  useSelectedTextOverlayId,
} from '../store';
import type { Clip, TextOverlay } from '../types';
import { sanitizeFilename } from '../utils/filename';
import { shouldUseTimelinePreview } from '../webgpu/timelinePreview';
import { TimelineCompositorPreview } from './TimelineCompositorPreview';
import { WebGPUVideoPreview } from './WebGPUVideoPreview';

interface Props {
  onClipLayoutCommit?: (clipId: string, clip: Clip, editedKeyframe: boolean) => void;
  onTextOverlayLayoutCommit?: (
    overlayId: string,
    overlay: TextOverlay,
    editedKeyframe: boolean,
  ) => void;
  onPreviewDragStart?: () => void;
}

/**
 * WebGPU-accelerated preview. Single-clip mode renders fades live; timeline
 * mode composites multiple layers (hard cuts, dissolves, PiP) from the global
 * playhead position.
 */
function PreviewImpl({
  onClipLayoutCommit,
  onTextOverlayLayoutCommit,
  onPreviewDragStart,
}: Props) {
  // Every hook must run before the early returns below.
  const timelineClips = useEditorTimelineClips();
  const tracks = useEditorTracks();
  const clipGroups = useEditorClipGroups();
  const transitions = useEditorTransitions();
  const textOverlays = useEditorTextOverlays();
  const captions = useEditorCaptions();
  const captionStyle = useEditorCaptionStyle();
  const selectedClipId = useSelectedClipId();
  const clip = useEditorClip(selectedClipId);
  const selectedTextOverlayId = useSelectedTextOverlayId();
  const { exportSettings, finishing, outputUrl, showCaptionsInPreview } = useStore(
    settingsStore,
    useShallow((s) => ({
      exportSettings: s.exportSettings,
      finishing: s.finishing,
      outputUrl: s.outputUrl,
      showCaptionsInPreview: s.showCaptionsInPreview,
    })),
  );
  const exportFilename = exportSettings.filename;
  const onSelectClip = editorActions.setSelectedClipId;
  const onSelectTextOverlay = uiActions.setSelectedTextOverlayId;

  if (outputUrl) {
    const downloadFilename = exportFilename
      ? sanitizeFilename(exportFilename)
      : 'stacked.mp4';
    return (
      <section className="panel">
        <h2>Preview</h2>
        <video
          controls
          src={outputUrl}
          aria-label="Rendered output video preview. Press space to play/pause."
        />
        <a href={outputUrl} download={downloadFilename}>
          Download merged MP4
        </a>
      </section>
    );
  }

  const useTimeline = shouldUseTimelinePreview(
    timelineClips,
    transitions,
    textOverlays,
  );

  if (useTimeline) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <TimelineCompositorPreview
          timelineClips={timelineClips}
          tracks={tracks}
          clipGroups={clipGroups}
          transitions={transitions}
          textOverlays={textOverlays}
          captions={showCaptionsInPreview ? captions : undefined}
          captionStyle={captionStyle}
          exportSettings={exportSettings}
          finishing={finishing}
          selectedClipId={selectedClipId}
          selectedTextOverlayId={selectedTextOverlayId}
          onSelectClip={onSelectClip}
          onSelectTextOverlay={onSelectTextOverlay}
          onClipLayoutCommit={onClipLayoutCommit}
          onTextOverlayLayoutCommit={onTextOverlayLayoutCommit}
          onPreviewDragStart={onPreviewDragStart}
        />
      </section>
    );
  }

  if (!clip) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <div className="muted">No clip selected.</div>
      </section>
    );
  }

  if (clip.kind === 'video') {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <WebGPUVideoPreview
          clip={clip}
          finishing={finishing}
        />
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Preview</h2>
      <AudioClipPreview clip={clip} />
    </section>
  );
}

function AudioClipPreview({ clip }: { clip: Clip }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useMediaVolume(audioRef, clip.volume, clip.id);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const reportTime = () => {
      const t = audio.currentTime;
      if (!Number.isFinite(t)) return;
      setPlayheadTime(t);
    };
    audio.addEventListener('timeupdate', reportTime);
    audio.addEventListener('seeked', reportTime);
    return () => {
      audio.removeEventListener('timeupdate', reportTime);
      audio.removeEventListener('seeked', reportTime);
    };
  }, [clip.id]);

  return (
    <audio
      ref={audioRef}
      controls
      src={clip.objectUrl}
      aria-label={`Preview of ${clip.title} audio. Press space to play/pause.`}
    />
  );
}

/** Memoized so unrelated App re-renders (e.g. a text overlay edit) don't re-render the preview. */
export const Preview = memo(PreviewImpl);
