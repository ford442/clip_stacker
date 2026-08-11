import type { Clip, ClipGroup, ClipTransition, MasterAudio, Project, SerializedClip, TextOverlay, Track } from '../../types';
import type { ColorGradeSettings } from '../lut';
import type { FinishingSettings } from '../finishing';
import {
  DEFAULT_FINISHING,
  colorGradeToLutPass,
} from '../finishing';
import type { ContaboStorageManagerClient } from './contaboClient';
import {
  MAX_EMBED_FILE_BYTES,
  MAX_UPLOAD_RETRY_ATTEMPTS,
} from './constants';
import { serializeProject } from './serialize';
import { formatBytes } from './remoteMedia';
import type { RemoteUploadErrorEvent, RemoteUploadProgressEvent } from './types';

export interface SerializeProjectOptions {
  mediaMode?: 'metadata' | 'embed' | 'remote';
  mediaClient?: ContaboStorageManagerClient;
  /** @deprecated Prefer `finishing`. */
  colorGrade?: ColorGradeSettings;
  finishing?: FinishingSettings;
  onRemoteUploadProgress?: (event: RemoteUploadProgressEvent) => void;
  onRemoteUploadError?: (
    event: RemoteUploadErrorEvent,
  ) => Promise<'retry' | 'skip' | 'abort'> | 'retry' | 'skip' | 'abort';
  /**
   * Called when `mediaMode === 'embed'` and a clip's source file exceeds
   * `MAX_EMBED_FILE_BYTES`. Receives a human-readable warning describing
   * whether the clip was uploaded to remote storage instead (if
   * `mediaClient` is set) or embedded anyway despite the size.
   */
  onEmbedWarning?: (message: string) => void;
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

/**
 * Upload a clip's source media to remote storage, unless it has already been
 * uploaded (`clip.remoteSourceUrl` is set — either from a prior remote save
 * or because the clip was added from the media library), in which case the
 * existing URL is reused as-is.
 */
async function uploadOrReuseClipMedia(
  clip: Clip,
  index: number,
  total: number,
  options: SerializeProjectOptions,
): Promise<string | undefined> {
  if (clip.remoteSourceUrl) {
    options.onRemoteUploadProgress?.({
      clipId: clip.id,
      fileName: clip.file.name,
      index,
      total,
      progress: 1,
      status: 'uploaded',
    });
    return clip.remoteSourceUrl;
  }
  return uploadClipMediaWithRetry(clip, index, total, options);
}

/** Upload a clip's source media to remote storage, retrying on failure per `options`. */
async function uploadClipMediaWithRetry(
  clip: Clip,
  index: number,
  total: number,
  options: SerializeProjectOptions,
): Promise<string | undefined> {
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
      const url = await options.mediaClient.uploadMedia(
        uploadName,
        clip.file,
        clip.file.type || 'application/octet-stream',
        (progress, detail) =>
          options.onRemoteUploadProgress?.({
            clipId: clip.id,
            fileName: clip.file.name,
            index,
            total,
            progress,
            status: 'uploading',
            ...(detail?.chunkTotal
              ? {
                  chunkIndex: detail.chunkIndex,
                  chunkTotal: detail.chunkTotal,
                }
              : {}),
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
      return url;
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
        return undefined;
      }
      throw new Error(`Upload aborted at clip ${index}/${total}: ${uploadError.message}`);
    }
  }
}

export async function serializeProjectWithMedia(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  clipGroups: ClipGroup[] = [],
  options: SerializeProjectOptions = {},
  tracks: Track[] = [],
  masterAudio: MasterAudio | null = null,
): Promise<Project> {
  const mediaMode = options.mediaMode ?? 'metadata';
  const finishing =
    options.finishing ??
    (options.colorGrade
      ? { ...DEFAULT_FINISHING, lut: colorGradeToLutPass(options.colorGrade, true) }
      : DEFAULT_FINISHING);
  const project = serializeProject(
    clips,
    transitions,
    textOverlays,
    clipGroups,
    finishing,
    tracks,
    undefined,
    masterAudio,
  );
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
    // Clear any stale media-source fields from a previous save in a
    // different mode; the branches below set whichever field applies.
    delete updated.sourceMediaDataUrl;
    delete updated.sourceMediaUrl;
    if (mediaMode === 'embed') {
      if (clip.file.size > MAX_EMBED_FILE_BYTES) {
        if (options.mediaClient) {
          updated.sourceMediaUrl = await uploadOrReuseClipMedia(clip, index, total, options);
          options.onEmbedWarning?.(
            `"${clip.file.name}" (${formatBytes(clip.file.size)}) is too large to embed directly ` +
              `and was uploaded to remote storage instead.`,
          );
        } else {
          updated.sourceMediaDataUrl = await readFileAsDataUrl(clip.file);
          options.onEmbedWarning?.(
            `"${clip.file.name}" (${formatBytes(clip.file.size)}) is large and may exceed browser ` +
              `storage limits when embedded in the project file. Consider using remote save instead.`,
          );
        }
      } else {
        updated.sourceMediaDataUrl = await readFileAsDataUrl(clip.file);
      }
    } else if (mediaMode === 'remote') {
      updated.sourceMediaUrl = await uploadOrReuseClipMedia(clip, index, total, options);
    }
    enrichedClips.push(updated);
  }

  let enrichedMaster = project.masterAudio;
  if (masterAudio && enrichedMaster) {
    enrichedMaster = { ...enrichedMaster };
    if (mediaMode === 'embed') {
      enrichedMaster.sourceMediaDataUrl = await readFileAsDataUrl(masterAudio.file);
    } else if (mediaMode === 'remote' && options.mediaClient) {
      try {
        enrichedMaster.sourceMediaUrl = await options.mediaClient.uploadMedia(
          `master-${sanitizeUploadFileName(masterAudio.fileName)}`,
          masterAudio.file,
          masterAudio.file.type || 'audio/mpeg',
        );
      } catch {
        /* keep metadata-only master audio reference */
      }
    }
  }

  return {
    ...project,
    clips: enrichedClips,
    ...(enrichedMaster ? { masterAudio: enrichedMaster } : {}),
    mediaMode,
  };
}
