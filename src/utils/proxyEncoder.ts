/**
 * Encode a preview proxy with the WebCodecs path export already ships:
 * `ClipFrameDecoder` (forward decode, never seeks) → canvas blit to the proxy
 * size → `VideoEncoder` (H.264) → `mp4-muxer`. No FFmpeg, no new dependency.
 *
 * Frame timestamps are the source's, untouched, so a proxy cursor opened at a
 * trim window lands on the same source times the original would. No audio
 * track: the live preview's Web Audio graph decodes the original's sound once
 * per clip, which costs nothing like a 4K video decode does.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { ClipFrameDecoder } from './webcodecs-decoder';
import { h264CodecString } from './webcodecs-codec';
import { encodeAndClose, waitForQueueBelow } from './codecQueue';
import { PROXY_PROFILE, ProxyFrameSelector, type ProxyProfile } from './proxyMedia';

/** Encoded frames allowed in flight before the loop waits on `dequeue`. */
const MAX_ENCODE_QUEUE = 8;

export class ProxyBuildCancelled extends Error {
  constructor() {
    super('proxy build cancelled');
    this.name = 'ProxyBuildCancelled';
  }
}

export interface EncodeProxyOptions {
  width: number;
  height: number;
  /** Source duration (seconds), for progress; non-finite decodes to the end. */
  durationSec: number;
  profile?: ProxyProfile;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

interface ProxyBlitter {
  frameFrom(source: VideoFrame, timestamp: number, duration: number): VideoFrame;
}

function createBlitter(width: number, height: number): ProxyBlitter {
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    canvas = c;
    ctx = c.getContext('2d', { alpha: false });
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    canvas = c;
    ctx = c.getContext('2d', { alpha: false });
  }
  if (!ctx || !canvas) throw new Error('no 2D canvas available to scale the proxy');
  ctx.imageSmoothingQuality = 'high';
  return {
    frameFrom(source, timestamp, duration) {
      ctx!.drawImage(source as unknown as CanvasImageSource, 0, 0, width, height);
      return new VideoFrame(canvas as unknown as CanvasImageSource, { timestamp, duration });
    },
  };
}

/** First H.264 profile (High → Main → Baseline) the encoder accepts at this size. */
async function resolveProxyEncoderConfig(
  width: number,
  height: number,
  profile: ProxyProfile,
): Promise<VideoEncoderConfig> {
  for (const level of ['high', 'main', 'baseline'] as const) {
    const config: VideoEncoderConfig = {
      codec: h264CodecString(width, height, level),
      width,
      height,
      bitrate: profile.bitrate,
      bitrateMode: 'variable',
      framerate: profile.maxFps,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // Try the next profile.
    }
  }
  throw new Error(`no H.264 encoder for a ${width}x${height} proxy`);
}

/** Encode `source` into a proxy MP4. Throws {@link ProxyBuildCancelled} on abort. */
export async function encodeProxy(source: Blob, options: EncodeProxyOptions): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('WebCodecs is not available in this browser');
  }
  const profile = options.profile ?? PROXY_PROFILE;
  const { width, height, signal } = options;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new ProxyBuildCancelled();
  };

  const config = await resolveProxyEncoderConfig(width, height, profile);
  throwIfCancelled();

  const durationSec =
    Number.isFinite(options.durationSec) && options.durationSec > 0 ? options.durationSec : Infinity;
  const decoder = await ClipFrameDecoder.open(source, { trimStart: 0, trimEnd: durationSec });

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: profile.maxFps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure(config);

  const blitter = createBlitter(width, height);
  const selector = new ProxyFrameSelector(profile.maxFps);
  const frameDurationUs = Math.round(1_000_000 / profile.maxFps);
  let nextKeyframeSec = 0;

  try {
    for await (const frame of decoder.frames()) {
      try {
        throwIfCancelled();
        if (encodeError) throw encodeError;
        const t = frame.timestamp / 1_000_000;
        if (!selector.accept(t)) continue;

        const keyFrame = t + 5e-4 >= nextKeyframeSec;
        if (keyFrame) nextKeyframeSec = t + profile.keyframeIntervalSec;
        const scaled = blitter.frameFrom(frame, frame.timestamp, frame.duration ?? frameDurationUs);
        encodeAndClose(encoder, scaled, { keyFrame });
        if (Number.isFinite(durationSec)) {
          options.onProgress?.(Math.min(0.99, t / durationSec));
        }
      } finally {
        frame.close();
      }
      await waitForQueueBelow(encoder, MAX_ENCODE_QUEUE + 1).catch((err: unknown) => {
        throw encodeError ?? err;
      });
    }
    throwIfCancelled();
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    options.onProgress?.(1);
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    decoder.close();
    if (encoder.state !== 'closed') {
      try {
        encoder.close();
      } catch {
        // Already closed by an error.
      }
    }
  }
}
