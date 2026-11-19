/**
 * Broadcast WAV (EBU Tech 3285) writer for stems: interleaved float PCM in, a
 * RIFF/WAVE file out as a list of byte parts. Pure TS with no DOM, so it also
 * runs under Node.
 *
 * Chunk order: `RIFF`/`WAVE`, `fmt `, `bext`, `iXML`, `fact` (float only),
 * `data`. Every chunk starts on an even offset: a chunk whose size is odd (the
 * `data` of a mono 24-bit file with an odd frame count) is followed by one
 * zero pad byte its size does not count, as RIFF requires. The two text
 * chunks pad their own text instead, so their sizes are even and a reader
 * that ignores the pad rule still finds the next chunk.
 *
 * Streaming: `write` converts each chunk straight into ~1 MiB blocks, so an
 * hour-long stem is held once, as the file's own bytes; `finish` patches the
 * header sizes (known only then) and returns header + blocks. There is no
 * RF64: a file past the 32-bit RIFF size throws.
 */

/** `pcm24`: 24-bit `WAVE_FORMAT_PCM`. `float32`: 32-bit `WAVE_FORMAT_IEEE_FLOAT`, written bit for bit. */
export type WavSampleFormat = 'pcm24' | 'float32';

/** Programme loudness for a version 2 `bext`; each is stored as round(value × 100) in an int16. */
export interface BextLoudness {
  /** `LoudnessValue`: integrated loudness, LUFS. */
  integrated?: number;
  /** `LoudnessRange`: loudness range, LU. */
  range?: number;
  /** `MaxTruePeakLevel`: dBTP. */
  maxTruePeak?: number;
  /** `MaxMomentaryLoudness`: LUFS. */
  maxMomentary?: number;
  /** `MaxShortTermLoudness`: LUFS. */
  maxShortTerm?: number;
}

export interface BextOptions {
  /** Up to 256 ASCII characters (default: the track name). */
  description?: string;
  /** Up to 32 ASCII characters (default `Clip Stacker`). */
  originator?: string;
  /** Up to 32 ASCII characters (default empty). */
  originatorReference?: string;
  /** `yyyy-mm-dd` (default: today, local time). */
  originationDate?: string;
  /** `hh:mm:ss` (default: now, local time). */
  originationTime?: string;
  /**
   * Makes the chunk version 2 (otherwise version 1). A field left out, or
   * NaN, is written as 0x7FFF, the "not measured" value.
   */
  loudness?: BextLoudness;
  /** Replaces the generated `A=PCM,F=…,W=…,M=…,T=Clip Stacker` line; ASCII, CR LF appended when missing. */
  codingHistory?: string;
}

export interface FrameRateRatio {
  numerator: number;
  denominator: number;
}

export interface IxmlOptions {
  project?: string;
  scene?: string;
  take?: string;
  tape?: string;
  note?: string;
  /**
   * The project frame rate for `<SPEED>` (default 30/1). A number is an
   * integer rate or an NTSC one (23.976, 29.97, 59.94, …, written x000/1001).
   */
  frameRate?: number | FrameRateRatio;
  /** `TIMECODE_FLAG` DF; only valid at 30000/1001 or 60000/1001. */
  dropFrame?: boolean;
}

export interface WavWriterOptions {
  /** 1 or 2 (default 2). Chunks are interleaved: L, R, L, R … */
  channels?: 1 | 2;
  /** Hz, an integer (default 48000). */
  sampleRate?: number;
  /** Default `pcm24`. */
  format?: WavSampleFormat;
  /** The lane name: the `bext` description default and the iXML track names (`<name> L` / `<name> R`). */
  trackName?: string;
  /**
   * `TimeReference`: where the file's first sample sits, in samples since
   * midnight at the file's rate (see `timeReferenceSamples`). Default 0.
   */
  timeReference?: number;
  bext?: BextOptions;
  ixml?: IxmlOptions;
}

export interface WavFile {
  /** The file in order: header, PCM blocks, pad byte. Concatenate them or hand them to a Blob / zip entry as is. */
  parts: Uint8Array<ArrayBuffer>[];
  byteLength: number;
  frames: number;
}

export interface WavWriter {
  /** Frames written so far. */
  readonly frames: number;
  /** Appends interleaved samples; the length must be a whole number of frames. */
  write(chunk: Float32Array): void;
  /** Ends the file and returns its parts. Call once; `write` throws afterwards. */
  finish(): WavFile;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const UINT32_MAX = 0xffffffff;
const UINT32_RANGE = 0x1_0000_0000;

/** 24-bit scale: +1.0 → 8 388 607 and −1.0 → −8 388 607; only input below −1 reaches −8 388 608. */
const PCM24_SCALE = 8388607;
const PCM24_MIN = -8388608;
const PCM24_MAX = 8388607;

const BLOCK_TARGET_BYTES = 1 << 20;

const BEXT_FIXED_BYTES = 602;
const BEXT_LOUDNESS_OFFSET = 412;
const BEXT_LOUDNESS_UNSET = 0x7fff;

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

interface WavLayout {
  channels: 1 | 2;
  format: WavSampleFormat;
  bytesPerSample: 3 | 4;
  blockAlign: number;
  /** Everything before the PCM, with the RIFF, `fact` and `data` sizes left 0. */
  header: Uint8Array<ArrayBuffer>;
  factFramesOffset: number | null;
  dataSizeOffset: number;
}

/**
 * `TimeReference` for a timecode start: seconds since midnight → samples,
 * rounded to the nearest sample (01:00:00:00 = 3600 s → 172 800 000 at 48 kHz).
 *
 * @public
 */
export function timeReferenceSamples(timecodeStartSeconds: number, sampleRate: number): number {
  if (!Number.isFinite(timecodeStartSeconds) || timecodeStartSeconds < 0) {
    throw new RangeError(`timecode start must be a non-negative number of seconds, got ${timecodeStartSeconds}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sample rate must be positive, got ${sampleRate}`);
  }
  const samples = Math.round(timecodeStartSeconds * sampleRate);
  if (!Number.isSafeInteger(samples)) {
    throw new RangeError(`time reference ${samples} is past the exact integer range`);
  }
  return samples;
}

/**
 * A streaming Broadcast WAV writer. Metadata is fixed here, so a bad option
 * throws before any PCM is converted.
 *
 * @public
 */
export function createWavWriter(options: WavWriterOptions = {}): WavWriter {
  const layout = resolveLayout(options);
  const blockBytes = Math.max(1, Math.floor(BLOCK_TARGET_BYTES / layout.blockAlign)) * layout.blockAlign;
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  let block: Uint8Array<ArrayBuffer> | null = null;
  let used = 0;
  let dataBytes = 0;
  let finished = false;

  return {
    get frames() {
      return dataBytes / layout.blockAlign;
    },
    write(chunk) {
      if (finished) throw new Error('WavWriter: write() after finish()');
      assertWholeFrames(chunk, layout.channels);
      const bytes = chunk.length * layout.bytesPerSample;
      assertRiffSize(layout.header.length, dataBytes + bytes);
      let sample = 0;
      while (sample < chunk.length) {
        if (block === null || used === block.length) {
          if (block !== null) blocks.push(block);
          block = new Uint8Array(blockBytes);
          used = 0;
        }
        const count = Math.min(chunk.length - sample, (block.length - used) / layout.bytesPerSample);
        convertSamples(layout.format, chunk, sample, count, block, used);
        sample += count;
        used += count * layout.bytesPerSample;
      }
      dataBytes += bytes;
    },
    finish() {
      if (finished) throw new Error('WavWriter: finish() called twice');
      finished = true;
      if (block !== null && used > 0) {
        // A mostly empty last block is trimmed rather than kept alive whole.
        blocks.push(used < block.length / 2 ? block.slice(0, used) : block.subarray(0, used));
      }
      block = null;
      const header = patchHeader(layout, dataBytes);
      const parts = [header, ...blocks];
      if (dataBytes % 2 === 1) parts.push(new Uint8Array(1));
      return {
        parts,
        byteLength: header.length + dataBytes + (dataBytes % 2),
        frames: dataBytes / layout.blockAlign,
      };
    },
  };
}

/**
 * One-shot Broadcast WAV: the whole file in one buffer, written in place
 * (header + converted PCM, no intermediate copy).
 *
 * @public
 */
export function encodeWav(interleaved: Float32Array, options: WavWriterOptions = {}): Uint8Array<ArrayBuffer> {
  const layout = resolveLayout(options);
  assertWholeFrames(interleaved, layout.channels);
  const dataBytes = interleaved.length * layout.bytesPerSample;
  assertRiffSize(layout.header.length, dataBytes);
  const out = new Uint8Array(layout.header.length + dataBytes + (dataBytes % 2));
  out.set(patchHeader(layout, dataBytes), 0);
  convertSamples(layout.format, interleaved, 0, interleaved.length, out, layout.header.length);
  return out;
}

function resolveLayout(options: WavWriterOptions): WavLayout {
  const channels = options.channels ?? 2;
  if (channels !== 1 && channels !== 2) throw new RangeError(`channels must be 1 or 2, got ${String(channels)}`);
  const format = options.format ?? 'pcm24';
  const bytesPerSample = format === 'float32' ? 4 : 3;
  const blockAlign = channels * bytesPerSample;
  const sampleRate = options.sampleRate ?? 48000;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate * blockAlign > UINT32_MAX) {
    throw new RangeError(`sample rate must be a positive integer, got ${sampleRate}`);
  }
  const timeReference = options.timeReference ?? 0;
  if (!Number.isSafeInteger(timeReference) || timeReference < 0) {
    throw new RangeError(`time reference must be a non-negative integer sample count, got ${timeReference}`);
  }
  const meta: ChunkContext = {
    channels,
    sampleRate,
    bitsPerSample: bytesPerSample * 8,
    trackName: options.trackName ?? 'Track',
    timeReference,
  };

  const chunks: [string, Uint8Array<ArrayBuffer>][] = [
    ['fmt ', fmtPayload(format, channels, sampleRate)],
    ['bext', bextPayload(meta, options.bext ?? {})],
    ['iXML', ixmlPayload(meta, options.ixml ?? {})],
  ];
  if (format === 'float32') chunks.push(['fact', new Uint8Array(4)]);

  let length = 12 + 8; // RIFF/WAVE + the data chunk header
  for (const [, payload] of chunks) length += 8 + payload.length + (payload.length % 2);
  const header = new Uint8Array(length);
  const view = new DataView(header.buffer);
  writeFourCc(header, 0, 'RIFF');
  writeFourCc(header, 8, 'WAVE');
  let offset = 12;
  let factFramesOffset: number | null = null;
  for (const [id, payload] of chunks) {
    writeFourCc(header, offset, id);
    view.setUint32(offset + 4, payload.length, true);
    header.set(payload, offset + 8);
    if (id === 'fact') factFramesOffset = offset + 8;
    offset += 8 + payload.length + (payload.length % 2);
  }
  writeFourCc(header, offset, 'data');
  return { channels, format, bytesPerSample, blockAlign, header, factFramesOffset, dataSizeOffset: offset + 4 };
}

function patchHeader(layout: WavLayout, dataBytes: number): Uint8Array<ArrayBuffer> {
  const { header } = layout;
  const view = new DataView(header.buffer);
  view.setUint32(4, header.length - 8 + dataBytes + (dataBytes % 2), true);
  view.setUint32(layout.dataSizeOffset, dataBytes, true);
  // `fact` holds the length in sample frames (per channel).
  if (layout.factFramesOffset !== null) view.setUint32(layout.factFramesOffset, dataBytes / layout.blockAlign, true);
  return header;
}

function assertWholeFrames(chunk: Float32Array, channels: number): void {
  if (chunk.length % channels !== 0) {
    throw new RangeError(`chunk of ${chunk.length} samples is not a whole number of ${channels}-channel frames`);
  }
}

function assertRiffSize(headerBytes: number, dataBytes: number): void {
  const riffSize = headerBytes - 8 + dataBytes + (dataBytes % 2);
  if (riffSize > UINT32_MAX) {
    throw new RangeError(
      `WAV would be ${riffSize + 8} bytes, past the 4 GiB RIFF limit (RF64 is not supported): split the stem`,
    );
  }
}

/** Float → 24-bit little-endian: ×8 388 607, rounded half away from zero, clamped; NaN → 0. */
function convertSamples(
  format: WavSampleFormat,
  src: Float32Array,
  start: number,
  count: number,
  dst: Uint8Array,
  offset: number,
): void {
  if (format === 'float32') {
    if (HOST_LITTLE_ENDIAN) {
      // A byte copy keeps every float bit for bit, NaN payloads included.
      dst.set(new Uint8Array(src.buffer, src.byteOffset + start * 4, count * 4), offset);
    } else {
      const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
      for (let i = 0; i < count; i++) view.setFloat32(offset + i * 4, src[start + i]!, true);
    }
    return;
  }
  let o = offset;
  for (let i = start, end = start + count; i < end; i++) {
    const v = src[i]! * PCM24_SCALE;
    let s = 0; // NaN fails both comparisons below and stays 0
    if (v >= 0) s = v >= PCM24_MAX ? PCM24_MAX : Math.floor(v + 0.5);
    else if (v < 0) s = v <= PCM24_MIN ? PCM24_MIN : -Math.floor(0.5 - v);
    dst[o] = s & 0xff;
    dst[o + 1] = (s >> 8) & 0xff;
    dst[o + 2] = (s >> 16) & 0xff;
    o += 3;
  }
}

function writeFourCc(bytes: Uint8Array, offset: number, id: string): void {
  for (let i = 0; i < 4; i++) bytes[offset + i] = id.charCodeAt(i);
}

function fmtPayload(format: WavSampleFormat, channels: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const float = format === 'float32';
  const bits = float ? 32 : 24;
  const blockAlign = (channels * bits) / 8;
  // Non-PCM formats carry cbSize (0 here), so the float `fmt ` is 18 bytes.
  const bytes = new Uint8Array(float ? 18 : 16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, float ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * blockAlign, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bits, true);
  return bytes;
}

interface ChunkContext {
  channels: 1 | 2;
  sampleRate: number;
  bitsPerSample: number;
  trackName: string;
  timeReference: number;
}

function bextPayload(meta: ChunkContext, bext: BextOptions): Uint8Array<ArrayBuffer> {
  const now = new Date();
  const date = bext.originationDate ?? `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = bext.originationTime ?? `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`bext origination date must be yyyy-mm-dd, got "${date}"`);
  if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) throw new RangeError(`bext origination time must be hh:mm:ss, got "${time}"`);

  const mode = meta.channels === 1 ? 'mono' : 'stereo';
  let history = bext.codingHistory ?? `A=PCM,F=${meta.sampleRate},W=${meta.bitsPerSample},M=${mode},T=Clip Stacker`;
  if (history.length > 0 && !history.endsWith('\r\n')) history += '\r\n';
  // CodingHistory is NUL padded to an even length, so the chunk size is even.
  const historyBytes = history.length + (history.length % 2);

  const bytes = new Uint8Array(BEXT_FIXED_BYTES + historyBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 256, bext.description ?? meta.trackName, false);
  writeAscii(bytes, 256, 32, bext.originator ?? 'Clip Stacker', false);
  writeAscii(bytes, 288, 32, bext.originatorReference ?? '', false);
  writeAscii(bytes, 320, 10, date, false);
  writeAscii(bytes, 330, 8, time, false);
  view.setUint32(338, meta.timeReference % UINT32_RANGE, true);
  view.setUint32(342, Math.floor(meta.timeReference / UINT32_RANGE), true);
  view.setUint16(346, bext.loudness ? 2 : 1, true);
  // 348: UMID, 64 zero bytes (none assigned).
  if (bext.loudness) {
    const { integrated, range, maxTruePeak, maxMomentary, maxShortTerm } = bext.loudness;
    [integrated, range, maxTruePeak, maxMomentary, maxShortTerm].forEach((value, i) => {
      view.setInt16(BEXT_LOUDNESS_OFFSET + i * 2, loudnessField(value), true);
    });
  }
  // 422: 180 reserved zero bytes.
  writeAscii(bytes, BEXT_FIXED_BYTES, history.length, history, true);
  return bytes;
}

function loudnessField(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return BEXT_LOUDNESS_UNSET;
  // Silence meters as −Infinity LUFS and lands on the int16 floor; the top
  // value stays reserved for "not measured".
  return Math.min(BEXT_LOUDNESS_UNSET - 1, Math.max(-0x8000, Math.round(value * 100)));
}

/** Fixed-width ASCII, NUL padded; other characters become `?` (controls become a space unless `keepCrLf`). */
function writeAscii(bytes: Uint8Array, offset: number, width: number, text: string, keepCrLf: boolean): void {
  const n = Math.min(width, text.length);
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    const crLf = code === 0x0d || code === 0x0a;
    if (code >= 0x20 && code < 0x7f) bytes[offset + i] = code;
    else if (code < 0x20 || code === 0x7f) bytes[offset + i] = keepCrLf && crLf ? code : 0x20;
    else bytes[offset + i] = 0x3f;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ixmlPayload(meta: ChunkContext, ixml: IxmlOptions): Uint8Array<ArrayBuffer> {
  const rate = resolveFrameRate(ixml.frameRate);
  const ntsc = (base: number): boolean => rate.numerator * 1001 === base * 1000 * rate.denominator;
  if (ixml.dropFrame && !ntsc(30) && !ntsc(60)) {
    throw new RangeError(`drop-frame timecode needs 30000/1001 or 60000/1001, got ${rate.numerator}/${rate.denominator}`);
  }
  const speed = `${rate.numerator}/${rate.denominator}`;
  const names = meta.channels === 1 ? [meta.trackName] : [`${meta.trackName} L`, `${meta.trackName} R`];
  const el = (indent: number, tag: string, value: string | number): string =>
    `${' '.repeat(indent)}<${tag}>${escapeXml(String(value))}</${tag}>`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<BWFXML>',
    el(2, 'IXML_VERSION', '1.61'),
    el(2, 'PROJECT', ixml.project ?? ''),
    ...(ixml.scene !== undefined ? [el(2, 'SCENE', ixml.scene)] : []),
    ...(ixml.take !== undefined ? [el(2, 'TAKE', ixml.take)] : []),
    el(2, 'TAPE', ixml.tape ?? ''),
    el(2, 'NOTE', ixml.note ?? ''),
    '  <SPEED>',
    el(4, 'MASTER_SPEED', speed),
    el(4, 'CURRENT_SPEED', speed),
    el(4, 'TIMECODE_RATE', speed),
    el(4, 'TIMECODE_FLAG', ixml.dropFrame ? 'DF' : 'NDF'),
    el(4, 'FILE_SAMPLE_RATE', meta.sampleRate),
    el(4, 'AUDIO_BIT_DEPTH', meta.bitsPerSample),
    el(4, 'DIGITIZER_SAMPLE_RATE', meta.sampleRate),
    el(4, 'TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI', Math.floor(meta.timeReference / UINT32_RANGE)),
    el(4, 'TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO', meta.timeReference % UINT32_RANGE),
    el(4, 'TIMESTAMP_SAMPLE_RATE', meta.sampleRate),
    '  </SPEED>',
    '  <TRACK_LIST>',
    el(4, 'TRACK_COUNT', names.length),
    ...names.flatMap((name, i) => [
      '    <TRACK>',
      el(6, 'CHANNEL_INDEX', i + 1),
      el(6, 'INTERLEAVE_INDEX', i + 1),
      el(6, 'NAME', name),
      '    </TRACK>',
    ]),
    '  </TRACK_LIST>',
    '</BWFXML>',
    '',
  ];
  const text = new TextEncoder().encode(lines.join('\n'));
  if (text.length % 2 === 0) return text;
  // Trailing whitespace after the root element is still well-formed XML.
  const even = new Uint8Array(text.length + 1);
  even.set(text);
  even[text.length] = 0x0a;
  return even;
}

const NTSC_BASES = [24, 30, 48, 60, 120];

function resolveFrameRate(rate: number | FrameRateRatio | undefined): FrameRateRatio {
  if (rate === undefined) return { numerator: 30, denominator: 1 };
  if (typeof rate === 'number') {
    if (Number.isInteger(rate) && rate > 0) return { numerator: rate, denominator: 1 };
    const base = NTSC_BASES.find((b) => Math.abs(rate - (b * 1000) / 1001) < 0.005);
    if (base !== undefined) return { numerator: base * 1000, denominator: 1001 };
    throw new RangeError(`frame rate ${rate} is not an integer or NTSC rate: pass { numerator, denominator }`);
  }
  const { numerator, denominator } = rate;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0) {
    throw new RangeError(`frame rate must be a ratio of positive integers, got ${numerator}/${denominator}`);
  }
  return { numerator, denominator };
}

/** XML text: the five entities escaped, characters XML 1.0 forbids dropped. */
function escapeXml(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0xfffe || code === 0xffff) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}
