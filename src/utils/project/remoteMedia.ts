import {
  MAX_MEDIA_DOWNLOAD_ATTEMPTS,
  MEDIA_DOWNLOAD_RETRY_DELAY_MS,
} from './constants';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a remote media file with a couple of retries for transient network
 * failures (timeouts, dropped connections, brief CORS hiccups). `credentials:
 * 'omit'` is required so wildcard (`Access-Control-Allow-Origin: *`) bucket
 * CORS policies — common for Contabo and other S3-compatible storage — don't
 * get rejected by the browser for sending credentials cross-origin. Signed
 * URLs carry their own auth in the query string, so no cookies/headers are
 * needed.
 */
async function fetchRemoteMediaWithRetry(mediaUrl: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_MEDIA_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(mediaUrl, {
        mode: 'cors',
        credentials: 'omit',
      });
      if (!response.ok) {
        const statusText = response.statusText ? ` ${response.statusText}` : '';
        throw new Error(`Media download failed (HTTP ${response.status}${statusText})`);
      }
      return response;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(
              'Media download failed: network error or CORS policy blocked the request.',
            );
      if (attempt < MAX_MEDIA_DOWNLOAD_ATTEMPTS) {
        await delay(MEDIA_DOWNLOAD_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(
    `Could not download media after ${MAX_MEDIA_DOWNLOAD_ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

export async function downloadRemoteMedia(
  mediaUrl: string,
  onProgress?: (progress: number, indeterminate: boolean) => void,
): Promise<Blob> {
  const mediaResponse = await fetchRemoteMediaWithRetry(mediaUrl);

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

/** Format a byte count as a human-readable size (e.g. "12.3 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
