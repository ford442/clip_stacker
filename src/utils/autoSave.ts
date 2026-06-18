import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  Project,
  SerializedClip,
  TextOverlay,
} from '../types';
import { serializeProject } from './project';

/** localStorage key for the autosaved project JSON payload. */
export const AUTO_SAVE_STORAGE_KEY = 'clip_stacker_autosave_v1';

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

/** Build a restorable project, preferring metadata + URLs and embedding only small local files. */
export async function buildAutoSaveProject(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  clipGroups: ClipGroup[],
  options: {
    embedBudgetBytes?: number;
    maxClipBytes?: number;
    forceMetadataOnly?: boolean;
  } = {},
): Promise<Project> {
  const embedBudgetBytes = options.embedBudgetBytes ?? AUTO_SAVE_MAX_TOTAL_BYTES;
  const maxClipBytes = options.maxClipBytes ?? AUTO_SAVE_MAX_CLIP_BYTES;
  const forceMetadataOnly = options.forceMetadataOnly ?? false;

  const project = serializeProject(clips, transitions, textOverlays, clipGroups);
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

  const mediaMode: Project['mediaMode'] = usedEmbed
    ? 'embed'
    : usedRemote
      ? 'remote'
      : 'metadata';

  return { ...project, clips: enrichedClips, mediaMode };
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

export function sessionHasRecoverableWork(session: AutoSaveSession): boolean {
  return (
    session.project.clips.length > 0 ||
    (session.project.textOverlays?.length ?? 0) > 0 ||
    (session.project.transitions?.length ?? 0) > 0
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
    const raw = localStorage.getItem(AUTO_SAVE_STORAGE_KEY);
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
  try {
    localStorage.setItem(AUTO_SAVE_STORAGE_KEY, payload);
    return {
      ok: true,
      mode: session.project.mediaMode ?? 'metadata',
      bytes: payload.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isQuota =
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.code === 22);
    return {
      ok: false,
      mode: session.project.mediaMode ?? 'metadata',
      bytes: payload.length,
      reason: isQuota ? 'quota' : message,
    };
  }
}

export function clearAutoSave(): void {
  localStorage.removeItem(AUTO_SAVE_STORAGE_KEY);
}

export function hashAutoSaveState(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  clipGroups: ClipGroup[],
  selectedClipId: string | null,
  exportSettings: ExportSettings,
): string {
  const project = serializeProject(clips, transitions, textOverlays, clipGroups);
  return JSON.stringify({
    project,
    selectedClipId,
    exportSettings,
  });
}
