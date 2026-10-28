import type { Project } from '../../types';
import {
  CHUNK_THRESHOLD_BYTES,
  uploadMediaChunked,
  type ChunkedUploadProgress,
} from '../storageUpload';
import type { MediaLibraryItem } from './types';
import {
  describeJobHttpError,
  pollJobUntilDone,
  type ContaboJob,
  type ContaboJobRequest,
  type WaitForJobOptions,
} from './contaboJobs';

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
   * store `uploadMedia` writes to). The Contabo server answers
   * `{ "media": [{ "name", "url", "size" }, ...] }`; `files` is accepted too for
   * other storage backends.
   */
  async listMedia(): Promise<MediaLibraryItem[]> {
    const authHeader = this.getAuthHeader();
    const response = await fetch(this.mediaEndpoint, {
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) throw new Error(`Media library list failed (${response.status})`);
    const result = (await response.json()) as {
      files?: MediaLibraryItem[];
      media?: MediaLibraryItem[];
    };
    return result.files ?? result.media ?? [];
  }

  /** Delete a file from the remote media library (e.g. a job output that was pulled back). */
  async deleteMedia(name: string): Promise<void> {
    const authHeader = this.getAuthHeader();
    const response = await fetch(`${this.mediaEndpoint}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) throw new Error(`Media delete failed (${response.status})`);
  }

  private get jobsEndpoint(): string {
    return this.endpoint.replace(/\/*$/, '') + '/jobs';
  }

  private jobHeaders(json = false): Record<string, string> | undefined {
    const authHeader = this.getAuthHeader();
    const headers: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
    if (authHeader) headers.authorization = authHeader;
    return Object.keys(headers).length ? headers : undefined;
  }

  /** Start a server-side extract / splice / rife job. Returns immediately with the queued job. */
  async createJob(request: ContaboJobRequest): Promise<ContaboJob> {
    const response = await fetch(this.jobsEndpoint, {
      method: 'POST',
      headers: this.jobHeaders(true),
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(await describeJobHttpError(response, 'Starting the processing job'));
    return (await response.json()) as ContaboJob;
  }

  async getJob(jobId: string): Promise<ContaboJob> {
    const response = await fetch(`${this.jobsEndpoint}/${encodeURIComponent(jobId)}`, {
      headers: this.jobHeaders(),
    });
    if (!response.ok) throw new Error(await describeJobHttpError(response, 'Checking the processing job'));
    return (await response.json()) as ContaboJob;
  }

  async cancelJob(jobId: string): Promise<ContaboJob> {
    const response = await fetch(`${this.jobsEndpoint}/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: this.jobHeaders(),
    });
    if (!response.ok) throw new Error(await describeJobHttpError(response, 'Cancelling the processing job'));
    return (await response.json()) as ContaboJob;
  }

  /** Poll until the job finishes; resolves with the final job (check `status`). */
  waitForJob(jobId: string, options?: WaitForJobOptions): Promise<ContaboJob> {
    return pollJobUntilDone((id) => this.getJob(id), jobId, options);
  }
}
