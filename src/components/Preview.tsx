import { memo, useEffect, useMemo, useRef } from 'react';
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
  useEditorVisibleTextOverlays,
  useEditorTimelineClips,
  useEditorTracks,
  useEditorTransitions,
  useFinishingView,
  useSelectedClipId,
  useSelectedTextOverlayId,
} from '../store';
import type { Clip, TextOverlay } from '../types';
import { sanitizeFilename } from '../utils/filename';
import { applyFinishingPreviewView } from '../utils/finishingStack';
import { EffectsStack } from './EffectsStack';
import { TimelineCompositorPreview } from './TimelineCompositorPreview';

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
 * WebGPU-accelerated preview. Any timeline with a video clip — even a single
 * one — goes through the one compositor (`TimelineCompositorPreview`), which
 * draws exactly what export draws: lanes, transitions, titles, captions,
 * stabilization, finishing. Only an audio-only selection gets a plain player.
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
  const textOverlays = useEditorVisibleTextOverlays();
  const captions = useEditorCaptions();
  const captionStyle = useEditorCaptionStyle();
  const selectedClipId = useSelectedClipId();
  const clip = useEditorClip(selectedClipId);
  const selectedTextOverlayId = useSelectedTextOverlayId();
  const { exportSettings, finishing, colorManagement, outputUrl, showCaptionsInPreview } = useStore(
    settingsStore,
    useShallow((s) => ({
      exportSettings: s.exportSettings,
      finishing: s.finishing,
      colorManagement: s.colorManagement,
      outputUrl: s.outputUrl,
      showCaptionsInPreview: s.showCaptionsInPreview,
    })),
  );
  // Bypass / "show before" are preview-only; export reads the store's finishing.
  const finishingView = useFinishingView();
  const previewFinishing = useMemo(
    () => applyFinishingPreviewView(finishing, finishingView),
    [finishing, finishingView],
  );
  const exportFilename = exportSettings.filename;
  const onSelectClip = editorActions.setSelectedClipId;
  const onSelectTextOverlay = uiActions.setSelectedTextOverlayId;

  if (outputUrl) {
    const downloadFilename = exportFilename
      ? sanitizeFilename(exportFilename)
      : 'stacked.mp4';
    return (
      <section id="preview-panel" className="panel preview-panel">
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

  if (timelineClips.some((item) => item.kind === 'video')) {
    return (
      <section id="preview-panel" className="panel preview-panel">
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
          finishing={previewFinishing}
          colorManagement={colorManagement}
          selectedClipId={selectedClipId}
          selectedTextOverlayId={selectedTextOverlayId}
          onSelectClip={onSelectClip}
          onSelectTextOverlay={onSelectTextOverlay}
          onClipLayoutCommit={onClipLayoutCommit}
          onTextOverlayLayoutCommit={onTextOverlayLayoutCommit}
          onPreviewDragStart={onPreviewDragStart}
        />
        <EffectsStack />
      </section>
    );
  }

  if (!clip || clip.kind !== 'audio') {
    return (
      <section id="preview-panel" className="panel preview-panel">
        <h2>Preview</h2>
        <div className="muted">No clip selected.</div>
      </section>
    );
  }

  return (
    <section id="preview-panel" className="panel preview-panel">
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
