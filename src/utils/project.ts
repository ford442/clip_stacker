import type {
  Clip,
  ClipGroup,
  ClipKind,
  Project,
  SerializedClip,
  SerializedTransition,
  TextOverlay,
  ClipTransition,
  SerializedClipGroup,
} from '../types';
import { createClipId, getMediaInfo, MIN_CLIP_DURATION } from './media';

const FADE_SAFETY_MARGIN = 0.01;

export function getClipDuration(clip: Clip): number {
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  return Math.max(MIN_CLIP_DURATION, end - clip.trimStart);
}

export function sanitizeClipAdjustments(clip: Clip): void {
  clip.trimStart = Number.isFinite(clip.trimStart) ? Math.max(0, clip.trimStart) : 0;
  clip.trimEnd = Number.isFinite(clip.trimEnd)
    ? Math.max(clip.trimStart + MIN_CLIP_DURATION, clip.trimEnd)
    : NaN;

  const maxFade = Math.max(0, getClipDuration(clip) / 2 - FADE_SAFETY_MARGIN);
  clip.videoFadeIn = Math.min(Math.max(0, clip.videoFadeIn), maxFade);
  clip.videoFadeOut = Math.min(Math.max(0, clip.videoFadeOut), maxFade);
  clip.audioFadeIn = Math.min(Math.max(0, clip.audioFadeIn), maxFade);
  clip.audioFadeOut = Math.min(Math.max(0, clip.audioFadeOut), maxFade);
}

export function serializeProject(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  clipGroups: ClipGroup[] = [],
): Project {
  return {
    clips: clips.map((clip): SerializedClip => ({
      id: clip.id,
      title: clip.title,
      kind: clip.kind,
      duration: clip.duration,
      trimStart: clip.trimStart,
      trimEnd: Number.isFinite(clip.trimEnd) ? clip.trimEnd : null,
      videoFadeIn: clip.videoFadeIn,
      videoFadeOut: clip.videoFadeOut,
      audioFadeIn: clip.audioFadeIn,
      audioFadeOut: clip.audioFadeOut,
      fileName: clip.file.name,
      fileType: clip.file.type || undefined,
      ...(clip.groupId ? { groupId: clip.groupId } : {}),
      ...(clip.groupVariant ? { groupVariant: clip.groupVariant } : {}),
      ...(clip.remoteAudioUrl ? { remoteAudioUrl: clip.remoteAudioUrl } : {}),
      ...((clip.layerIndex ?? 0) > 0 || clip.x || clip.y || clip.width || clip.height || (clip.opacity != null && clip.opacity !== 1)
        ? {
            layerIndex: clip.layerIndex ?? 0,
            x: clip.x ?? 0,
            y: clip.y ?? 0,
            width: clip.width ?? 0,
            height: clip.height ?? 0,
            opacity: clip.opacity ?? 1,
          }
        : {}),
    })),
    transitions: transitions.map((t): SerializedTransition => ({
      afterClipIndex: t.afterClipIndex,
      type: t.type,
      duration: t.duration,
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
  };
}

interface SerializeProjectOptions {
  mediaMode?: 'metadata' | 'embed' | 'remote';
  mediaClient?: ContaboStorageManagerClient;
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Could not read media file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function serializeProjectWithMedia(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  clipGroups: ClipGroup[] = [],
  options: SerializeProjectOptions = {},
): Promise<Project> {
  const mediaMode = options.mediaMode ?? 'metadata';
  const project = serializeProject(clips, transitions, textOverlays, clipGroups);
  if (mediaMode === 'metadata') return project;

  const enrichedClips: SerializedClip[] = [];
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const serialized = project.clips[index];
    const updated: SerializedClip = { ...serialized };
    if (mediaMode === 'embed') {
      updated.sourceMediaDataUrl = await readFileAsDataUrl(clip.file);
    } else if (mediaMode === 'remote') {
      if (!options.mediaClient) throw new Error('Remote save requires a storage endpoint.');
      const uploadName = `${clip.id}-${clip.file.name}`;
      updated.sourceMediaUrl = await options.mediaClient.uploadMedia(uploadName, clip.file, clip.file.type || 'application/octet-stream');
    }
    enrichedClips.push(updated);
  }

  return { ...project, clips: enrichedClips };
}

export function applyProjectData(
  project: Project,
  clips: Clip[],
): Promise<{ clips: Clip[]; clipGroups: ClipGroup[]; transitions: ClipTransition[]; textOverlays: TextOverlay[]; skippedClipCount: number; skippedClipFileNames: string[] }>;
export async function applyProjectData(
  project: Project,
  clips: Clip[],
): Promise<{ clips: Clip[]; clipGroups: ClipGroup[]; transitions: ClipTransition[]; textOverlays: TextOverlay[]; skippedClipCount: number; skippedClipFileNames: string[] }> {
  if (!project || !Array.isArray(project.clips)) {
    throw new Error('Project file is invalid.');
  }

  const byName = new Map(clips.map((clip) => [clip.file.name, clip]));
  const mapped: Clip[] = [];
  let skippedCount = 0;
  const skippedClipFileNames: string[] = [];

  const inferKind = (savedClip: SerializedClip, file: File): ClipKind => {
    if (savedClip.kind === 'audio' || savedClip.kind === 'video') return savedClip.kind;
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.startsWith('video/')) return 'video';
    if (/\.(wav|mp3)$/i.test(file.name)) return 'audio';
    return 'video';
  };

  for (const savedClip of project.clips) {
    let liveClip = byName.get(savedClip.fileName);
    if (!liveClip && (savedClip.sourceMediaDataUrl || savedClip.sourceMediaUrl)) {
      try {
        const mediaResponse = await fetch(savedClip.sourceMediaDataUrl || savedClip.sourceMediaUrl || '');
        if (!mediaResponse.ok) throw new Error(`Media download failed (${mediaResponse.status})`);
        const blob = await mediaResponse.blob();
        const fileType = savedClip.fileType || blob.type || 'application/octet-stream';
        const file = new File([blob], savedClip.fileName, { type: fileType });
        const { duration, objectUrl } = await getMediaInfo(file);
        liveClip = {
          id: savedClip.id || createClipId(),
          file,
          objectUrl,
          title: savedClip.title || savedClip.fileName,
          kind: inferKind(savedClip, file),
          duration: Math.max(MIN_CLIP_DURATION, Number(savedClip.duration ?? duration) || duration),
          trimStart: 0,
          trimEnd: NaN,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
        };
      } catch {
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
    if (savedClip.layerIndex != null) liveClip.layerIndex = Number(savedClip.layerIndex);
    if (savedClip.x != null) liveClip.x = Number(savedClip.x);
    if (savedClip.y != null) liveClip.y = Number(savedClip.y);
    if (savedClip.width != null) liveClip.width = Number(savedClip.width);
    if (savedClip.height != null) liveClip.height = Number(savedClip.height);
    if (savedClip.opacity != null) liveClip.opacity = Number(savedClip.opacity);
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
      }))
    : [];

  const textOverlays: TextOverlay[] = Array.isArray(project.textOverlays)
    ? project.textOverlays.map((o) => ({
        id: String(o.id ?? ''),
        text: String(o.text ?? ''),
        fontsize: Number(o.fontsize ?? 40),
        fontcolor: String(o.fontcolor ?? '#ffffff'),
        x: Number(o.x ?? 50),
        y: Number(o.y ?? 650),
        scrolling: Boolean(o.scrolling),
        scrollSpeed: Number(o.scrollSpeed ?? 100),
        box: Boolean(o.box),
        boxColor: String(o.boxColor ?? 'black@0.5'),
      }))
    : [];

  return { clips: mapped, clipGroups, transitions, textOverlays, skippedClipCount: skippedCount, skippedClipFileNames };
}

export class ContaboStorageManagerClient {
  private readonly endpoint: string;
  private readonly authToken: string;

  constructor(endpoint: string, authToken?: string) {
    this.endpoint = endpoint || '';
    this.authToken = authToken?.trim() ?? '';
  }

  private getAuthHeader(): string | null {
    if (!this.authToken) return null;
    return this.authToken.startsWith('Bearer ') ? this.authToken : `Bearer ${this.authToken}`;
  }

  async save(name: string, payload: Project): Promise<void> {
    const authHeader = this.getAuthHeader();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authHeader) headers.authorization = authHeader;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, payload }),
    });
    if (!response.ok) throw new Error(`Remote save failed (${response.status})`);
  }

  async load(name: string): Promise<Project> {
    const authHeader = this.getAuthHeader();
    const response = await fetch(`${this.endpoint}?name=${encodeURIComponent(name)}`, {
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) throw new Error(`Remote load failed (${response.status})`);
    const result = (await response.json()) as { payload: Project };
    return result.payload;
  }

  async list(): Promise<{ name: string; modified: number }[]> {
    const authHeader = this.getAuthHeader();
    const response = await fetch(this.endpoint, {
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) throw new Error(`Remote list failed (${response.status})`);
    const result = (await response.json()) as { projects: { name: string; modified: number }[] };
    return result.projects ?? [];
  }

  async delete(name: string): Promise<void> {
    const authHeader = this.getAuthHeader();
    const response = await fetch(`${this.endpoint}?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) throw new Error(`Remote delete failed (${response.status})`);
  }

  private get mediaEndpoint(): string {
    return this.endpoint.replace(/\/*$/, '') + '/media';
  }

  /**
   * Upload a binary media blob (e.g. a WAV file) to the remote media endpoint.
   * The media endpoint is derived by appending `/media` to the base endpoint.
   * Expects the server to respond with `{ "url": "<public-url>" }`.
   */
  async uploadMedia(name: string, blob: Blob, mimeType = 'audio/wav'): Promise<string> {
    const authHeader = this.getAuthHeader();
    const headers: Record<string, string> = {};
    if (authHeader) headers.authorization = authHeader;

    const formData = new FormData();
    formData.append('name', name);
    formData.append('file', new File([blob], name, { type: mimeType }));

    const response = await fetch(this.mediaEndpoint, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!response.ok) throw new Error(`Media upload failed (${response.status})`);
    const result = (await response.json()) as { url: string };
    return result.url;
  }
}
