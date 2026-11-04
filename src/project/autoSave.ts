import type {
  ExportSettings,
  Project,
  SerializedClip,
} from '../types';
import { serializeProject } from './serialize';
import type { ProjectSnapshot } from './snapshot';
import { STORAGE_KEYS, safeGet, safeRemove, safeSet } from '../utils/storageKeys';

/** localStorage key for the autosaved project JSON payload. */
export const AUTO_SAVE_STORAGE_KEY = STORAGE_KEYS.autoSave.key;

/** Target budget for autosave payload (metadata + selective embeds). */
export const AUTO_SAVE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** Per-clip embed cap for autosave (smaller than manual project export). */
export const AUTO_SAVE_MAX_CLIP_BYTES = 2 * 1024 * 1024;

export const AUTO_SAVE_INTERVAL_MS = 30_000;
export const AUTO_SAVE_DEBOUNCE_MS = 2_000;

export interface AutoSaveSession {
  version: 1;
  savedAt: string;
  selectedClipId: string | null;
  exportSettings: ExportSettings;
  project: Project;
}

export interface AutoSaveOffer {
  savedAt: Date;
  clipCount: number;
  textOverlayCount: number;
  mediaMode: Project['mediaMode'];
  embeddedClipCount: number;
  referenceOnlyClipCount: number;
  unrecoverableLocalClipCount: number;
}

export interface AutoSavePersistResult {
  ok: boolean;
  mode: Project['mediaMode'];
  bytes: number;
  reason?: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Could not read media file: ${file.name}`));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error(`Could not read media file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function estimateDataUrlBytes(dataUrl: string): number {
  return dataUrl.length * 2;
}

function countEmbeddedClips(clips: SerializedClip[]): number {
  return clips.filter((clip) => Boolean(clip.sourceMediaDataUrl)).length;
}

function countReferenceClips(clips: SerializedClip[]): number {
  return clips.filter((clip) => Boolean(clip.sourceMediaUrl)).length;
}

function countUnrecoverableLocalClips(clips: SerializedClip[]): number {
  return clips.filter(
    (clip) => !clip.sourceMediaDataUrl && !clip.sourceMediaUrl,
  ).length;
}

export interface AutoSaveProjectOptions {
  embedBudgetBytes?: number;
  maxClipBytes?: number;
  forceMetadataOnly?: boolean;
}

/**
 * Build a restorable project, preferring metadata + URLs and embedding only
 * small local files. Clips are embedded first, then the master track with
 * what is left of the budget (a master track that matches a clip by name is
 * restored from that clip and needs no copy).
 */
export async function buildAutoSaveProject(
  snapshot: ProjectSnapshot,
  options: AutoSaveProjectOptions = {},
): Promise<Project> {
  const embedBudgetBytes = options.embedBudgetBytes ?? AUTO_SAVE_MAX_TOTAL_BYTES;
  const maxClipBytes = options.maxClipBytes ?? AUTO_SAVE_MAX_CLIP_BYTES;
  const forceMetadataOnly = options.forceMetadataOnly ?? false;
  const { clips, masterAudio } = snapshot;

  const project = serializeProject(snapshot);
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  let embedBudgetRemaining = embedBudgetBytes;
  let usedEmbed = false;
  let usedRemote = false;

  const enrichedClips: SerializedClip[] = [];
  for (const serialized of project.clips) {
    const clip = clipById.get(serialized.id);
    if (!clip) {
      enrichedClips.push(serialized);
      continue;
    }

    const updated: SerializedClip = { ...serialized };
    delete updated.sourceMediaDataUrl;
    delete updated.sourceMediaUrl;

    if (clip.remoteSourceUrl) {
      updated.sourceMediaUrl = clip.remoteSourceUrl;
      usedRemote = true;
      enrichedClips.push(updated);
      continue;
    }

    if (
      !forceMetadataOnly &&
      clip.file.size <= maxClipBytes &&
      embedBudgetRemaining >= clip.file.size
    ) {
      try {
        const dataUrl = await readFileAsDataUrl(clip.file);
        const estimated = estimateDataUrlBytes(dataUrl);
        if (estimated <= embedBudgetRemaining) {
          updated.sourceMediaDataUrl = dataUrl;
          embedBudgetRemaining -= estimated;
          usedEmbed = true;
        }
      } catch {
        /* fall through to metadata-only for this clip */
      }
    }

    enrichedClips.push(updated);
  }

  let savedMaster = project.masterAudio;
  if (
    savedMaster &&
    masterAudio &&
    !forceMetadataOnly &&
    !clips.some((clip) => clip.file.name === masterAudio.fileName) &&
    masterAudio.file.size <= maxClipBytes &&
    embedBudgetRemaining >= masterAudio.file.size
  ) {
    try {
      const dataUrl = await readFileAsDataUrl(masterAudio.file);
      if (estimateDataUrlBytes(dataUrl) <= embedBudgetRemaining) {
        savedMaster = { ...savedMaster, sourceMediaDataUrl: dataUrl };
        usedEmbed = true;
      }
    } catch {
      /* metadata-only master track: recovery restores its markers and tempo */
    }
  }

  const mediaMode: Project['mediaMode'] = usedEmbed
    ? 'embed'
    : usedRemote
      ? 'remote'
      : 'metadata';

  return {
    ...project,
    clips: enrichedClips,
    ...(savedMaster ? { masterAudio: savedMaster } : {}),
    mediaMode,
  };
}

export function buildAutoSaveSession(
  project: Project,
  selectedClipId: string | null,
  exportSettings: ExportSettings,
): AutoSaveSession {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    selectedClipId,
    exportSettings,
    project,
  };
}

/** Same rule as `projectSnapshotHasContent`, on the saved form. */
export function sessionHasRecoverableWork(session: AutoSaveSession): boolean {
  const { project } = session;
  return (
    project.clips.length > 0 ||
    (project.textOverlays?.length ?? 0) > 0 ||
    (project.transitions?.length ?? 0) > 0 ||
    (project.captions?.length ?? 0) > 0 ||
    project.masterAudio != null ||
    (project.masterAudioMarkers?.length ?? 0) > 0
  );
}

export function buildAutoSaveOffer(session: AutoSaveSession): AutoSaveOffer {
  const clips = session.project.clips;
  return {
    savedAt: new Date(session.savedAt),
    clipCount: clips.length,
    textOverlayCount: session.project.textOverlays?.length ?? 0,
    mediaMode: session.project.mediaMode ?? 'metadata',
    embeddedClipCount: countEmbeddedClips(clips),
    referenceOnlyClipCount: countReferenceClips(clips),
    unrecoverableLocalClipCount: countUnrecoverableLocalClips(clips),
  };
}

export function readAutoSaveSession(): AutoSaveSession | null {
  try {
    const raw = safeGet('autoSave');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutoSaveSession;
    if (parsed?.version !== 1 || !parsed.project || !Array.isArray(parsed.project.clips)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readAutoSaveOffer(): AutoSaveOffer | null {
  const session = readAutoSaveSession();
  if (!session || !sessionHasRecoverableWork(session)) return null;
  return buildAutoSaveOffer(session);
}

export function writeAutoSaveSession(session: AutoSaveSession): AutoSavePersistResult {
  const payload = JSON.stringify(session);
  const result = safeSet('autoSave', payload);
  return {
    ok: result.ok,
    mode: session.project.mediaMode ?? 'metadata',
    bytes: payload.length,
    ...(result.ok ? {} : { reason: result.reason === 'quota' ? 'quota' : result.message }),
  };
}

/** Best effort: a blocked storage has nothing to clear. Never throws. */
export function clearAutoSave(): void {
  safeRemove('autoSave');
}

/**
 * What a save would write, as a string to compare against the last save.
 * Built from the same snapshot as the save itself, so any edit that changes
 * the saved project (a grade alone included) changes the hash.
 */
export function hashAutoSaveState(
  snapshot: ProjectSnapshot,
  selectedClipId: string | null,
  exportSettings: ExportSettings,
): string {
  return JSON.stringify({
    project: serializeProject(snapshot),
    selectedClipId,
    exportSettings,
  });
}
