/**
 * Zip archives for export bundles (stems and their sidecar files). The app's
 * only `fflate` import; eslint.config.js keeps it that way.
 *
 * Streaming: fflate's `Zip` with a `ZipPassThrough` (stored) per binary entry
 * passes the caller's bytes through by reference, so the archive is the
 * caller's own parts plus small headers, and the payload is copied once, into
 * the final Blob. PCM barely compresses; text (strings, `.json` / `.otio` …)
 * is deflated with `ZipDeflate`.
 *
 * Entries are written as a stream, so their sizes and CRC follow the data in
 * a data descriptor (and are repeated in the central directory, which is what
 * unzip tools read). There is no ZIP64: an archive past 4 GiB or 65 535
 * entries throws.
 */

import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';

/** File contents: text (UTF-8), bytes, or bytes in parts (a `WavFile`'s `parts`). */
export type ZipEntryData = string | Uint8Array | readonly Uint8Array[];

export interface ZipEntryOptions {
  /**
   * Deflate the entry. Default: yes for strings and text files (`.json`,
   * `.otio`, `.xml`, `.edl`, …) up to 16 MiB, stored otherwise.
   */
  compress?: boolean;
}

export interface ZipBundleOptions {
  /** Modification time of every entry (default: when the bundle is created). Zip stores local time, 1980–2099. */
  mtime?: Date;
}

export interface ZipBundle {
  /** Adds a file and returns the name it is stored under (sanitized, unique). */
  add(name: string, data: ZipEntryData, options?: ZipEntryOptions): string;
  /** Stored names, in order. */
  readonly names: readonly string[];
  /** Ends the archive and returns its bytes in order; the callers' parts are included by reference. */
  finishParts(): Uint8Array[];
  /** Ends the archive: an `application/zip` Blob, or one `Uint8Array` where `Blob` does not exist. */
  finish(): Blob | Uint8Array<ArrayBuffer>;
}

const ZIP32_MAX = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const AUTO_DEFLATE_MAX_BYTES = 16 * 1024 * 1024;
const TEXT_FILE = /\.(json|otio|xml|fcpxml|edl|txt|csv|md|srt|vtt|ass)$/i;
const WINDOWS_RESERVED = new Set(['<', '>', ':', '"', '|', '?', '*']);

/**
 * A streaming zip writer. `add` writes each entry through at once; call
 * `finish` (or `finishParts`) once at the end.
 *
 * @public
 */
export function createZipBundle(options: ZipBundleOptions = {}): ZipBundle {
  const mtime = options.mtime ?? new Date();
  const out: Uint8Array[] = [];
  const names: string[] = [];
  const files = new Set<string>();
  const dirs = new Set<string>();
  let written = 0;
  let failure: Error | null = null;
  let ended = false;

  const zip = new Zip((err, chunk) => {
    if (err) {
      failure ??= err;
      return;
    }
    out.push(chunk);
    written += chunk.length;
  });

  const assertOpen = (): void => {
    if (failure) throw failure;
    if (ended) throw new Error('ZipBundle: the archive is already finished');
  };

  const fail = (error: Error): never => {
    failure = error;
    zip.terminate();
    throw error;
  };

  const finishParts = (): Uint8Array[] => {
    assertOpen();
    ended = true;
    zip.end();
    if (failure) throw failure;
    const parts = out.slice();
    out.length = 0; // the bundle lets go of the payload once it is handed over
    return parts;
  };

  return {
    names,
    add(name, data, entryOptions = {}) {
      assertOpen();
      if (names.length >= ZIP_MAX_ENTRIES) throw new RangeError(`a zip holds at most ${ZIP_MAX_ENTRIES} entries`);
      const stored = uniqueName(sanitizeEntryName(name), files, dirs);
      const parts: readonly Uint8Array[] =
        typeof data === 'string' ? [strToU8(data)] : data instanceof Uint8Array ? [data] : data;
      const size = parts.reduce((sum, part) => sum + part.length, 0);
      const compress =
        entryOptions.compress ?? ((typeof data === 'string' || TEXT_FILE.test(stored)) && size <= AUTO_DEFLATE_MAX_BYTES);
      const entryBytes = LOCAL_HEADER_BYTES + strToU8(stored).length + size + DATA_DESCRIPTOR_BYTES;
      if (!compress && written + entryBytes > ZIP32_MAX) {
        throw new RangeError(`"${stored}" would take the zip past 4 GiB (ZIP64 is not supported)`);
      }

      const file = compress ? new ZipDeflate(stored, { level: 6 }) : new ZipPassThrough(stored);
      file.mtime = mtime;
      try {
        zip.add(file);
        if (parts.length === 0) file.push(new Uint8Array(0), true);
        parts.forEach((part, i) => file.push(part, i === parts.length - 1));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
      if (failure) throw failure;
      if (written > ZIP32_MAX) fail(new RangeError(`"${stored}" took the zip past 4 GiB (ZIP64 is not supported)`));

      claimName(stored, files, dirs);
      names.push(stored);
      return stored;
    },
    finishParts,
    finish() {
      const parts = finishParts();
      if (typeof Blob === 'undefined') return concatParts(parts);
      return new Blob(parts.map(blobPart), { type: 'application/zip' });
    },
  };
}

/**
 * A relative path that cannot leave the extraction folder: `\` becomes `/`,
 * empty, `.` and `..` segments are dropped, control and Windows-reserved
 * characters become `_`, and trailing dots / spaces (which Windows strips)
 * are trimmed.
 */
function sanitizeEntryName(name: string): string {
  const segments = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '.' && segment !== '..')
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments.join('/') : 'file';
}

function sanitizeSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f || WINDOWS_RESERVED.has(ch) ? '_' : ch;
  }
  return out.replace(/[. ]+$/, '').trim();
}

/**
 * Suffixes ` (2)`, ` (3)` … onto the first segment that clashes, compared
 * case-insensitively (as Windows and macOS do): a file may not repeat a file
 * or a folder, and a folder may not repeat a file.
 */
function uniqueName(name: string, files: ReadonlySet<string>, dirs: ReadonlySet<string>): string {
  const segments = name.split('/');
  const last = segments.length - 1;
  segments.forEach((segment, i) => {
    const clashes = (candidate: string): boolean => {
      const key = [...segments.slice(0, i), candidate].join('/').toLowerCase();
      return files.has(key) || (i === last && dirs.has(key));
    };
    let candidate = segment;
    for (let n = 2; clashes(candidate); n++) candidate = withSuffix(segment, n, i === last);
    segments[i] = candidate;
  });
  return segments.join('/');
}

function claimName(name: string, files: Set<string>, dirs: Set<string>): void {
  const key = name.toLowerCase();
  files.add(key);
  for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) dirs.add(key.slice(0, i));
}

function withSuffix(segment: string, n: number, keepExtension: boolean): string {
  const dot = keepExtension ? segment.lastIndexOf('.') : -1;
  if (dot <= 0) return `${segment} (${n})`;
  return `${segment.slice(0, dot)} (${n})${segment.slice(dot)}`;
}

/** Blob rejects views of a SharedArrayBuffer; those (only) are copied. */
function blobPart(part: Uint8Array): Uint8Array<ArrayBuffer> {
  return isArrayBufferView(part) ? part : part.slice();
}

function isArrayBufferView(part: Uint8Array): part is Uint8Array<ArrayBuffer> {
  return part.buffer instanceof ArrayBuffer;
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
