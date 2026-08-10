import type {
  Clip,
  ClipGroup,
  ClipKind,
  ClipTransition,
  Project,
  SerializedClip,
  SerializedClipGroup,
  Track,
} from '../../types';
import { createClipId, getMediaInfo, MIN_CLIP_DURATION } from '../media';
import {
  migrateClipKeyframesToNormalized,
  migratePixelClipLayout,
  parseLayoutReferenceResolution,
} from '../overlayCoords';
import {
  getColorGradeFromFinishing,
  resolveFinishingFromProject,
} from '../finishing';
import { resolveProjectTracks, syncTracksWithClips } from '../trackModel';
import { sanitizeClipAdjustments } from './clipHelpers';
import { downloadRemoteMedia } from './remoteMedia';
import {
  buildRemoteDownloadStage,
  calculateRemoteDownloadProgress,
  countRemoteProjectDownloads,
  emitRemoteProjectLoadProgress,
  hasRestorableRemoteMedia,
  selectMediaSource,
} from './remoteLoadProgress';
import { deserializeTextOverlays, usesPixelLayoutForProject } from './applyTextOverlays';
import type { AppliedProjectData, ApplyProjectDataOptions } from './types';
import { normalizeClipAutomation } from '../clipAutomation';

function inferKind(savedClip: SerializedClip, file: File): ClipKind {
  if (savedClip.kind === 'audio' || savedClip.kind === 'video') return savedClip.kind;
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (/\.(wav|mp3)$/i.test(file.name)) return 'audio';
  return 'video';
}

export async function applyProjectData(
  project: Project,
  clips: Clip[],
  options: ApplyProjectDataOptions = {},
): Promise<AppliedProjectData> {
  if (!project || !Array.isArray(project.clips)) {
    throw new Error('Project file is invalid.');
  }

  const usesPixelLayout = usesPixelLayoutForProject(project.schemaVersion);
  const layoutReference = parseLayoutReferenceResolution(
    project.layoutReferenceResolution,
  );

  const byName = new Map(clips.map((clip) => [clip.file.name, clip]));
  const mapped: Clip[] = [];
  let skippedCount = 0;
  const skippedClipFileNames: string[] = [];
  const mediaDownloadWarnings: string[] = [];
  const totalRemoteDownloads = countRemoteProjectDownloads(project, clips);
  const remoteProgressStart = options.remoteProgressStart ?? 0;
  const remoteProgressEnd = options.remoteProgressEnd ?? 1;
  let remoteDownloadIndex = 0;

  for (const savedClip of project.clips) {
    let liveClip = byName.get(savedClip.fileName);
    if (!liveClip && hasRestorableRemoteMedia(savedClip)) {
      remoteDownloadIndex += 1;
      const clipIndex = remoteDownloadIndex;
      const clipCount = totalRemoteDownloads;
      const stage = buildRemoteDownloadStage(clipIndex, clipCount, savedClip.fileName);
      emitRemoteProjectLoadProgress(options.onProgress, {
        stage,
        progress: calculateRemoteDownloadProgress(
          clipIndex,
          clipCount,
          0,
          remoteProgressStart,
          remoteProgressEnd,
        ),
        indeterminate: true,
        clipIndex,
        clipCount,
        fileName: savedClip.fileName,
      });
      try {
        const mediaUrl = selectMediaSource(savedClip, project.mediaMode);
        if (!mediaUrl) throw new Error('No media URL available');
        const blob = await downloadRemoteMedia(mediaUrl, (clipProgress, indeterminate) => {
          emitRemoteProjectLoadProgress(options.onProgress, {
            stage,
            progress: calculateRemoteDownloadProgress(
              clipIndex,
              clipCount,
              clipProgress,
              remoteProgressStart,
              remoteProgressEnd,
            ),
            indeterminate,
            clipIndex,
            clipCount,
            fileName: savedClip.fileName,
          });
        });
        emitRemoteProjectLoadProgress(options.onProgress, {
          stage: `Preparing clip ${clipIndex} of ${clipCount}: ${savedClip.fileName}`,
          progress: calculateRemoteDownloadProgress(
            clipIndex,
            clipCount,
            1,
            remoteProgressStart,
            remoteProgressEnd,
          ),
          indeterminate: true,
          clipIndex,
          clipCount,
          fileName: savedClip.fileName,
        });
        const fileType = blob.type || savedClip.fileType || 'application/octet-stream';
        const file = new File([blob], savedClip.fileName, { type: fileType });
        const { duration, objectUrl, videoWidth, videoHeight } = await getMediaInfo(file);
        const restoredDuration = Number(savedClip.duration);
        const effectiveDuration = Number.isFinite(restoredDuration) ? restoredDuration : duration;
        liveClip = {
          id: savedClip.id || createClipId(),
          file,
          objectUrl,
          title: savedClip.title || savedClip.fileName,
          kind: inferKind(savedClip, file),
          duration: Math.max(MIN_CLIP_DURATION, effectiveDuration),
          videoWidth: savedClip.videoWidth ?? videoWidth,
          videoHeight: savedClip.videoHeight ?? videoHeight,
          trimStart: 0,
          trimEnd: NaN,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          // Remember the remote URL (not a data: URL) so a future remote
          // save can reuse it instead of re-uploading this clip.
          remoteSourceUrl: /^https?:\/\//i.test(mediaUrl) ? mediaUrl : undefined,
        };
      } catch (error) {
        const message = (error as Error).message || String(error);
        console.warn(`Could not restore media for "${savedClip.fileName}": ${message}`, error);
        mediaDownloadWarnings.push(`"${savedClip.fileName}": ${message}`);
        liveClip = undefined;
      }
    }
    if (!liveClip) {
      skippedCount++;
      skippedClipFileNames.push(savedClip.fileName);
      continue;
    }

    liveClip.title = savedClip.title || liveClip.title;
    liveClip.trimStart = Number(savedClip.trimStart ?? liveClip.trimStart);
    liveClip.trimEnd = savedClip.trimEnd == null ? NaN : Number(savedClip.trimEnd);
    liveClip.videoFadeIn = Number(savedClip.videoFadeIn ?? liveClip.videoFadeIn);
    liveClip.videoFadeOut = Number(savedClip.videoFadeOut ?? liveClip.videoFadeOut);
    liveClip.audioFadeIn = Number(savedClip.audioFadeIn ?? liveClip.audioFadeIn);
    liveClip.audioFadeOut = Number(savedClip.audioFadeOut ?? liveClip.audioFadeOut);
    liveClip.groupId = savedClip.groupId;
    liveClip.groupVariant = savedClip.groupVariant;
    if (savedClip.remoteAudioUrl) liveClip.remoteAudioUrl = savedClip.remoteAudioUrl;
    if (savedClip.rifeProcessed) {
      liveClip.rifeProcessed = savedClip.rifeProcessed;
      if (savedClip.rifeMultiplier != null) liveClip.rifeMultiplier = savedClip.rifeMultiplier;
      if (savedClip.originalFps != null) liveClip.originalFps = savedClip.originalFps;
      if (savedClip.processedFps != null) liveClip.processedFps = savedClip.processedFps;
      if (savedClip.rifeMode) liveClip.rifeMode = savedClip.rifeMode;
    }
    if (savedClip.layerIndex != null) liveClip.layerIndex = Number(savedClip.layerIndex);
    if (savedClip.x != null) liveClip.x = Number(savedClip.x);
    if (savedClip.y != null) liveClip.y = Number(savedClip.y);
    if (savedClip.width != null) liveClip.width = Number(savedClip.width);
    if (savedClip.height != null) liveClip.height = Number(savedClip.height);
    if (savedClip.opacity != null) liveClip.opacity = Number(savedClip.opacity);
    if (savedClip.volume != null) liveClip.volume = Number(savedClip.volume);
    if (savedClip.playbackRate != null) {
      liveClip.playbackRate = Number(savedClip.playbackRate);
    }
    const automation = normalizeClipAutomation(savedClip.automation);
    if (automation) liveClip.automation = automation;
    else delete liveClip.automation;
    if (usesPixelLayout && (savedClip.layerIndex ?? 0) > 0) {
      const migrated = migratePixelClipLayout(liveClip, layoutReference);
      liveClip.x = migrated.x;
      liveClip.y = migrated.y;
      liveClip.width = migrated.width;
      liveClip.height = migrated.height;
    }
    if (savedClip.keyframes) {
      liveClip.keyframes = usesPixelLayout
        ? migrateClipKeyframesToNormalized(savedClip.keyframes, layoutReference)
        : savedClip.keyframes;
    }
    if (savedClip.stillImage) liveClip.stillImage = savedClip.stillImage;
    if (Array.isArray(savedClip.beatTimestamps) && savedClip.beatTimestamps.length > 0) {
      liveClip.beatTimestamps = savedClip.beatTimestamps
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t >= 0);
    }
    if (savedClip.bpmEstimate != null && Number.isFinite(Number(savedClip.bpmEstimate))) {
      liveClip.bpmEstimate = Number(savedClip.bpmEstimate);
    }
    sanitizeClipAdjustments(liveClip);
    mapped.push(liveClip);
  }

  const activeVariantByGroupId = new Map<string, 'A' | 'B'>(
    Array.isArray(project.clipGroups)
      ? project.clipGroups
          .filter((group): group is SerializedClipGroup => Boolean(group?.id))
          .map((group) => [group.id, group.activeVariant === 'B' ? 'B' : 'A'])
      : [],
  );
  const clipGroupsById = new Map<string, ClipGroup>();
  const clipGroups: ClipGroup[] = [];

  for (const clip of mapped) {
    if (!clip.groupId || !clip.groupVariant) continue;
    let group = clipGroupsById.get(clip.groupId);
    if (!group) {
      group = {
        id: clip.groupId,
        variants: { A: null, B: null },
        activeVariant: activeVariantByGroupId.get(clip.groupId) ?? 'A',
      };
      clipGroupsById.set(clip.groupId, group);
      clipGroups.push(group);
    }
    group.variants[clip.groupVariant] = clip;
  }

  const transitions: ClipTransition[] = Array.isArray(project.transitions)
    ? project.transitions.map((t) => ({
        afterClipIndex: Number(t.afterClipIndex),
        type: t.type ?? 'dissolve',
        duration: Number(t.duration ?? 0.5),
        ...(t.params ? { params: t.params } : {}),
        ...(t.morphSegment
          ? {
              morphSegment: {
                objectUrl: '',
                fileName: t.morphSegment.fileName ?? 'morph.mp4',
                duration: Number(t.morphSegment.duration ?? t.duration ?? 0.5),
                status: t.morphSegment.status ?? 'pending',
                ...(t.morphSegment.error ? { error: t.morphSegment.error } : {}),
              },
            }
          : {}),
      }))
    : [];

  const { textOverlays, invalidColorWarnings } = deserializeTextOverlays(
    project.textOverlays,
    usesPixelLayout,
    project.layoutReferenceResolution,
  );

  const finishing = resolveFinishingFromProject(project);
  const colorGrade = getColorGradeFromFinishing(finishing);

  const savedTracks = Array.isArray(project.tracks)
    ? project.tracks.map(
        (t): Track => ({
          id: String(t.id),
          kind: t.kind === 'audio' || t.kind === 'text' ? t.kind : 'video',
          ...(t.label ? { label: String(t.label) } : {}),
          items: Array.isArray(t.items)
            ? t.items.map((item) => ({
                clipId: String(item.clipId),
                startTime: Number(item.startTime) || 0,
              }))
            : [],
          ...(t.muted ? { muted: true } : {}),
          ...(t.locked ? { locked: true } : {}),
          ...(t.height != null ? { height: Number(t.height) } : {}),
        }),
      )
    : undefined;

  let tracks = resolveProjectTracks(savedTracks, mapped, transitions, clipGroups);
  tracks = syncTracksWithClips(tracks, mapped, clipGroups);

  return {
    clips: mapped,
    tracks,
    clipGroups,
    transitions,
    textOverlays,
    colorGrade,
    finishing,
    skippedClipCount: skippedCount,
    skippedClipFileNames,
    invalidColorWarnings,
    mediaDownloadWarnings,
  };
}
