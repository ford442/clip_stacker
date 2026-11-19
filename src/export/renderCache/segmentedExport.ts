/**
 * The segmented video export: the programme is cut into content-keyed
 * segments (`renderKey.ts`), and each one is either
 *
 * - **copied** from its source (smart render, `smartRender.ts`),
 * - **reused** from the render cache (a hit: its encoded packets, rebased), or
 * - **rendered** — composited and encoded by a fresh `VideoEncoder` that
 *   starts on a key frame — and then stored in the cache.
 *
 * A fresh encoder per rendered segment is what makes a hit exactly what a
 * fresh render of that segment produces: no rate-control or reference state
 * carries in from the segments before it. Temporal noise reduction is reset
 * at each rendered segment's start for the same reason (`resetTemporal`).
 *
 * One track has one sample entry. When every piece shares its parameter sets
 * (the usual case: one encoder, or matching sources) the file is plain
 * `avc1`; when they differ (a copied camera file next to re-encoded frames)
 * an H.264 export is written `avc3` with the SPS / PPS in band before every
 * key frame. A non-H.264 hit whose parameter sets differ from this encoder's
 * is re-rendered instead. If a rendered piece turns out different from what
 * the file already committed to, the export throws
 * {@link SegmentConfigMismatchError} and the caller re-runs it continuously.
 *
 * WebGPU / WebCodecs stay behind the injected dependencies, so the
 * orchestration is unit tested with fakes (`segmentedExport.test.ts`).
 */

import type { Clip } from '../../types';
import type { PreviewCompositionPlan } from '../../composition/previewCompositionTypes';
import { frameKey, segmentFrames, type FrameKey, type FrameKeyContext } from '../renderKey';
import type { RenderCache } from './renderCache';
import { renderCachePath } from './renderCache';
import {
  decoderConfigIdentity,
  segmentPayloadBytes,
  type SegmentDecoderConfig,
  type SegmentPacket,
  type SegmentRecord,
} from './segmentRecord';
import {
  inBandAvcCodec,
  parseAvcDecoderConfig,
  passthroughFrame,
  passthroughRuns,
  planCopy,
  sourceCopyBlocker,
  withInBandParameterSets,
  type AvcDecoderConfig,
  type PassthroughFrame,
  type PassthroughSource,
  type SourcePacket,
} from './smartRender';

/** A rendered piece's parameter sets differ from what the file committed to. */
export class SegmentConfigMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentConfigMismatchError';
  }
}

/** Where encoded packets go (`Mp4Writer`). */
export interface SegmentSink {
  addVideoPacket(
    packet: { data: Uint8Array; type: 'key' | 'delta'; timestamp: number; duration: number },
    meta?: EncodedVideoChunkMetadata,
  ): void;
  throwIfFailed(): void;
}

export interface CopySource {
  source: PassthroughSource;
  /** Packets in decode order from the key frame at or before `startUs` through at least `endUs`. */
  readPackets(startUs: number, endUs: number): Promise<SourcePacket[]>;
}

export interface EncodedRange {
  /** Timestamps on the output grid (µs), decode order. */
  packets: SegmentPacket[];
  config: SegmentDecoderConfig;
}

export interface SegmentedExportDeps {
  totalFrames: number;
  frameDurationUs: number;
  width: number;
  height: number;
  /** The (quantized) plan of an output frame — what a render of it draws. */
  planFor(frameIndex: number): PreviewCompositionPlan;
  keyContext: Omit<FrameKeyContext, 'grainSeed'>;
  /** Grain is on: a frame's key includes its index. */
  frameSeeded: boolean;
  /** Encoder settings + frame-wide render settings (`settingsKey` in the cache path). */
  settingsKey: string;
  /** Null: render everything and store nothing. */
  cache: RenderCache | null;
  /** Null, or blockers non-empty: copy nothing. */
  smartRender: { blockers: string[]; openSource(clip: Clip): Promise<CopySource | null> } | null;
  /** Render + encode output frames [start, end) with a fresh encoder that starts on a key frame. */
  encodeRange(start: number, end: number, onFrame: () => void): Promise<EncodedRange>;
  /** This export's encoder config (one probe frame), for planning parameter sets. */
  probeEncoderConfig(): Promise<SegmentDecoderConfig>;
  sink: SegmentSink;
  onProgress(fraction: number): void;
  onStatus(message: string): void;
  /** Let the page breathe during long planning loops. */
  yieldNow?(): Promise<void>;
}

export interface SegmentedExportReport {
  /** Rendered + reused segments (copies not included). */
  segments: number;
  hits: number;
  misses: number;
  /** Rendered segments that could not be cached (`FrameSegment.uncacheable`). */
  uncacheable: number;
  copies: number;
  framesEncoded: number;
  framesReused: number;
  framesCopied: number;
  bytesReused: number;
  bytesStored: number;
  bytesCopied: number;
  /** `in-band`: an H.264 track with differing SPS / PPS, written `avc3`. */
  parameterSets: 'single' | 'in-band';
  reasons: string[];
}

type Piece =
  | { kind: 'copy'; start: number; end: number; packets: SourcePacket[]; config: SegmentDecoderConfig }
  | { kind: 'hit'; start: number; end: number; key: string; identity: string; record: SegmentRecord | null }
  | { kind: 'render'; start: number; end: number; key: string | null; uncacheable?: string };

function sourceConfig(source: PassthroughSource): SegmentDecoderConfig {
  const { config } = source;
  const out: SegmentDecoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth ?? 0,
    codedHeight: config.codedHeight ?? 0,
  };
  if (config.description) {
    const d = config.description;
    out.description = ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice()
      : new Uint8Array(d).slice();
  }
  return out;
}

function decoderConfigMeta(config: SegmentDecoderConfig, codec = config.codec): EncodedVideoChunkMetadata {
  const decoderConfig: VideoDecoderConfig = {
    codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
  };
  if (config.description) decoderConfig.description = config.description;
  if (config.colorSpace) decoderConfig.colorSpace = config.colorSpace;
  return { decoderConfig };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Plan copies: smart render's runs matched against their sources' packets. */
async function planCopies(
  deps: SegmentedExportDeps,
  candidates: ReadonlyArray<PassthroughFrame | null>,
  reasons: string[],
): Promise<Array<Extract<Piece, { kind: 'copy' }>>> {
  const smart = deps.smartRender;
  if (!smart || smart.blockers.length > 0) return [];
  const copies: Array<Extract<Piece, { kind: 'copy' }>> = [];
  for (const run of passthroughRuns(candidates, deps.frameDurationUs)) {
    const first = run[0]!;
    const title = first.clip.title;
    const source = await smart.openSource(first.clip).catch(() => null);
    if (!source) {
      reasons.push(`Smart render: "${title}" re-encoded — its packets could not be read`);
      continue;
    }
    const blocker = sourceCopyBlocker(source.source, deps.width, deps.height);
    if (blocker) {
      reasons.push(`Smart render: "${title}" re-encoded — ${blocker}`);
      continue;
    }
    const last = run.at(-1)!;
    const packets = await source.readPackets(first.sourceUs, last.sourceUs + deps.frameDurationUs);
    const plan = planCopy(run, packets, deps.frameDurationUs);
    if (!plan.copy) {
      reasons.push(`Smart render: "${title}" re-encoded — ${plan.reason ?? 'not copyable'}`);
      continue;
    }
    const { copy } = plan;
    reasons.push(
      `Smart render: copied ${copy.end - copy.start} frames of "${title}" from the source` +
        (plan.reason ? ` (${plan.reason})` : ''),
    );
    copies.push({ kind: 'copy', ...copy, config: sourceConfig(source.source) });
  }
  return copies;
}

function renderPieces(keys: readonly FrameKey[], start: number, end: number): Piece[] {
  return segmentFrames(keys.slice(start, end), { startFrame: start }).map((segment) => ({
    kind: 'render' as const,
    start: segment.start,
    end: segment.end,
    key: segment.key,
    ...(segment.uncacheable ? { uncacheable: segment.uncacheable } : {}),
  }));
}

export async function runSegmentedExport(deps: SegmentedExportDeps): Promise<SegmentedExportReport> {
  const { totalFrames, frameDurationUs } = deps;
  const reasons: string[] = [];
  const report: SegmentedExportReport = {
    segments: 0,
    hits: 0,
    misses: 0,
    uncacheable: 0,
    copies: 0,
    framesEncoded: 0,
    framesReused: 0,
    framesCopied: 0,
    bytesReused: 0,
    bytesStored: 0,
    bytesCopied: 0,
    parameterSets: 'single',
    reasons,
  };

  // -- 1. Key every frame (and spot the frames smart render could copy) -----
  deps.onStatus('Planning the render cache…');
  const copyAllowed = Boolean(deps.smartRender && deps.smartRender.blockers.length === 0);
  if (deps.smartRender && deps.smartRender.blockers.length > 0) {
    reasons.push(`Smart render off: ${deps.smartRender.blockers.join('; ')}`);
  }
  const keys: FrameKey[] = [];
  const candidates: Array<PassthroughFrame | null> = [];
  for (let i = 0; i < totalFrames; i++) {
    const plan = deps.planFor(i);
    keys.push(frameKey(plan, { ...deps.keyContext, grainSeed: deps.frameSeeded ? i : null }));
    if (copyAllowed) candidates.push(passthroughFrame(plan, i, deps.keyContext.clipsById));
    if (i % 600 === 599) await deps.yieldNow?.();
  }

  // -- 2. Pieces: copies, then segments over everything else ----------------
  const copies = await planCopies(deps, candidates, reasons);
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const copy of copies) {
    if (copy.start > cursor) pieces.push(...renderPieces(keys, cursor, copy.start));
    pieces.push(copy);
    cursor = copy.end;
  }
  if (cursor < totalFrames) pieces.push(...renderPieces(keys, cursor, totalFrames));

  // -- 3. Cache lookups (pinned for the rest of the export) -----------------
  const cache = deps.cache;
  const pinnedPaths: string[] = [];
  if (cache) {
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (piece.kind !== 'render' || !piece.key) continue;
      const entry = cache.peek(deps.settingsKey, piece.key);
      if (!entry) continue;
      let record: SegmentRecord | null = null;
      let identity = entry.config;
      if (!identity) {
        // Adopted from disk without an index entry: read it to learn its parameter sets.
        record = await cache.read(deps.settingsKey, piece.key);
        if (!record) continue;
        identity = decoderConfigIdentity(record.config);
      }
      pieces[i] = { kind: 'hit', start: piece.start, end: piece.end, key: piece.key, identity, record };
      pinnedPaths.push(renderCachePath(deps.settingsKey, piece.key));
    }
  }
  const release = cache?.pin(pinnedPaths) ?? (() => undefined);

  const pendingWrites: Array<Promise<boolean>> = [];
  try {
    // -- 4. Parameter sets: one sample entry for the whole track ------------
    const identities = new Set<string>();
    let probe: SegmentDecoderConfig | null = null;
    if (pieces.some((piece) => piece.kind === 'render')) {
      probe = await deps.probeEncoderConfig();
      identities.add(decoderConfigIdentity(probe));
    }
    for (const piece of pieces) {
      if (piece.kind === 'copy') identities.add(decoderConfigIdentity(piece.config));
      if (piece.kind === 'hit') identities.add(piece.identity);
    }
    const allAvc = [...identities].every((identity) => identity.startsWith('avc:'));
    if (identities.size > 1 && !allAvc) {
      // HEVC / AV1 have no in-band switch here: re-render hits from another encoder.
      const want = probe ? decoderConfigIdentity(probe) : null;
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        if (piece.kind === 'hit' && piece.identity !== want) {
          pieces[i] = { kind: 'render', start: piece.start, end: piece.end, key: piece.key };
          reasons.push('Render cache: a cached segment from another encoder configuration was re-rendered');
        }
      }
    } else if (identities.size > 1) {
      report.parameterSets = 'in-band';
      reasons.push(
        'Copied and re-encoded spans use different H.264 parameter sets: the track is written avc3 with SPS / PPS before every key frame',
      );
    }
    const inBand = report.parameterSets === 'in-band';

    // -- 5. Produce and mux, in order ---------------------------------------
    let fileIdentity: string | null = null;
    let fileCodec: string | null = null;
    let framesDone = 0;
    const avcConfigs = new Map<string, AvcDecoderConfig | null>();
    const avcConfigFor = (config: SegmentDecoderConfig): AvcDecoderConfig | null => {
      const identity = decoderConfigIdentity(config);
      if (!avcConfigs.has(identity)) {
        avcConfigs.set(identity, config.description ? parseAvcDecoderConfig(config.description) : null);
      }
      return avcConfigs.get(identity) ?? null;
    };

    const mux = (packets: readonly SegmentPacket[], config: SegmentDecoderConfig) => {
      const identity = decoderConfigIdentity(config);
      let meta: EncodedVideoChunkMetadata | undefined;
      if (fileIdentity === null) {
        fileIdentity = identity;
        fileCodec = inBand ? inBandAvcCodec(config.codec) : config.codec;
        meta = decoderConfigMeta(config, fileCodec);
      } else if (!inBand && identity !== fileIdentity) {
        throw new SegmentConfigMismatchError(
          'A rendered segment came out with other parameter sets than the rest of the file',
        );
      }
      const avc = inBand ? avcConfigFor(config) : null;
      if (inBand && !avc) throw new SegmentConfigMismatchError('An H.264 span has no readable avcC');
      for (const packet of packets) {
        const data = avc && packet.type === 'key' ? withInBandParameterSets(packet.data, avc) : packet.data;
        deps.sink.addVideoPacket(
          { data, type: packet.type, timestamp: packet.timestamp, duration: packet.duration },
          meta,
        );
        meta = undefined;
      }
      deps.sink.throwIfFailed();
    };

    for (const piece of pieces) {
      const frames = piece.end - piece.start;
      const startUs = piece.start * frameDurationUs;
      if (piece.kind === 'copy') {
        mux(piece.packets, piece.config);
        report.copies += 1;
        report.framesCopied += frames;
        report.bytesCopied += segmentPayloadBytes(piece);
      } else if (piece.kind === 'hit') {
        const record = piece.record ?? (await cache!.read(deps.settingsKey, piece.key));
        if (!record || record.frameCount !== frames) {
          throw new SegmentConfigMismatchError('A pinned cache segment could not be read back');
        }
        mux(
          record.packets.map((packet) => ({ ...packet, timestamp: packet.timestamp + startUs })),
          record.config,
        );
        report.segments += 1;
        report.hits += 1;
        report.framesReused += frames;
        report.bytesReused += segmentPayloadBytes(record);
      } else {
        let done = 0;
        const encoded = await deps.encodeRange(piece.start, piece.end, () => {
          done += 1;
          deps.onProgress((framesDone + done) / totalFrames);
        });
        if (encoded.packets[0]?.type !== 'key') {
          throw new SegmentConfigMismatchError('A rendered segment did not start on a key frame');
        }
        mux(encoded.packets, encoded.config);
        report.segments += 1;
        report.misses += 1;
        report.framesEncoded += frames;
        if (piece.key && cache) {
          const record: SegmentRecord = {
            frameCount: frames,
            config: encoded.config,
            packets: encoded.packets.map((packet) => ({ ...packet, timestamp: packet.timestamp - startUs })),
          };
          report.bytesStored += segmentPayloadBytes(record);
          pendingWrites.push(cache.write(deps.settingsKey, piece.key, record).catch(() => false));
        } else if (!piece.key) {
          report.uncacheable += 1;
        }
      }
      framesDone += frames;
      deps.onProgress(framesDone / totalFrames);
    }
  } finally {
    await Promise.all(pendingWrites);
    release();
    await cache?.flush().catch(() => undefined);
  }

  if (cache && report.segments > 0) {
    reasons.push(
      `Render cache: ${report.hits} of ${report.segments} segments reused ` +
        `(${report.framesReused} frames, ${formatBytes(report.bytesReused)}), ${report.misses} rendered` +
        (report.uncacheable > 0 ? ` (${report.uncacheable} not cacheable)` : ''),
    );
  }
  if (report.framesCopied > 0) {
    reasons.push(`Smart render: ${report.framesCopied} frames copied, ${report.framesEncoded} encoded`);
  }
  return report;
}
