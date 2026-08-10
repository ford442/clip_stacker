import type {
  Clip,
  ClipGroup,
  ClipTransition,
  Project,
  SerializedClip,
  SerializedTransition,
  TextOverlay,
  SerializedClipGroup,
  Track,
  SerializedTrack,
} from '../../types';
import { PROJECT_SCHEMA_VERSION } from '../../types';
import {
  DEFAULT_FINISHING,
  isFinishingActive,
} from '../finishing';
import type { FinishingSettings } from '../finishing';
import { normalizeClipAutomation } from '../clipAutomation';
export function serializeProject(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  clipGroups: ClipGroup[] = [],
  finishing: FinishingSettings = DEFAULT_FINISHING,
  tracks: Track[] = [],
  layoutReferenceResolution?: string,
): Project {
  const serializedTracks: SerializedTrack[] = tracks.map((track) => ({
    id: track.id,
    kind: track.kind,
    ...(track.label ? { label: track.label } : {}),
    items: track.items.map((item) => ({
      clipId: item.clipId,
      startTime: item.startTime,
    })),
    ...(track.muted ? { muted: true } : {}),
    ...(track.locked ? { locked: true } : {}),
    ...(track.height != null ? { height: track.height } : {}),
  }));

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...(layoutReferenceResolution
      ? { layoutReferenceResolution }
      : {}),
    ...(serializedTracks.length > 0 ? { tracks: serializedTracks } : {}),
    clips: clips.map((clip): SerializedClip => {
      const automation = normalizeClipAutomation(clip.automation);
      return {
      id: clip.id,
      title: clip.title,
      kind: clip.kind,
      duration: clip.duration,
      ...(clip.videoWidth ? { videoWidth: clip.videoWidth } : {}),
      ...(clip.videoHeight ? { videoHeight: clip.videoHeight } : {}),
      trimStart: clip.trimStart,
      trimEnd: Number.isFinite(clip.trimEnd) ? clip.trimEnd : null,
      videoFadeIn: clip.videoFadeIn,
      videoFadeOut: clip.videoFadeOut,
      audioFadeIn: clip.audioFadeIn,
      audioFadeOut: clip.audioFadeOut,
      ...(clip.volume != null && clip.volume !== 1 ? { volume: clip.volume } : {}),
      ...(clip.playbackRate != null && clip.playbackRate !== 1
        ? { playbackRate: clip.playbackRate }
        : {}),
      ...(automation ? { automation } : {}),
      fileName: clip.file.name,
      fileType: clip.file.type || undefined,
      ...(clip.groupId ? { groupId: clip.groupId } : {}),
      ...(clip.groupVariant ? { groupVariant: clip.groupVariant } : {}),
      ...(clip.remoteAudioUrl ? { remoteAudioUrl: clip.remoteAudioUrl } : {}),
      ...(clip.rifeProcessed ? {
        rifeProcessed: clip.rifeProcessed,
        rifeMultiplier: clip.rifeMultiplier,
        originalFps: clip.originalFps,
        processedFps: clip.processedFps,
        rifeMode: clip.rifeMode,
      } : {}),
      ...((clip.layerIndex ?? 0) > 0 ||
      clip.x ||
      clip.y ||
      clip.width ||
      clip.height ||
      (clip.opacity != null && clip.opacity !== 1) ||
      clip.keyframes ||
      clip.stillImage
        ? {
            layerIndex: clip.layerIndex ?? 0,
            x: clip.x ?? 0,
            y: clip.y ?? 0,
            width: clip.width ?? 0,
            height: clip.height ?? 0,
            opacity: clip.opacity ?? 1,
          }
        : {}),
      ...(clip.keyframes ? { keyframes: clip.keyframes } : {}),
      ...(clip.stillImage ? { stillImage: true } : {}),
      ...(clip.beatTimestamps && clip.beatTimestamps.length > 0
        ? { beatTimestamps: clip.beatTimestamps.slice() }
        : {}),
      ...(clip.bpmEstimate != null ? { bpmEstimate: clip.bpmEstimate } : {}),
    };
    }),
    transitions: transitions.map((t): SerializedTransition => ({
      afterClipIndex: t.afterClipIndex,
      type: t.type,
      duration: t.duration,
      ...(t.params ? { params: t.params } : {}),
      ...(t.morphSegment
        ? {
            morphSegment: {
              fileName: t.morphSegment.fileName,
              duration: t.morphSegment.duration,
              status: t.morphSegment.status,
              ...(t.morphSegment.error ? { error: t.morphSegment.error } : {}),
            },
          }
        : {}),
    })),
    ...(clipGroups.length > 0
    ? {
        clipGroups: clipGroups.map((group): SerializedClipGroup => ({
          id: group.id,
          activeVariant: group.activeVariant,
        })),
      }
    : {}),
    ...(textOverlays.length > 0 ? { textOverlays } : {}),
    ...(isFinishingActive(finishing) ? { finishing } : {}),
  };
}
