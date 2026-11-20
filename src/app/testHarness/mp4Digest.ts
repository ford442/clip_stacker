/**
 * A digest of an MP4 that ignores when it was written: the creation and
 * modification times in `mvhd`, every `tkhd` and every `mdhd` (Mediabunny
 * stamps the wall clock there) are zeroed before hashing. Two exports of the
 * same project are bit-identical exactly when their digests match.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia']);
const TIMED = new Set(['mvhd', 'tkhd', 'mdhd']);

function boxType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
}

/** A copy of `input` with the header times zeroed. */
export function zeroMp4Times(input: Uint8Array): Uint8Array {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = (start: number, end: number) => {
    let at = start;
    while (at + 8 <= end) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1 && at + 16 <= end) {
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) return;
      const type = boxType(bytes, at);
      if (CONTAINERS.has(type)) {
        walk(at + header, at + size);
      } else if (TIMED.has(type)) {
        const version = bytes[at + header]!;
        const fields = at + header + 4;
        // Version 1: two 64-bit times; version 0: two 32-bit times.
        bytes.fill(0, fields, fields + (version === 1 ? 16 : 8));
      }
      at += size;
    }
  };
  walk(0, bytes.byteLength);
  return bytes;
}

/** SHA-256 (hex) of the file with its header times zeroed. */
export async function mp4Digest(blob: Blob): Promise<string> {
  const normalized = zeroMp4Times(new Uint8Array(await blob.arrayBuffer()));
  const digest = await crypto.subtle.digest('SHA-256', normalized as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
