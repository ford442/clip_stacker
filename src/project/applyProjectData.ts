import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipKind,
  ClipProxy,
  ClipTransition,
  MasterAudio,
  Project,
  SerializedClip,
  SerializedClipGroup,
  Sequence,
  TextOverlayStyle,
  Track,
} from '../types';
import { createClipId, getMediaInfo, MIN_CLIP_DURATION } from '../media/media';
import {
  migrateClipKeyframesToNormalized,
  migratePixelClipLayout,
  parseLayoutReferenceResolution,
} from '../composition/overlayCoords';
import {
  getColorGradeFromFinishing,
  resolveFinishingFromProject,
} from '../finishing/finishing';
import { normalizeColorManagement } from '../finishing/colorManagement';
import { resolveProjectTracks, syncTracksWithClips } from '../timeline/trackModel';
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
import { normalizeClipAutomation } from '../timeline/clipAutomation';
import { normalizeClipAudioEffects } from '../audio/audioEffects';
import { normalizeBusEffects, normalizeLaneDuck, normalizeMasterBus } from '../audio/audioBus';
import { createCaptionId, normalizeCaptions } from '../captions/subtitles';
import { createSequenceClip, syncSequenceDurations } from '../timeline/sequenceModel';
import { sanitizeSequenceClip } from '../timeline/sequenceResolve';
import { isSourceColorSpaceOverride } from '../media/sourceColorSpace';

function inferKind(savedClip: SerializedClip, file: File): ClipKind {
  if (savedClip.kind === 'audio' || savedClip.kind === 'video') return savedClip.kind;
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (/\.(wav|mp3)$/i.test(file.name)) return 'audio';
  return 'video';
}

/**
 * Beat metadata saved with a master track. Absent (or unparsable) values leave
 * the track without tempo, and `useMasterAudioBeatAnalysis` re-derives it.
 */
function restoredMasterTempo(
  saved: NonNullable<Project['masterAudio']>,
): Pick<MasterAudio, 'beatTimestamps' | 'bpmEstimate' | 'bpmConfidence'> {
  const beats = Array.isArray(saved.beatTimestamps)
    ? saved.beatTimestamps.map((t) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0)
    : [];
  return {
    ...(beats.length > 0 ? { beatTimestamps: beats } : {}),
    ...(saved.bpmEstimate != null && Number(saved.bpmEstimate) > 0
      ? { bpmEstimate: Number(saved.bpmEstimate) }
      : {}),
    ...(saved.bpmConfidence != null && Number.isFinite(Number(saved.bpmConfidence))
      ? { bpmConfidence: Math.min(1, Math.max(0, Number(saved.bpmConfidence))) }
      : {}),
  };
}

async function restoreMasterAudio(
  project: Project,
  clips: Clip[],
): Promise<MasterAudio | null> {
  const saved = project.masterAudio;
  if (!saved?.fileName) return null;

  const tempo = restoredMasterTempo(saved);

  const byName = clips.find((c) => c.file.name === saved.fileName);
  if (byName) {
    return {
      file: byName.file,
      objectUrl: byName.objectUrl,
      fileName: saved.fileName,
      duration: saved.duration,
      startTime: saved.startTime ?? 0,
      ...tempo,
    };
  }

  const mediaUrl =
    project.mediaMode === 'remote'
      ? saved.sourceMediaUrl ?? saved.sourceMediaDataUrl
      : saved.sourceMediaDataUrl ?? saved.sourceMediaUrl;
  if (!mediaUrl) return null;

  try {
    const blob = await downloadRemoteMedia(mediaUrl);
    const file = new File([blob], saved.fileName, {
      type: saved.fileType || blob.type || 'audio/mpeg',
    });
    const objectUrl = URL.createObjectURL(file);
    return {
      file,
      objectUrl,
      fileName: saved.fileName,
      duration: saved.duration,
      startTime: saved.startTime ?? 0,
      ...tempo,
    };
  } catch {
    return null;
  }
}

/**
 * Restore caption cues from a saved project.
 *
 * Everything is coerced and clamped rather than trusted: project JSON can come
 * from remote storage or a hand-edited file, and one malformed cue must not
 * take the whole timeline down. Cues missing usable text or timings are
 * dropped, and ids are regenerated when absent so the lane can key on them.
 */
function deserializeCaptions(raw: Project['captions']): CaptionEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: CaptionEntry[] = [];
  for (const saved of raw) {
    const text = typeof saved?.text === 'string' ? saved.text : '';
    if (text.trim() === '') continue;
    const startSec = Number(saved.startSec);
    const endSec = Number(saved.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    entries.push({
      id: typeof saved.id === 'string' && saved.id ? saved.id : createCaptionId(),
      startSec,
      endSec,
      text,
      ...(saved.style && typeof saved.style === 'object'
        ? { style: { ...saved.style } }
        : {}),
    });
  }
  return normalizeCaptions(entries);
}

function deserializeTransitions(raw: Project['transitions']): ClipTransition[] {
  return Array.isArray(raw)

    ? raw.map((t) => ({
        afterClipIndex: Number(t.afterClipIndex),
        type: t.type ?? 'dissolve',
        duration: Number(t.duration ?? 0.5),
        ...(t.params ? { params: t.params } : {}),
        ...(typeof t.customShader === 'string' ? { customShader: t.customShader } : {}),
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
}

function deserializeTracks(raw: Project['tracks']): Track[] | undefined {
  return Array.isArray(raw)

    ? raw.map((t): Track => {
        const kind = t.kind === 'audio' || t.kind === 'text' ? t.kind : 'video';
        // Malformed effects are dropped, not thrown on; titles lanes carry no audio.
        const audioFx = kind === 'text' ? undefined : normalizeBusEffects(t.audioFx);
        const duck = kind === 'text' ? undefined : normalizeLaneDuck(t.duck);
        return {
          id: String(t.id),
          kind,
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
          ...(audioFx ? { audioFx } : {}),
          ...(duck ? { duck } : {}),
        };
      })
    : undefined;
}

/** The sequence a saved clip plays, or null for a media clip. */
function savedSequenceClipId(saved: SerializedClip): string | null {
  const source = saved.source as { type?: unknown; sequenceId?: unknown } | undefined;
  return source?.type === 'sequence' && typeof source.sequenceId === 'string' && source.sequenceId
    ? source.sequenceId
    : null;
}

/** Saved nested sequences, coerced: malformed entries are dropped, ids deduplicated. */
function readSavedSequences(raw: Project['sequences']): Array<{
  id: string;
  name: string;
  clipIds: string[];
  tracks: Project['tracks'];
  transitions: Project['transitions'];
  textOverlays: Project['textOverlays'];
}> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out = [];
  for (const saved of raw) {
    if (!saved || typeof saved.id !== 'string' || !saved.id || seen.has(saved.id)) continue;
    seen.add(saved.id);
    out.push({
      id: saved.id,
      name: typeof saved.name === 'string' && saved.name.trim() ? saved.name : 'Sequence',
      clipIds: Array.isArray(saved.clipIds) ? saved.clipIds.map(String) : [],
      tracks: saved.tracks,
      transitions: saved.transitions,
      textOverlays: saved.textOverlays,
    });
  }
  return out;
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
  const savedSequences = readSavedSequences(project.sequences);
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

  const savedSequenceIds = new Set(savedSequences.map((seq) => seq.id));
  // Each sequence claims its clips by saved id; a clip matched to live media
  // keeps the live clip's id, so ownership is recorded on the loaded clip.
  const ownerBySavedId = new Map<string, string>();
  for (const seq of savedSequences) {
    for (const clipId of seq.clipIds) if (!ownerBySavedId.has(clipId)) ownerBySavedId.set(clipId, seq.id);
  }
  const owner = new Map<string, string>();
  for (const savedClip of project.clips) {
    const sequenceId = savedSequenceClipId(savedClip);
    if (sequenceId !== null && !savedSequenceIds.has(sequenceId)) {
      // A sequence clip whose sequence is missing (hand-edited / truncated file).
      skippedCount++;
      skippedClipFileNames.push(savedClip.title || savedClip.fileName);
      continue;
    }
    // A sequence clip has no media: it is rebuilt from its sequence.
    let liveClip =
      sequenceId !== null
        ? createSequenceClip(
            { id: sequenceId, name: savedClip.title || 'Sequence' },
            Number(savedClip.duration) || MIN_CLIP_DURATION,
            savedClip.id || createClipId(),
          )
        : byName.get(savedClip.fileName);
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
        const { duration, objectUrl, videoWidth, videoHeight, hasAudio } = await getMediaInfo(file);
        const restoredDuration = Number(savedClip.duration);
        const effectiveDuration = Number.isFinite(restoredDuration) ? restoredDuration : duration;
        const restoredWidth = savedClip.videoWidth ?? videoWidth;
        const restoredHeight = savedClip.videoHeight ?? videoHeight;
        liveClip = {
          id: savedClip.id || createClipId(),
          file,
          objectUrl,
          title: savedClip.title || savedClip.fileName,
          kind: inferKind(savedClip, file),
          duration: Math.max(MIN_CLIP_DURATION, effectiveDuration),
          ...(restoredWidth !== undefined ? { videoWidth: restoredWidth } : {}),
          ...(restoredHeight !== undefined ? { videoHeight: restoredHeight } : {}),
          ...(savedClip.hasAudio === false || savedClip.hasAudio === true
            ? { hasAudio: savedClip.hasAudio }
            : hasAudio !== undefined
              ? { hasAudio }
              : {}),
          trimStart: 0,
          trimEnd: NaN,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          // Remember the remote URL (not a data: URL) so a future remote
          // save can reuse it instead of re-uploading this clip.
          ...(/^https?:\/\//i.test(mediaUrl) ? { remoteSourceUrl: mediaUrl } : {}),
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
    if (savedClip.groupId !== undefined) liveClip.groupId = savedClip.groupId;
    else delete liveClip.groupId;
    if (savedClip.groupVariant !== undefined) liveClip.groupVariant = savedClip.groupVariant;
    else delete liveClip.groupVariant;
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
    if (savedClip.overlayBlend) liveClip.overlayBlend = savedClip.overlayBlend;
    if (savedClip.chromaKey) {
      liveClip.chromaKey = {
        color: String(savedClip.chromaKey.color),
        similarity: Number(savedClip.chromaKey.similarity),
        blend: Number(savedClip.chromaKey.blend),
      };
    }
    if (savedClip.volume != null) liveClip.volume = Number(savedClip.volume);
    if (savedClip.playbackRate != null) {
      liveClip.playbackRate = Number(savedClip.playbackRate);
    }
    if (savedClip.loopCount != null) {
      liveClip.loopCount = Number(savedClip.loopCount);
    }
    if (savedClip.reversed === true) liveClip.reversed = true;
    else delete liveClip.reversed;
    const automation = normalizeClipAutomation(savedClip.automation);
    if (automation) liveClip.automation = automation;
    else delete liveClip.automation;
    // Malformed bands are dropped rather than failing the load.
    const audioEffects = normalizeClipAudioEffects(savedClip.audioEffects);
    if (audioEffects) liveClip.audioEffects = audioEffects;
    else delete liveClip.audioEffects;
    if (usesPixelLayout && (savedClip.layerIndex ?? 0) > 0) {
      Object.assign(liveClip, migratePixelClipLayout(liveClip, layoutReference));
    }
    if (savedClip.keyframes) {
      const keyframes = usesPixelLayout
        ? migrateClipKeyframesToNormalized(savedClip.keyframes, layoutReference)
        : savedClip.keyframes;
      if (keyframes) liveClip.keyframes = keyframes;
    }
    if (savedClip.stillImage) liveClip.stillImage = savedClip.stillImage;
    if (savedClip.hasAudio === false || savedClip.hasAudio === true) {
      liveClip.hasAudio = savedClip.hasAudio;
    }
    if (Array.isArray(savedClip.beatTimestamps) && savedClip.beatTimestamps.length > 0) {
      liveClip.beatTimestamps = savedClip.beatTimestamps
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t >= 0);
    }
    if (savedClip.bpmEstimate != null && Number.isFinite(Number(savedClip.bpmEstimate))) {
      liveClip.bpmEstimate = Number(savedClip.bpmEstimate);
    }
    if (savedClip.bpmConfidence != null && Number.isFinite(Number(savedClip.bpmConfidence))) {
      liveClip.bpmConfidence = Math.min(1, Math.max(0, Number(savedClip.bpmConfidence)));
    }
    if (savedClip.bpmOverride != null && Number(savedClip.bpmOverride) > 0) {
      liveClip.bpmOverride = Number(savedClip.bpmOverride);
    }
    if (Array.isArray(savedClip.lumaHistogram) && savedClip.lumaHistogram.length === 256) {
      liveClip.lumaHistogram = savedClip.lumaHistogram.map((n) => Number(n) || 0);
    }
    if (savedClip.lumaLevels) {
      liveClip.lumaLevels = {
        black: Number(savedClip.lumaLevels.black) || 0,
        white: Number(savedClip.lumaLevels.white) || 255,
        mean: Number(savedClip.lumaLevels.mean) || 0,
      };
    }
    if (savedClip.stabilize) {
      // Only the toggle round-trips; useClipStabilization recomputes the
      // matrices from the source on load.
      liveClip.stabilize = true;
    }
    // The saved project decides; unknown ids (a newer client's) fall back to
    // the file's own tags.
    if (isSourceColorSpaceOverride(savedClip.colorSpaceOverride)) {
      liveClip.colorSpaceOverride = savedClip.colorSpaceOverride;
    } else {
      delete liveClip.colorSpaceOverride;
    }
    const proxy = sanitizeClipProxy(savedClip.proxy);
    if (proxy) {
      // useProxyBuilder looks the bytes up in the media store; a miss leaves
      // the clip on its original, never broken.
      liveClip.proxy = proxy;
    }
    sanitizeClipAdjustments(liveClip);
    // A sequence clip cannot honour speed, keys or a picture transform.
    if (sequenceId !== null) liveClip = sanitizeSequenceClip(liveClip);
    const ownerId = ownerBySavedId.get(savedClip.id);
    if (ownerId !== undefined) owner.set(liveClip.id, ownerId);
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

  const transitions = deserializeTransitions(project.transitions);

  const { textOverlays, invalidColorWarnings } = deserializeTextOverlays(
    project.textOverlays,
    usesPixelLayout,
    project.layoutReferenceResolution,
  );

  const captions = deserializeCaptions(project.captions);
  const captionStyle: Partial<TextOverlayStyle> =
    project.captionStyle && typeof project.captionStyle === 'object'
      ? { ...project.captionStyle }
      : {};

  const finishing = resolveFinishingFromProject(project);
  const colorGrade = getColorGradeFromFinishing(finishing);
  const colorManagement = normalizeColorManagement(project.colorManagement);

  const savedTracks = deserializeTracks(project.tracks);

  // The pool holds every sequence's clips (claimed above); the rest are the
  // main timeline's. A/B groups follow their clips.
  const clipsOf = (sequenceId: string | null) =>
    mapped.filter((clip) => (owner.get(clip.id) ?? null) === sequenceId);
  const groupsOf = (bodyClips: Clip[]) => {
    const ids = new Set(bodyClips.map((clip) => clip.id));
    return clipGroups.filter((group) =>
      [group.variants.A, group.variants.B].some((variant) => variant && ids.has(variant.id)),
    );
  };

  const rootClips = clipsOf(null);
  const rootGroups = groupsOf(rootClips);
  let tracks = resolveProjectTracks(savedTracks, rootClips, transitions, rootGroups);
  tracks = syncTracksWithClips(tracks, rootClips, rootGroups);

  const sequences: Sequence[] = savedSequences.map((saved) => {
    const seqClips = clipsOf(saved.id);
    const seqGroups = groupsOf(seqClips);
    const seqTransitions = deserializeTransitions(saved.transitions);
    const seqOverlays = deserializeTextOverlays(
      saved.textOverlays,
      usesPixelLayout,
      project.layoutReferenceResolution,
    );
    invalidColorWarnings.push(...seqOverlays.invalidColorWarnings);
    const seqTracks = syncTracksWithClips(
      resolveProjectTracks(deserializeTracks(saved.tracks), seqClips, seqTransitions, seqGroups),
      seqClips,
      seqGroups,
    );
    return {
      id: saved.id,
      name: saved.name,
      tracks: seqTracks,
      clips: seqClips,
      clipGroups: seqGroups,
      transitions: seqTransitions,
      textOverlays: seqOverlays.textOverlays,
    };
  });
  // Sequence clips take their sequence's current length (a hand-edited file
  // may disagree); bodies that already agree are returned as they are.
  const synced = syncSequenceDurations({
    root: { tracks, clips: rootClips, clipGroups: rootGroups, transitions, textOverlays },
    sequences,
    path: [],
  });

  const masterAudio = await restoreMasterAudio(project, mapped);

  return {
    clips: synced.root.clips,
    tracks: synced.root.tracks,
    clipGroups: rootGroups,
    sequences: synced.sequences,
    transitions,
    textOverlays,
    captions,
    captionStyle,
    masterAudio,
    masterAudioMarkers: project.masterAudioMarkers ?? [],
    masterBus: normalizeMasterBus(project.masterBus),
    colorGrade,
    finishing,
    colorManagement,
    skippedClipCount: skippedCount,
    skippedClipFileNames,
    invalidColorWarnings,
    mediaDownloadWarnings,
  };
}

/** Coerce a saved proxy record; anything malformed is dropped rather than thrown on. */
export function sanitizeClipProxy(value: unknown): ClipProxy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const width = Number(v.width);
  const height = Number(v.height);
  if (typeof v.profile !== 'string' || !v.profile) return undefined;
  if (typeof v.hash !== 'string' || !/^[0-9a-f]{16,128}$/i.test(v.hash)) return undefined;
  if (!(width > 0 && height > 0)) return undefined;
  return { profile: v.profile, hash: v.hash, width: Math.round(width), height: Math.round(height) };
}
