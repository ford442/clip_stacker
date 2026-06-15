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

/** Maximum number of upload attempts per clip before aborting the save. */
export const MAX_UPLOAD_RETRY_ATTEMPTS = 5;

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
      ...(clip.videoWidth ? { videoWidth: clip.videoWidth } : {}),
      ...(clip.videoHeight ? { videoHeight: clip.videoHeight } : {}),
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
      ...(clip.rifeProcessed ? {
        rifeProcessed: clip.rifeProcessed,
        rifeMultiplier: clip.rifeMultiplier,
        originalFps: clip.originalFps,
        processedFps: clip.processedFps,
        rifeMode: clip.rifeMode,
      } : {}),
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
  onRemoteUploadProgress?: (event: RemoteUploadProgressEvent) => void;
  onRemoteUploadError?: (
    event: RemoteUploadErrorEvent,
  ) => Promise<'retry' | 'skip' | 'abort'> | 'retry' | 'skip' | 'abort';
}

export interface RemoteUploadProgressEvent {
  clipId: string;
  fileName: string;
  index: number;
  total: number;
  progress: number;
  status: 'uploading' | 'uploaded' | 'failed' | 'skipped';
  message?: string;
}

export interface RemoteUploadErrorEvent extends RemoteUploadProgressEvent {
  error: Error;
  attempt: number;
  status: 'failed';
}

export interface AppliedProjectData {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  skippedClipCount: number;
  skippedClipFileNames: string[];
}

export interface RemoteProjectLoadProgressEvent {
  stage: string;
  progress: number | null;
  indeterminate: boolean;
  clipIndex?: number;
  clipCount?: number;
  fileName?: string;
}

interface ApplyProjectDataOptions {
  onProgress?: (event: RemoteProjectLoadProgressEvent) => void;
  remoteProgressStart?: number;
  remoteProgressEnd?: number;
}

interface LoadRemoteProjectOptions {
  onProgress?: (event: RemoteProjectLoadProgressEvent) => void;
}

const REMOTE_PROJECT_DOWNLOAD_PROGRESS_START = 0.08;
const REMOTE_PROJECT_DOWNLOAD_PROGRESS_END = 0.96;

function clampUnitProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress));
}

function emitRemoteProjectLoadProgress(
  onProgress: ((event: RemoteProjectLoadProgressEvent) => void) | undefined,
  event: RemoteProjectLoadProgressEvent,
): void {
  if (!onProgress) return;
  onProgress({
    ...event,
    progress: typeof event.progress === 'number' ? clampUnitProgress(event.progress) : null,
  });
}

function hasRestorableRemoteMedia(savedClip: SerializedClip): boolean {
  return Boolean(savedClip.sourceMediaDataUrl || savedClip.sourceMediaUrl);
}

function countRemoteProjectDownloads(project: Project, clips: Clip[]): number {
  if (!Array.isArray(project.clips)) return 0;
  const byName = new Map(clips.map((clip) => [clip.file.name, clip]));
  return project.clips.reduce((count, savedClip) => {
    if (byName.has(savedClip.fileName) || !hasRestorableRemoteMedia(savedClip)) return count;
    return count + 1;
  }, 0);
}

function buildRemoteDownloadStage(index: number, total: number, fileName: string): string {
  return `Downloading clip ${index} of ${total}: ${fileName}`;
}

function calculateRemoteDownloadProgress(
  clipIndex: number,
  clipCount: number,
  clipProgress: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  if (clipCount <= 0) return clampUnitProgress(rangeEnd);
  const completed = (clipIndex - 1 + clampUnitProgress(clipProgress)) / clipCount;
  return rangeStart + completed * Math.max(0, rangeEnd - rangeStart);
}

async function downloadRemoteMedia(
  mediaUrl: string,
  onProgress?: (progress: number, indeterminate: boolean) => void,
): Promise<Blob> {
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) throw new Error(`Media download failed (${mediaResponse.status})`);

  const contentLengthHeader = mediaResponse.headers.get('content-length');
  const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  const contentType = mediaResponse.headers.get('content-type') || undefined;

  if (!mediaResponse.body || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return await mediaResponse.blob();
  }

  const reader = mediaResponse.body.getReader();
  const chunks: BlobPart[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = new Uint8Array(value);
    chunks.push(chunk);
    loadedBytes += chunk.byteLength;
    onProgress?.(loadedBytes / totalBytes, false);
  }

  onProgress?.(1, false);
  return new Blob(chunks, { type: contentType });
}

function inferKind(savedClip: SerializedClip, file: File): ClipKind {
  if (savedClip.kind === 'audio' || savedClip.kind === 'video') return savedClip.kind;
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (/\.(wav|mp3)$/i.test(file.name)) return 'audio';
  return 'video';
}

function sanitizeUploadFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readFileAsDataUrl(file: File): Promise<string> {
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

  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const enrichedClips: SerializedClip[] = [];
  const total = project.clips.length;
  for (let i = 0; i < project.clips.length; i++) {
    const serialized = project.clips[i];
    const index = i + 1;
    const clip = clipById.get(serialized.id);
    if (!clip) throw new Error(`Could not find source media for clip "${serialized.fileName}".`);
    const updated: SerializedClip = { ...serialized };
    if (mediaMode === 'embed') {
      updated.sourceMediaDataUrl = await readFileAsDataUrl(clip.file);
    } else if (mediaMode === 'remote') {
      if (!options.mediaClient) throw new Error('Remote save requires a storage endpoint.');
      const uploadName = `${clip.id}-${sanitizeUploadFileName(clip.file.name)}`;
      let attempt = 0;
      while (true) {
        attempt += 1;
        options.onRemoteUploadProgress?.({
          clipId: clip.id,
          fileName: clip.file.name,
          index,
          total,
          progress: 0,
          status: 'uploading',
        });
        try {
          updated.sourceMediaUrl = await options.mediaClient.uploadMedia(
            uploadName,
            clip.file,
            clip.file.type || 'application/octet-stream',
            (progress) =>
              options.onRemoteUploadProgress?.({
                clipId: clip.id,
                fileName: clip.file.name,
                index,
                total,
                progress,
                status: 'uploading',
              }),
          );
          options.onRemoteUploadProgress?.({
            clipId: clip.id,
            fileName: clip.file.name,
            index,
            total,
            progress: 1,
            status: 'uploaded',
          });
          break;
        } catch (error) {
          const uploadError = error as Error;
          options.onRemoteUploadProgress?.({
            clipId: clip.id,
            fileName: clip.file.name,
            index,
            total,
            progress: 0,
            status: 'failed',
            message: uploadError.message,
          });
          const action = options.onRemoteUploadError
            ? await options.onRemoteUploadError({
                clipId: clip.id,
                fileName: clip.file.name,
                index,
                total,
                progress: 0,
                status: 'failed',
                message: uploadError.message,
                error: uploadError,
                attempt,
              })
            : 'abort';
          if (action === 'retry') {
            if (attempt < MAX_UPLOAD_RETRY_ATTEMPTS) continue;
            throw new Error(
              `Upload failed for clip ${index}/${total} after ${attempt} attempts: ${uploadError.message}`,
            );
          }
          if (action === 'skip') {
            options.onRemoteUploadProgress?.({
              clipId: clip.id,
              fileName: clip.file.name,
              index,
              total,
              progress: 0,
              status: 'skipped',
              message: uploadError.message,
            });
            break;
          }
          throw new Error(`Upload aborted at clip ${index}/${total}: ${uploadError.message}`);
        }
      }
    }
    enrichedClips.push(updated);
  }

  return { ...project, clips: enrichedClips };
}

export async function applyProjectData(
  project: Project,
  clips: Clip[],
  options: ApplyProjectDataOptions = {},
): Promise<AppliedProjectData> {
  if (!project || !Array.isArray(project.clips)) {
    throw new Error('Project file is invalid.');
  }

  const byName = new Map(clips.map((clip) => [clip.file.name, clip]));
  const mapped: Clip[] = [];
  let skippedCount = 0;
  const skippedClipFileNames: string[] = [];
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
        const mediaUrl = savedClip.sourceMediaDataUrl || savedClip.sourceMediaUrl;
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
          id: createClipId(),
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
        };
      } catch (error) {
        console.warn(`Could not restore media for "${savedClip.fileName}"`, error);
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

export async function loadRemoteProject(
  client: ContaboStorageManagerClient,
  name: string,
  clips: Clip[],
  options: LoadRemoteProjectOptions = {},
): Promise<AppliedProjectData> {
  emitRemoteProjectLoadProgress(options.onProgress, {
    stage: 'Fetching project manifest...',
    progress: 0,
    indeterminate: true,
  });

  const project = await client.load(name);
  const totalRemoteDownloads = countRemoteProjectDownloads(project, clips);

  if (totalRemoteDownloads === 0) {
    emitRemoteProjectLoadProgress(options.onProgress, {
      stage: 'Applying remote project data...',
      progress: REMOTE_PROJECT_DOWNLOAD_PROGRESS_START,
      indeterminate: true,
    });
  }

  const result = await applyProjectData(project, clips, {
    onProgress: options.onProgress,
    remoteProgressStart: REMOTE_PROJECT_DOWNLOAD_PROGRESS_START,
    remoteProgressEnd: REMOTE_PROJECT_DOWNLOAD_PROGRESS_END,
  });

  emitRemoteProjectLoadProgress(options.onProgress, {
    stage: 'Remote project load complete',
    progress: 1,
    indeterminate: false,
  });

  return result;
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
  async uploadMedia(
    name: string,
    blob: Blob,
    mimeType = 'audio/wav',
    onProgress?: (progress: number) => void,
  ): Promise<string> {
    const authHeader = this.getAuthHeader();
    const headers: Record<string, string> = {};
    if (authHeader) headers.authorization = authHeader;

    const formData = new FormData();
    formData.append('name', name);
    formData.append('file', new File([blob], name, { type: mimeType }));

    if (typeof XMLHttpRequest === 'undefined') {
      const response = await fetch(this.mediaEndpoint, {
        method: 'POST',
        headers,
        body: formData,
      });
      if (!response.ok) throw new Error(`Media upload failed (${response.status})`);
      const result = (await response.json()) as { url: string };
      onProgress?.(1);
      return result.url;
    }

    return await new Promise<string>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', this.mediaEndpoint);
      if (authHeader) request.setRequestHeader('authorization', authHeader);

      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress?.(Math.max(0, Math.min(1, event.loaded / event.total)));
      };

      request.onerror = () => reject(new Error('Media upload failed (network error)'));
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(`Media upload failed (${request.status})`));
          return;
        }
        try {
          const result = JSON.parse(request.responseText) as { url?: string };
          if (!result.url) {
            reject(new Error('Media upload failed (invalid response)'));
            return;
          }
          onProgress?.(1);
          resolve(result.url);
        } catch (error) {
          reject(new Error(`Media upload failed (invalid JSON response: ${(error as Error).message})`));
        }
      };

      request.send(formData);
    });
  }
}
