/**
 * Media for `addClip` ops, loaded before any op is applied so a batch that
 * cannot find its media changes nothing: a library clip's file by name, a
 * file under the call's `mediaRoot`, a same-origin URL, or a Drive library
 * item (which needs Drive access, so it may prompt).
 */

import type { Clip } from '../../types';
import { editorStore } from '../../store/editorStore';
import { driveLibraryStore } from '../../store/driveLibraryStore';
import { allSequenceClips } from '../../timeline/sequenceModel';
import { getMediaInfo, isImageFile } from '../../media/media';
import { getDriveAccessToken } from '../../remote/googleDrive';
import { fetchDriveFile } from '../segments/segmentDeps';
import type { ProjectOp } from './spec';

export interface LoadedMedia {
  file: File;
  objectUrl: string;
  duration: number;
  videoWidth?: number | undefined;
  videoHeight?: number | undefined;
  hasAudio?: boolean | undefined;
  stillImage: boolean;
}

async function fetchFile(url: string, name: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch ${url} (HTTP ${response.status})`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

function libraryFile(name: string): File | null {
  const clip = allSequenceClips(editorStore.getState()).find(
    (c) => !c.offline && !c.source && c.file.name === name,
  );
  return clip?.file ?? null;
}

async function resolveFile(op: ProjectOp, mediaRoot: string | undefined): Promise<File> {
  if (typeof op['fileName'] === 'string') {
    const local = libraryFile(op['fileName']);
    if (local) return local;
    if (mediaRoot) return fetchFile(new URL(encodeURIComponent(op['fileName']), mediaRoot).href, op['fileName']);
    throw new Error(`no library clip is named "${op['fileName']}" (pass mediaRoot to fetch it)`);
  }
  if (typeof op['url'] === 'string') {
    const url = new URL(op['url'], globalThis.location?.href);
    return fetchFile(url.href, decodeURIComponent(url.pathname.split('/').pop() || 'media'));
  }
  if (typeof op['driveId'] === 'string') {
    const item = driveLibraryStore.getState().items.find((i) => i.fileId === op['driveId']);
    if (!item) throw new Error(`no Drive library item has id "${op['driveId']}"`);
    return fetchDriveFile(item, await getDriveAccessToken());
  }
  throw new Error('addClip needs one of fileName, url or driveId');
}

/** Load every `addClip`'s media (by op index); throws `{index, message}` on the first failure. */
export async function loadOpMedia(ops: ProjectOp[], mediaRoot: string | undefined): Promise<Map<number, LoadedMedia>> {
  const loaded = new Map<number, LoadedMedia>();
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!;
    if (op.op !== 'addClip') continue;
    try {
      const file = await resolveFile(op, mediaRoot);
      const info = await getMediaInfo(file);
      loaded.set(index, { ...info, file, stillImage: isImageFile(file) });
    } catch (error) {
      throw Object.assign(new Error((error as Error).message || String(error)), { index });
    }
  }
  return loaded;
}

/** A fresh pool clip for loaded media (the op sets id, title, trims). */
export function clipFromMedia(media: LoadedMedia, id: string, title: string): Clip {
  const audioOnly = media.file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(media.file.name);
  return {
    id,
    file: media.file,
    objectUrl: media.objectUrl,
    title,
    kind: audioOnly ? 'audio' : 'video',
    duration: media.duration,
    ...(media.videoWidth !== undefined ? { videoWidth: media.videoWidth } : {}),
    ...(media.videoHeight !== undefined ? { videoHeight: media.videoHeight } : {}),
    ...(media.hasAudio !== undefined ? { hasAudio: media.hasAudio } : {}),
    ...(media.stillImage ? { stillImage: true } : {}),
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}
