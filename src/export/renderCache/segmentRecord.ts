/**
 * The on-disk form of one cached segment: the encoded video packets of a run
 * of frames plus the decoder config they need. One file per segment
 * (`render-cache/<settingsKey>/<segmentKey>.chunk`).
 *
 * Layout (little endian):
 *
 *     "CSRC"  u32 version  u32 headerLength  header (UTF-8 JSON)  payload
 *
 * The header lists every packet's type, timestamp, duration and byte length;
 * the payload is their bytes back to back. Timestamps are microseconds from
 * the segment's first frame, so a hit is rebased onto wherever the segment
 * lands in the new export. The first packet is always a key frame.
 *
 * Pure: bytes in, bytes out.
 */

const MAGIC = [0x43, 0x53, 0x52, 0x43]; // "CSRC"
export const SEGMENT_RECORD_VERSION = 1;
const PREFIX_BYTES = 12;

export interface SegmentPacket {
  type: 'key' | 'delta';
  /** Microseconds from the segment's first frame. */
  timestamp: number;
  /** Microseconds. */
  duration: number;
  data: Uint8Array;
}

/** What a decoder (and the muxer) needs to read the packets. */
export interface SegmentDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC / hvcC / av1C, when the codec has one. */
  description?: Uint8Array;
  colorSpace?: VideoColorSpaceInit;
}

export interface SegmentRecord {
  /** Output frames the segment covers. */
  frameCount: number;
  config: SegmentDecoderConfig;
  packets: SegmentPacket[];
}

interface SegmentHeader {
  v: number;
  frames: number;
  codec: string;
  w: number;
  h: number;
  desc: string | null;
  color: VideoColorSpaceInit | null;
  /** [type ('k' | 'd'), timestamp, duration, byteLength] per packet. */
  p: Array<[string, number, number, number]>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Total bytes of the encoded packets (what a hit saves re-encoding). */
export function segmentPayloadBytes(record: Pick<SegmentRecord, 'packets'>): number {
  return record.packets.reduce((sum, packet) => sum + packet.data.byteLength, 0);
}

export function encodeSegmentRecord(record: SegmentRecord): Uint8Array {
  if (record.packets.length === 0) throw new Error('A cached segment needs at least one packet');
  if (record.packets[0]!.type !== 'key') throw new Error('A cached segment must start on a key frame');
  const header: SegmentHeader = {
    v: SEGMENT_RECORD_VERSION,
    frames: record.frameCount,
    codec: record.config.codec,
    w: record.config.codedWidth,
    h: record.config.codedHeight,
    desc: record.config.description ? toBase64(record.config.description) : null,
    color: record.config.colorSpace ?? null,
    p: record.packets.map((packet) => [
      packet.type === 'key' ? 'k' : 'd',
      packet.timestamp,
      packet.duration,
      packet.data.byteLength,
    ]),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const payload = segmentPayloadBytes(record);
  const out = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + payload);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, SEGMENT_RECORD_VERSION, true);
  view.setUint32(8, headerBytes.byteLength, true);
  out.set(headerBytes, PREFIX_BYTES);
  let at = PREFIX_BYTES + headerBytes.byteLength;
  for (const packet of record.packets) {
    out.set(packet.data, at);
    at += packet.data.byteLength;
  }
  return out;
}

/** Parse a record; throws on anything malformed (a torn write, another version). */
export function decodeSegmentRecord(bytes: Uint8Array): SegmentRecord {
  if (bytes.byteLength < PREFIX_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('Not a render-cache segment');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== SEGMENT_RECORD_VERSION) throw new Error(`Unsupported segment version ${version}`);
  const headerLength = view.getUint32(8, true);
  if (PREFIX_BYTES + headerLength > bytes.byteLength) throw new Error('Truncated segment header');
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)),
  ) as SegmentHeader;
  if (!Array.isArray(header.p) || header.p.length === 0) throw new Error('Segment has no packets');
  let at = PREFIX_BYTES + headerLength;
  const packets: SegmentPacket[] = header.p.map(([type, timestamp, duration, length]) => {
    if (at + length > bytes.byteLength) throw new Error('Truncated segment payload');
    const data = bytes.slice(at, at + length);
    at += length;
    return { type: type === 'k' ? 'key' : 'delta', timestamp, duration, data };
  });
  if (at !== bytes.byteLength) throw new Error('Segment payload length mismatch');
  if (packets[0]!.type !== 'key') throw new Error('Segment does not start on a key frame');
  const config: SegmentDecoderConfig = { codec: header.codec, codedWidth: header.w, codedHeight: header.h };
  if (header.desc) config.description = fromBase64(header.desc);
  if (header.color) config.colorSpace = header.color;
  return { frameCount: header.frames, config, packets };
}

/**
 * Stable identity of a decoder config's parameter sets: the codec family and
 * the description bytes (for H.264, the SPS / PPS — `avc1` and `avc3` are
 * one family). Two spans with the same identity can share one sample entry.
 */
export function decoderConfigIdentity(config: Pick<SegmentDecoderConfig, 'codec' | 'description'>): string {
  const family = config.codec.startsWith('avc') ? 'avc' : config.codec.split('.')[0]!;
  return `${family}:${config.description ? toBase64(config.description) : ''}`;
}
