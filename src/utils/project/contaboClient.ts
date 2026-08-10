import type { Project } from '../../types';
import {
  CHUNK_THRESHOLD_BYTES,
  uploadMediaChunked,
  type ChunkedUploadProgress,
} from '../storageUpload';
import type { MediaLibraryItem } from './types';

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
   *
   * Files larger than {@link CHUNK_THRESHOLD_BYTES} use a chunked, resumable
   * session (`storageUpload.ts`). Smaller files keep the legacy single-request
   * multipart POST for lower latency.
   */
  async uploadMedia(
    name: string,
    blob: Blob,
    mimeType = 'audio/wav',
    onProgress?: (progress: number, detail?: ChunkedUploadProgress) => void,
  ): Promise<string> {
    const authHeader = this.getAuthHeader();

    if (blob.size > CHUNK_THRESHOLD_BYTES) {
      return uploadMediaChunked({
        mediaEndpoint: this.mediaEndpoint,
        authHeader,
        name,
        blob,
        mimeType,
        onProgress: (detail) => onProgress?.(detail.progress, detail),
      });
    }

    return this.uploadMediaSingleRequest(name, blob, mimeType, onProgress, authHeader);
  }

  /** Legacy single-request multipart upload (files ≤ {@link CHUNK_THRESHOLD_BYTES}). */
  private async uploadMediaSingleRequest(
    name: string,
    blob: Blob,
    mimeType: string,
    onProgress: ((progress: number, detail?: ChunkedUploadProgress) => void) | undefined,
    authHeader: string | null,
  ): Promise<string> {
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

  /**
   * List previously uploaded files in the remote media library (the same
   * store `uploadMedia` writes to). Expects the server to respond with
   * `{ "files": [{ "name", "url", "size"?, "modified"? }, ...] }`.
   */
  async listMedia(): Promise<MediaLibraryItem[]> {
    const authHeader = this.getAuthHeader();
    const response = await fetch(this.mediaEndpoint, {
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) throw new Error(`Media library list failed (${response.status})`);
    const result = (await response.json()) as { files?: MediaLibraryItem[] };
    return result.files ?? [];
  }
}
