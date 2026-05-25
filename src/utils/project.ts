import type { Clip, Project, SerializedClip, ClipTransition, SerializedTransition, TextOverlay } from '../types';
import { MIN_CLIP_DURATION } from './media';

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
    ...(textOverlays.length > 0 ? { textOverlays } : {}),
  };
}

export function applyProjectData(
  project: Project,
  clips: Clip[],
): { clips: Clip[]; transitions: ClipTransition[]; textOverlays: TextOverlay[]; skippedClipCount: number } {
  if (!project || !Array.isArray(project.clips)) {
    throw new Error('Project file is invalid.');
  }

  const byName = new Map(clips.map((clip) => [clip.file.name, clip]));
  const mapped: Clip[] = [];
  let skippedCount = 0;

  for (const savedClip of project.clips) {
    const liveClip = byName.get(savedClip.fileName);
    if (!liveClip) {
      skippedCount++;
      continue;
    }

    liveClip.title = savedClip.title || liveClip.title;
    liveClip.trimStart = Number(savedClip.trimStart ?? liveClip.trimStart);
    liveClip.trimEnd = savedClip.trimEnd == null ? NaN : Number(savedClip.trimEnd);
    liveClip.videoFadeIn = Number(savedClip.videoFadeIn ?? liveClip.videoFadeIn);
    liveClip.videoFadeOut = Number(savedClip.videoFadeOut ?? liveClip.videoFadeOut);
    liveClip.audioFadeIn = Number(savedClip.audioFadeIn ?? liveClip.audioFadeIn);
    liveClip.audioFadeOut = Number(savedClip.audioFadeOut ?? liveClip.audioFadeOut);
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

  return { clips: mapped, transitions, textOverlays, skippedClipCount: skippedCount };
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
