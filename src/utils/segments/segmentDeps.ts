import type { Clip, DriveMediaItem } from '../../types';
import { editorStore } from '../../store/editorStore';
import { driveLibraryStore } from '../../store/driveLibraryStore';
import { projectStore } from '../../store/projectStore';
import { getDriveAccessToken } from '../googleDrive';
import { removeClipFromGroups } from '../clipOperations';
import { createClipId, getMediaInfo } from '../media';
import { ContaboStorageManagerClient, downloadRemoteMedia } from '../project';
import type { ProcessDeps } from './processSegment';
import type { ReplaceDeps } from './replaceSegment';

/** FFmpeg.wasm and the HF client are heavy; they load when a segment is actually cut. */
const loadSegmentCutter = () => import('../../ffmpeg/segment');
const loadFfmpegService = () => import('../../ffmpeg/ffmpegService');
const loadHuggingFace = () => import('../huggingface');

export const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';

/** Duration, size and audio of a media blob, via a throwaway element. */
export async function probeMediaFile(file: File) {
  const info = await getMediaInfo(file);
  URL.revokeObjectURL(info.objectUrl);
  return {
    durationSec: info.duration,
    ...(info.videoWidth ? { width: info.videoWidth } : {}),
    ...(info.videoHeight ? { height: info.videoHeight } : {}),
    ...(info.hasAudio !== undefined ? { hasAudio: info.hasAudio } : {}),
  };
}

/** `blob:` URLs are read directly; anything else goes through the retrying library downloader. */
export function fetchSegmentBlob(url: string): Promise<Blob> {
  return url.startsWith('blob:') ? fetch(url).then((r) => r.blob()) : downloadRemoteMedia(url);
}

async function fetchDriveFile(item: DriveMediaItem, token: string, signal?: AbortSignal): Promise<File> {
  const response = await fetch(`${DRIVE_FILES_API}/${encodeURIComponent(item.fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Google Drive refused access to this file. Import it again from Drive to re-grant access.'
        : `Drive download failed (HTTP ${response.status}).`,
    );
  }
  return new File([await response.blob()], item.name, { type: item.mimeType });
}

/** The real environment for extract / process / replace. */
export function createSegmentDeps(): ProcessDeps {
  return {
    getClip: (clipId: string): Clip | undefined => editorStore.getState().clips.find((c) => c.id === clipId),
    getDriveItem: (fileId) => driveLibraryStore.getState().items.find((i) => i.fileId === fileId),
    getDriveToken: () => getDriveAccessToken(),
    contabo: () => {
      const { storageEndpoint, storageAuthToken } = projectStore.getState();
      return storageEndpoint.trim() ? new ContaboStorageManagerClient(storageEndpoint.trim(), storageAuthToken) : null;
    },
    cutInBrowser: async (file, startSec, endSec, mode, onStatus) =>
      (await loadSegmentCutter()).cutSegmentWithFfmpeg(file, startSec, endSec, mode, onStatus),
    probeMedia: probeMediaFile,
    fetchDriveFile,
    makeObjectUrl: (blob) => URL.createObjectURL(blob),
    fetchBlob: fetchSegmentBlob,
    rifeOnHuggingFace: async (blob, multiplier, onProgress) => {
      const { processClipWithRIFE } = await loadHuggingFace();
      const { blob: out } = await processClipWithRIFE(blob, multiplier, 'interpolation', (event) =>
        onProgress(event.message ?? `RIFE: ${event.stage}…`),
      );
      return out;
    },
    muxSegmentAudio: async (video, segment, hasAudio, onStatus) => {
      const { muxProcessedVideoWithSourceAudio } = await loadFfmpegService();
      const { durationSec } = await probeMediaFile(segment);
      // The segment file is the whole "source": trim 0..end puts its own audio under RIFE's video.
      const asClip: Clip = {
        id: createClipId(),
        file: segment,
        objectUrl: '',
        title: segment.name,
        kind: 'video',
        duration: durationSec,
        ...(hasAudio !== undefined ? { hasAudio } : {}),
        trimStart: 0,
        trimEnd: NaN,
        videoFadeIn: 0,
        videoFadeOut: 0,
        audioFadeIn: 0,
        audioFadeOut: 0,
      };
      return muxProcessedVideoWithSourceAudio(video, asClip, onStatus);
    },
  };
}

/** Editor wiring for replaceSegment: one undo step, A/B groups kept consistent, the new clip selected. */
export function createReplaceDeps(): ReplaceDeps {
  return {
    fetchBlob: fetchSegmentBlob,
    readMedia: async (file) => {
      const info = await getMediaInfo(file);
      return {
        durationSec: info.duration,
        objectUrl: info.objectUrl,
        ...(info.videoWidth ? { width: info.videoWidth } : {}),
        ...(info.videoHeight ? { height: info.videoHeight } : {}),
        ...(info.hasAudio !== undefined ? { hasAudio: info.hasAudio } : {}),
      };
    },
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    getEditState: () => {
      const { tracks, clips, transitions } = editorStore.getState();
      return { tracks, clips, transitions };
    },
    commitEdit: (next) => editorStore.getState().commitEdit(next),
    afterSplit: (sourceClip) =>
      editorStore.getState().setClipGroups((groups) => removeClipFromGroups(groups, sourceClip)),
    select: (clipId) => editorStore.getState().setSelectedClipId(clipId),
  };
}
