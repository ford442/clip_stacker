/**
 * Smart render: copy a source's encoded packets into the export where the
 * timeline shows that source untouched, instead of decoding, compositing and
 * re-encoding them.
 *
 * A frame qualifies when its plan is one full-frame base layer at opacity 1
 * with nothing on it (no transition, warp, key, Ken Burns, title or caption),
 * the export applies no finishing or colour conversion, and the source is
 * H.264 at the output size, untagged or Rec.709. A run of such frames on one
 * clip whose source frames advance one by one (no speed change, no
 * duplicated or skipped frame — the source runs at the export rate) is then
 * matched against the source's packets:
 *
 * - the copy starts at the run's first source key frame; frames before it
 *   (a cut inside a GOP) are rendered and encoded;
 * - it ends at the last point where the packets copied so far, in decode
 *   order, are exactly a run of frames in presentation order (a "closed
 *   prefix"), so no copied B-frame references a dropped frame; the frames
 *   after it are rendered too;
 * - a leading picture (an open-GOP frame shown before its key frame) ends
 *   the copy, since it references the GOP before.
 *
 * Copied spans keep the source's parameter sets. When the export mixes
 * spans whose SPS / PPS differ (two cameras, or a copy next to re-encoded
 * frames), the track is written as `avc3` with the parameter sets in band
 * before every key frame (`withInBandParameterSets`).
 *
 * Pure: the caller reads the packets (`container/demux.ts`).
 */

import type { Clip } from '../../types';
import type { PreviewCompositionPlan } from '../../composition/previewCompositionTypes';
import { isFinishingActive, type FinishingSettings } from '../../finishing/finishing';
import {
  isColorManagementActive,
  type ColorManagementSettings,
} from '../../finishing/colorManagement';
import { clipIsReversed } from '../../timeline/reverseClip';
import { isSequenceClip } from '../../timeline/sequenceResolve';

/** One encoded source sample, in decode order (timestamps in µs, as `DemuxPacket`). */
export interface SourcePacket {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  readonly data: Uint8Array;
}

export interface PassthroughExportInput {
  smartRender: boolean;
  forceReencode: boolean;
  /** `ResolvedEncoderCodec.muxerCodec`. */
  muxerCodec: string;
  finishing?: FinishingSettings | undefined;
  colorManagement?: ColorManagementSettings | undefined;
}

/** Why this export copies nothing at all (empty = smart render may copy). */
export function smartRenderBlockers(input: PassthroughExportInput): string[] {
  const blockers: string[] = [];
  if (!input.smartRender) blockers.push('smart render is off');
  if (input.forceReencode) blockers.push('Force re-encode is on');
  if (input.muxerCodec !== 'avc') blockers.push('the export codec is not H.264');
  if (isFinishingActive(input.finishing)) blockers.push('finishing applies to every frame');
  if (isColorManagementActive(input.colorManagement)) blockers.push('colour management converts every frame');
  return blockers;
}

export interface PassthroughFrame {
  frameIndex: number;
  clip: Clip;
  /** The plan's source time, in µs. */
  sourceUs: number;
}

/** The source frame a plan shows untouched, or null when the frame must be rendered. */
export function passthroughFrame(
  plan: PreviewCompositionPlan,
  frameIndex: number,
  clipsById: ReadonlyMap<string, Clip>,
): PassthroughFrame | null {
  if (plan.capped || plan.scale !== 1) return null;
  const drawn = plan.layers.filter(
    (layer) => !((layer.kind === 'text' || layer.kind === 'caption') && !(layer.opacity > 0)),
  );
  if (drawn.length !== 1) return null;
  const layer = drawn[0]!;
  if (layer.kind !== 'base') return null;
  if (layer.opacity !== 1 || layer.crossfade || layer.mediaObjectUrl) return null;
  if (layer.warpMatrix || layer.pictureMatrix || layer.key) return null;
  // Every base layer carries its letterbox / Ken Burns UV; only identity is untouched.
  const [scaleX, scaleY] = layer.uvScale ?? [1, 1];
  const [offsetX, offsetY] = layer.uvOffset ?? [0, 0];
  if (scaleX !== 1 || scaleY !== 1 || offsetX !== 0 || offsetY !== 0) return null;
  const { rect } = layer;
  if (rect.x !== 0 || rect.y !== 0 || rect.width !== plan.canvasWidth || rect.height !== plan.canvasHeight) {
    return null;
  }
  const clip = clipsById.get(layer.clipId);
  if (!clip || clip.kind !== 'video' || clip.stillImage || clip.offline || isSequenceClip(clip)) return null;
  if (clipIsReversed(clip) || clip.colorSpaceOverride || clip.rifeProcessed) return null;
  return { frameIndex, clip, sourceUs: Math.round(layer.sourceTime * 1_000_000) };
}

/**
 * Split candidate frames into runs: consecutive output frames on one clip
 * whose source time advances by one output frame (± 1 µs of rounding).
 */
export function passthroughRuns(
  frames: ReadonlyArray<PassthroughFrame | null>,
  frameDurationUs: number,
): PassthroughFrame[][] {
  const runs: PassthroughFrame[][] = [];
  let current: PassthroughFrame[] = [];
  const close = () => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  for (const frame of frames) {
    if (!frame) {
      close();
      continue;
    }
    const prev = current.at(-1);
    if (
      prev &&
      (prev.clip.id !== frame.clip.id ||
        prev.frameIndex + 1 !== frame.frameIndex ||
        Math.abs(frame.sourceUs - prev.sourceUs - frameDurationUs) > 1)
    ) {
      close();
    }
    current.push(frame);
  }
  close();
  return runs;
}

/** What the source must be for its packets to stand in for rendered frames. */
export interface PassthroughSource {
  config: VideoDecoderConfig;
  /** Container / bitstream colour tags, or null when untagged. */
  colorSpace: VideoColorSpaceInit | null;
}

/** Why `source` cannot be copied into a `width`×`height` H.264 export, or null when it can. */
export function sourceCopyBlocker(source: PassthroughSource, width: number, height: number): string | null {
  const { config, colorSpace } = source;
  if (!config.codec.startsWith('avc1') && !config.codec.startsWith('avc3')) return 'the source is not H.264';
  if (config.codedWidth !== width || config.codedHeight !== height) {
    return `the source is ${config.codedWidth}x${config.codedHeight}, not the output ${width}x${height}`;
  }
  if (
    config.displayAspectWidth &&
    config.displayAspectHeight &&
    config.displayAspectWidth * height !== config.displayAspectHeight * width
  ) {
    return 'the source has a non-square pixel aspect';
  }
  const description = config.description ? descriptionBytes(config.description) : null;
  const avcc = description ? parseAvcDecoderConfig(description) : null;
  if (!avcc) return 'the source has no readable avcC';
  if (avcc.lengthSize !== 4) return 'the source uses short NAL length fields';
  if (colorSpace) {
    const bt709 = (value: string | null | undefined) => value == null || value === 'bt709';
    if (!bt709(colorSpace.primaries) || !bt709(colorSpace.transfer) || !bt709(colorSpace.matrix) || colorSpace.fullRange) {
      return 'the source is not tagged Rec.709 limited range';
    }
  }
  return null;
}

export interface CopyPiece {
  /** First output frame copied. */
  start: number;
  /** One past the last output frame copied. */
  end: number;
  /** Packets in decode order, timestamps already on the output grid (µs). */
  packets: SourcePacket[];
}

export interface CopyPlan {
  copy: CopyPiece | null;
  /** Why nothing (or less than the whole run) is copied. */
  reason?: string;
}

/** Index of the last sorted value ≤ `target`, or -1. */
function lastAtOrBefore(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The part of `run` that can be copied from `packets` (the source's packets
 * in decode order, from the key frame at or before the run's first source
 * time to at least the run's last frame).
 */
export function planCopy(
  run: readonly PassthroughFrame[],
  packets: readonly SourcePacket[],
  frameDurationUs: number,
): CopyPlan {
  if (run.length === 0 || packets.length === 0) return { copy: null, reason: 'no source packets' };
  // Presentation order: packet indices sorted by timestamp.
  const presentation = packets.map((_, i) => i).sort((a, b) => packets[a]!.timestamp - packets[b]!.timestamp);
  const ptsSorted = presentation.map((i) => packets[i]!.timestamp);
  // The source must run at the export rate (its median frame step, ± 1 %).
  const steps = ptsSorted.slice(1).map((pts, i) => pts - ptsSorted[i]!).sort((x, y) => x - y);
  const step = steps.length > 0 ? steps[steps.length >> 1]! : frameDurationUs;
  if (Math.abs(step - frameDurationUs) > frameDurationUs * 0.01) {
    return {
      copy: null,
      reason: `the source runs at ${(1_000_000 / step).toFixed(2)} fps, not the export's ${(1_000_000 / frameDurationUs).toFixed(2)}`,
    };
  }
  const presIndexOfDecode = new Array<number>(packets.length);
  presentation.forEach((decodeIndex, presIndex) => {
    presIndexOfDecode[decodeIndex] = presIndex;
  });

  // The source frame each output frame shows: the last one starting at or
  // before its (µs-quantized) source time, as the decoder cursor picks it.
  const shown = run.map((frame) => lastAtOrBefore(ptsSorted, frame.sourceUs));
  // Copying stands in for rendering only while output frames step through
  // source frames one by one.
  let consecutive = shown.length;
  for (let j = 0; j < shown.length; j++) {
    if (shown[j]! < 0 || (j > 0 && shown[j] !== shown[j - 1]! + 1)) {
      consecutive = j;
      break;
    }
  }
  if (consecutive === 0) return { copy: null, reason: 'the source frames do not line up with the export frame rate' };

  let jK = -1;
  for (let j = 0; j < consecutive; j++) {
    if (packets[presentation[shown[j]!]!]!.type === 'key') {
      jK = j;
      break;
    }
  }
  if (jK < 0) return { copy: null, reason: 'no source key frame inside the run' };

  const keyPres = shown[jK]!;
  const keyDecode = presentation[keyPres]!;
  const limit = consecutive - jK; // frames available from the key frame on
  let maxR = -1;
  let best = 0;
  for (let d = keyDecode; d < packets.length; d++) {
    const r = presIndexOfDecode[d]! - keyPres;
    if (r < 0 || r >= limit) break;
    maxR = Math.max(maxR, r);
    const count = d - keyDecode + 1;
    if (count === maxR + 1) best = count;
  }
  if (best === 0) return { copy: null, reason: 'the source GOP structure leaves no closed run to copy' };

  const startFrame = run[jK]!.frameIndex;
  const copied: SourcePacket[] = [];
  for (let d = keyDecode; d < keyDecode + best; d++) {
    const packet = packets[d]!;
    const r = presIndexOfDecode[d]! - keyPres;
    copied.push({
      type: packet.type,
      timestamp: (startFrame + r) * frameDurationUs,
      duration: frameDurationUs,
      data: packet.data,
    });
  }
  const copy: CopyPiece = { start: startFrame, end: startFrame + best, packets: copied };
  if (jK > 0) {
    return { copy, reason: 'the cut lands inside a source GOP: frames up to its next key frame are re-encoded' };
  }
  if (best < run.length) {
    return {
      copy,
      reason:
        jK + best === consecutive && consecutive < run.length
          ? 'the source frames stop lining up with the export frames: the rest is re-encoded'
          : 'the run ends inside a reordered GOP: its last frames are re-encoded',
    };
  }
  return { copy };
}

function descriptionBytes(description: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
}

export interface AvcDecoderConfig {
  /** Bytes per NAL length prefix. */
  lengthSize: number;
  sps: Uint8Array[];
  pps: Uint8Array[];
}

/** Parse an `avcC` box payload (ISO 14496-15), or null when malformed. */
export function parseAvcDecoderConfig(bytes: Uint8Array): AvcDecoderConfig | null {
  if (bytes.length < 7 || bytes[0] !== 1) return null;
  const lengthSize = (bytes[4]! & 0x03) + 1;
  let at = 5;
  const readSets = (count: number): Uint8Array[] | null => {
    const sets: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      if (at + 2 > bytes.length) return null;
      const length = (bytes[at]! << 8) | bytes[at + 1]!;
      at += 2;
      if (at + length > bytes.length) return null;
      sets.push(bytes.subarray(at, at + length));
      at += length;
    }
    return sets;
  };
  const sps = readSets(bytes[at++]! & 0x1f);
  if (!sps || at >= bytes.length) return null;
  const pps = readSets(bytes[at++]!);
  if (!pps) return null;
  return { lengthSize, sps, pps };
}

/**
 * `data` (a length-prefixed H.264 access unit) with the SPS / PPS of `config`
 * in front, so a decoder that meets the key frame mid-stream (a seek, or a
 * span with other parameter sets before it) reconfigures. Returned as is
 * when it already starts with an SPS.
 */
export function withInBandParameterSets(data: Uint8Array, config: AvcDecoderConfig): Uint8Array {
  const { lengthSize } = config;
  if (data.length > lengthSize && (data[lengthSize]! & 0x1f) === 7) return data;
  const sets = [...config.sps, ...config.pps];
  const extra = sets.reduce((sum, set) => sum + lengthSize + set.length, 0);
  const out = new Uint8Array(extra + data.length);
  let at = 0;
  for (const set of sets) {
    for (let b = lengthSize - 1; b >= 0; b--) out[at++] = (set.length >>> (8 * b)) & 0xff;
    out.set(set, at);
    at += set.length;
  }
  out.set(data, at);
  return out;
}

/** `avc1.PPCCLL` → `avc3.PPCCLL` (the in-band parameter-set sample entry). */
export function inBandAvcCodec(codec: string): string {
  return codec.replace(/^avc1/, 'avc3');
}
