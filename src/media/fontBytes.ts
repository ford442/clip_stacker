const TTF_MAGIC = 0x00010000;
const OTF_MAGIC = 0x4f54544f; // 'OTTO'
const WOFF_MAGIC = 0x774f4646; // 'wOFF'
const WOFF2_MAGIC = 0x774f4632; // 'wOF2'

function readUInt32BE(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/** Return true when bytes look like a TrueType / OpenType / WOFF font. */
export function isValidFontBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const version = readUInt32BE(bytes);
  return (
    version === TTF_MAGIC ||
    version === OTF_MAGIC ||
    version === WOFF_MAGIC ||
    version === WOFF2_MAGIC
  );
}

/**
 * Reject HTML or other non-font payloads (common when a stale deploy or bad
 * path returns a 404 page saved as `.ttf`).
 */
export function assertValidBundledFontBytes(
  bytes: Uint8Array,
  sourceLabel: string,
): void {
  if (isValidFontBytes(bytes)) return;

  const prefix = String.fromCharCode(...bytes.subarray(0, Math.min(12, bytes.length)));
  const looksLikeHtml =
    prefix.includes('<!DOCTYPE') ||
    prefix.includes('<html') ||
    prefix.trimStart().startsWith('<');

  const hint = looksLikeHtml
    ? 'The server returned HTML instead of a font file. Redeploy the app or hard-refresh to clear a cached bad font.'
    : 'The file is not a valid TTF/OTF/WOFF font.';

  throw new Error(`Invalid bundled font "${sourceLabel}": ${hint}`);
}
