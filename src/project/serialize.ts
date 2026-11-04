import type {
  CaptionEntry,
  Project,
  SerializedClip,
  SerializedMasterAudio,
  SerializedTransition,
  SerializedClipGroup,
  SerializedTrack,
  SyncMarker,
} from '../types';
import { PROJECT_SCHEMA_VERSION } from '../types';
import { isFinishingActive } from '../finishing/finishing';
import { isColorManagementActive } from '../finishing/colorManagement';
import { normalizeClipAutomation } from '../timeline/clipAutomation';
import { normalizeClipAudioEffects } from '../audio/audioEffects';
import {
  normalizeBusEffects,
  normalizeLaneDuck,
  normalizeMasterBus,
} from '../audio/audioBus';
import { normalizeCaptions } from '../captions/subtitles';
import type { ProjectSnapshot } from './snapshot';

export interface SerializeProjectOptions {
  /** Canvas size text overlays were laid out against (`"1920x1080"`). */
  layoutReferenceResolution?: string;
}

/**
 * Serialize a project snapshot to its JSON form (metadata only — media is
 * added by `serializeProjectWithMedia` / autosave). Build the snapshot with
 * `selectProjectSnapshot` so every caller saves the same state.
 */
export function serializeProject(
  snapshot: ProjectSnapshot,
  { layoutReferenceResolution }: SerializeProjectOptions = {},
): Project {
  const {
    clips,
    transitions,
    textOverlays,
    clipGroups,
    finishing,
    tracks,
    masterAudio,
    masterAudioMarkers,
    captions,
    captionStyle,
    colorManagement,
    masterBus,
  } = snapshot;
  const serializedTracks: SerializedTrack[] = tracks.map((track) => {
    // Bypassed effects round-trip too, like clip inserts.
    const audioFx = normalizeBusEffects(track.audioFx);
    const duck = normalizeLaneDuck(track.duck);
    return {
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
      ...(audioFx ? { audioFx } : {}),
      ...(duck ? { duck } : {}),
    };
  });
  const savedMasterBus = normalizeMasterBus(masterBus);

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...(layoutReferenceResolution
      ? { layoutReferenceResolution }
      : {}),
    ...(serializedTracks.length > 0 ? { tracks: serializedTracks } : {}),
    clips: clips.map((clip): SerializedClip => {
      const automation = normalizeClipAutomation(clip.automation);
      // Bypassed blocks round-trip too: the settings survive a toggle.
      const audioEffects = normalizeClipAudioEffects(clip.audioEffects);
      return {
      id: clip.id,
      title: clip.title,
      kind: clip.kind,
      duration: clip.duration,
      ...(clip.videoWidth ? { videoWidth: clip.videoWidth } : {}),
      ...(clip.videoHeight ? { videoHeight: clip.videoHeight } : {}),
      ...(clip.hasAudio === false || clip.hasAudio === true
        ? { hasAudio: clip.hasAudio }
        : {}),
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
      ...(clip.loopCount != null && clip.loopCount !== 1
        ? { loopCount: clip.loopCount }
        : {}),
      ...(clip.reversed ? { reversed: true } : {}),
      ...(automation ? { automation } : {}),
      ...(audioEffects ? { audioEffects } : {}),
      fileName: clip.file.name,
      ...(clip.file.type ? { fileType: clip.file.type } : {}),
      ...(clip.groupId ? { groupId: clip.groupId } : {}),
      ...(clip.groupVariant ? { groupVariant: clip.groupVariant } : {}),
      ...(clip.remoteAudioUrl ? { remoteAudioUrl: clip.remoteAudioUrl } : {}),
      ...(clip.rifeProcessed ? {
        rifeProcessed: clip.rifeProcessed,
        ...(clip.rifeMultiplier !== undefined ? { rifeMultiplier: clip.rifeMultiplier } : {}),
        ...(clip.originalFps !== undefined ? { originalFps: clip.originalFps } : {}),
        ...(clip.processedFps !== undefined ? { processedFps: clip.processedFps } : {}),
        ...(clip.rifeMode !== undefined ? { rifeMode: clip.rifeMode } : {}),
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
      ...(clip.overlayBlend ? { overlayBlend: clip.overlayBlend } : {}),
      ...(clip.chromaKey ? { chromaKey: { ...clip.chromaKey } } : {}),
      ...(clip.keyframes ? { keyframes: clip.keyframes } : {}),
      ...(clip.stillImage ? { stillImage: true } : {}),
      ...(clip.beatTimestamps && clip.beatTimestamps.length > 0
        ? { beatTimestamps: clip.beatTimestamps.slice() }
        : {}),
      ...(clip.bpmEstimate != null ? { bpmEstimate: clip.bpmEstimate } : {}),
      ...(clip.bpmConfidence != null ? { bpmConfidence: clip.bpmConfidence } : {}),
      ...(clip.bpmOverride != null ? { bpmOverride: clip.bpmOverride } : {}),
      ...(clip.lumaHistogram && clip.lumaHistogram.length === 256
        ? { lumaHistogram: clip.lumaHistogram.slice() }
        : {}),
      ...(clip.lumaLevels ? { lumaLevels: { ...clip.lumaLevels } } : {}),
      ...(clip.stabilize ? { stabilize: true } : {}),
      // The record only — proxy bytes live in the media store, never in JSON.
      ...(clip.proxy ? { proxy: { ...clip.proxy } } : {}),
    };
    }),
    transitions: transitions.map((t): SerializedTransition => ({
      afterClipIndex: t.afterClipIndex,
      type: t.type,
      duration: t.duration,
      ...(t.params ? { params: t.params } : {}),
      ...(t.customShader ? { customShader: t.customShader } : {}),
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
    ...(captions.length > 0
      ? {
          captions: normalizeCaptions(captions).map((caption): CaptionEntry => ({
            id: caption.id,
            startSec: caption.startSec,
            endSec: caption.endSec,
            text: caption.text,
            ...(caption.style && Object.keys(caption.style).length > 0
              ? { style: { ...caption.style } }
              : {}),
          })),
        }
      : {}),
    ...(Object.keys(captionStyle).length > 0 ? { captionStyle: { ...captionStyle } } : {}),
    ...(isFinishingActive(finishing) ? { finishing } : {}),
    ...(isColorManagementActive(colorManagement) ? { colorManagement } : {}),
    ...(savedMasterBus ? { masterBus: savedMasterBus } : {}),
    ...(masterAudioMarkers.length > 0
      ? {
          masterAudioMarkers: masterAudioMarkers.map((marker): SyncMarker => ({
            id: marker.id,
            time: marker.time,
            text: marker.text,
            ...(marker.linkedId ? { linkedId: marker.linkedId } : {}),
          })),
        }
      : {}),
    ...(masterAudio
      ? {
          masterAudio: {
            fileName: masterAudio.fileName,
            duration: masterAudio.duration,
            ...(masterAudio.startTime > 0 ? { startTime: masterAudio.startTime } : {}),
            ...(masterAudio.file.type ? { fileType: masterAudio.file.type } : {}),
            ...(masterAudio.beatTimestamps && masterAudio.beatTimestamps.length > 0
              ? { beatTimestamps: masterAudio.beatTimestamps.slice() }
              : {}),
            ...(masterAudio.bpmEstimate != null
              ? { bpmEstimate: masterAudio.bpmEstimate }
              : {}),
            ...(masterAudio.bpmConfidence != null
              ? { bpmConfidence: masterAudio.bpmConfidence }
              : {}),
          } satisfies SerializedMasterAudio,
        }
      : {}),
  };
}
