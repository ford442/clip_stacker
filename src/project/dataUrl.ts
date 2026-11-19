/**
 * `data:` URLs (embedded project media) are decoded here, never `fetch()`ed:
 * the production CSP's `connect-src` does not allow `data:`, so a fetch of an
 * embedded clip fails in the deployed app while happy-dom (no CSP) lets it
 * through. Autosave recovery and manual load both reach this through
 * `downloadRemoteMedia`.
 */

const DATA_URL_RE = /^data:([^,]*?),/i;

export function isDataUrl(url: string): boolean {
  return DATA_URL_RE.test(url);
}

/** Bytes per `atob` call: a multiple of 4 base64 chars, so chunks never split a quantum. */
const BASE64_CHUNK_CHARS = 4 * 256 * 1024;

function decodeBase64(payload: string): Uint8Array<ArrayBuffer> {
  // Tolerate whitespace and URL-safe base64 (both appear in hand-made projects).
  const clean = payload.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean.length % 4 === 0 ? clean : clean + '='.repeat(4 - (clean.length % 4));
  const padding = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((padded.length / 4) * 3 - padding);
  let offset = 0;
  for (let start = 0; start < padded.length; start += BASE64_CHUNK_CHARS) {
    const binary = atob(padded.slice(start, start + BASE64_CHUNK_CHARS));
    for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);
    offset += binary.length;
  }
  return bytes;
}

/**
 * Decode a `data:[<mediatype>][;base64],<data>` URL into a Blob typed with its
 * media type. Throws on a malformed URL or invalid base64.
 */
export function decodeDataUrl(url: string): Blob {
  const match = DATA_URL_RE.exec(url);
  if (!match) throw new Error('Not a data: URL');
  const meta = (match[1] ?? '').split(';').map((part) => part.trim());
  const isBase64 = meta.some((part) => part.toLowerCase() === 'base64');
  const mediaType = meta[0] && meta[0].includes('/') ? meta[0].toLowerCase() : '';
  const payload = url.slice(match[0].length);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = isBase64 ? decodeBase64(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  } catch (error) {
    throw new Error(
      `Embedded media is corrupt (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  return new Blob([bytes], mediaType ? { type: mediaType } : {});
}
