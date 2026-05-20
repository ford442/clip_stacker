import type { Clip, Project, SerializedClip, ClipTransition, SerializedTransition } from '../types';
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

export function serializeProject(clips: Clip[], transitions: ClipTransition[] = []): Project {
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
    })),
    transitions: transitions.map((t): SerializedTransition => ({
      afterClipIndex: t.afterClipIndex,
      type: t.type,
      duration: t.duration,
    })),
  };
}

export function applyProjectData(
  project: Project,
  clips: Clip[],
): { clips: Clip[]; transitions: ClipTransition[]; skippedClipCount: number } {
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

  return { clips: mapped, transitions, skippedClipCount: skippedCount };
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
}
