/**
 * Sequential per-clip WebCodecs encode (VideoDecoder hot path + HTMLVideo fallback).
 */

import type { Clip } from '../types';
import { constantRateOutputElapsed, getClipPlaybackRate } from './playbackRate';
import { DEFAULT_FINISHING, type FinishingSettings } from './finishing';
import { ClipFrameDecoder } from './webcodecs-decoder';
import { TARGET_FPS } from './webcodecs-codec';
import { encodeAndClose, waitForQueueBelow } from './codecQueue';
import {
  captureCompositedFrame,
  drawBlackFrame,
  drawCompositedFrame,
  drawCompositedVideoFrame,
  waitForSeeked,
  type DecoderTextOverlayPass,
  type ResolvedCompositor,
} from './webcodecs-compositor';
import { MAX_ENCODE_QUEUE_DEPTH } from './webcodecs-timeline';

declare global {
  interface HTMLVideoElement {
    requestVideoFrameCallback(
      callback: (now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void,
    ): number;
    cancelVideoFrameCallback(handle: number): void;
  }
}

export async function encodeVideoFrames(
  encoder: VideoEncoder,
  compositor: ResolvedCompositor,
  clip: Clip,
  startTimeUs: number,
  targetWidth: number,
  targetHeight: number,
  finishing: FinishingSettings = DEFAULT_FINISHING,
  clipGlobalStartSec = 0,
  overlayPass: DecoderTextOverlayPass | null = null,
): Promise<number> {
  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const sourceDuration = trimEnd - trimStart;
  // Output span is the trimmed source divided by the constant playback rate.
  // Speed clips are normally routed to the timeline compositor; this keeps the
  // sequential path from writing a 1× file if it is reached anyway.
  const outputDuration = constantRateOutputElapsed(sourceDuration, getClipPlaybackRate(clip));

  if (clip.kind === 'audio') {
    drawBlackFrame(compositor, targetWidth, targetHeight);
    const frame = await captureCompositedFrame(
      compositor,
      overlayPass,
      clipGlobalStartSec,
      startTimeUs,
      Math.round(outputDuration * 1_000_000),
    );
    encodeAndClose(encoder, frame, { keyFrame: true });
    return startTimeUs + Math.round(outputDuration * 1_000_000);
  }

  // Preferred hot path: WebCodecs VideoDecoder demux/decode — exact frame
  // delivery with no <video> seek in the loop. Falls back to element capture
  // for containers/codecs the decoder path cannot handle.
  try {
    return await encodeVideoFramesFromDecoder(
      encoder,
      compositor,
      clip,
      startTimeUs,
      targetWidth,
      targetHeight,
      finishing,
      trimStart,
      trimEnd,
      outputDuration,
      clipGlobalStartSec,
      overlayPass,
    );
  } catch {
    // Fall through to the HTMLVideoElement capture path below.
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
  document.body.appendChild(video);

  try {
    video.src = clip.objectUrl;
    video.currentTime = trimStart;
    await waitForSeeked(video);
    // Capture faster than realtime. Timestamps below follow media time, then
    // the clip's playback rate, so this 3× does not change the exported speed.
    video.playbackRate = 3.0;
    const contentRate = getClipPlaybackRate(clip);

    let frameCount = 0;

    if (video.requestVideoFrameCallback) {
      await new Promise<void>((resolve, reject) => {
        let done = false;

        const onFrame = async (_now: DOMHighResTimeStamp, meta: { mediaTime: number }) => {
          if (done) return;

          const mediaTime = meta.mediaTime;
          if (mediaTime >= trimEnd - 1 / TARGET_FPS) {
            done = true;
            resolve();
            return;
          }

          const sourceElapsed = Math.max(0, mediaTime - trimStart);
          const elapsed = constantRateOutputElapsed(sourceElapsed, contentRate);
          const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);
          drawCompositedFrame(
            compositor,
            video,
            elapsed,
            outputDuration,
            clip,
            targetWidth,
            targetHeight,
            finishing,
            frameCount,
          );

          try {
            const frame = await captureCompositedFrame(
              compositor,
              overlayPass,
              clipGlobalStartSec + elapsed,
              timestamp,
              Math.max(1, Math.round(1_000_000 / TARGET_FPS / contentRate)),
            );
            encodeAndClose(encoder, frame, { keyFrame: frameCount % 60 === 0 });
            frameCount++;
          } catch (err) {
            done = true;
            reject(err);
            return;
          }

          video.requestVideoFrameCallback!(onFrame);
        };

        video.addEventListener('ended', () => { done = true; resolve(); }, { once: true });
        video.addEventListener('error', reject, { once: true });
        video.requestVideoFrameCallback!(onFrame);
        video.play().catch(reject);
      });
    } else {
      const stepSeconds = 1 / TARGET_FPS;
      let t = trimStart;
      while (t < trimEnd) {
        video.currentTime = t;
        await waitForSeeked(video);

        const sourceElapsed = t - trimStart;
        const elapsed = constantRateOutputElapsed(sourceElapsed, contentRate);
        const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);
        drawCompositedFrame(
          compositor,
          video,
          elapsed,
          outputDuration,
          clip,
          targetWidth,
          targetHeight,
          finishing,
          frameCount,
        );

        const frame = await captureCompositedFrame(
          compositor,
          overlayPass,
          clipGlobalStartSec + elapsed,
          timestamp,
          Math.max(1, Math.round(1_000_000 / TARGET_FPS / contentRate)),
        );
        encodeAndClose(encoder, frame, { keyFrame: frameCount % 60 === 0 });
        frameCount++;
        t += stepSeconds;
        await waitForQueueBelow(encoder, MAX_ENCODE_QUEUE_DEPTH + 1);
      }
    }
  } finally {
    video.src = '';
    if (document.body.contains(video)) document.body.removeChild(video);
  }

  return startTimeUs + Math.round(outputDuration * 1_000_000);
}

/**
 * Decoder-driven frame delivery: VideoDecoder → ring buffer → compositor →
 * VideoEncoder, no HTMLVideoElement in the loop. Runs at decode speed rather
 * than playback speed. Frame timestamps are output-timeline seconds
 * (`sourceElapsed / playbackRate`), so a 2× clip occupies half the file.
 */
async function encodeVideoFramesFromDecoder(
  encoder: VideoEncoder,
  compositor: ResolvedCompositor,
  clip: Clip,
  startTimeUs: number,
  targetWidth: number,
  targetHeight: number,
  finishing: FinishingSettings,
  trimStart: number,
  trimEnd: number,
  outputDuration: number,
  clipGlobalStartSec: number,
  overlayPass: DecoderTextOverlayPass | null,
): Promise<number> {
  const decoder = await ClipFrameDecoder.open(clip.file, { trimStart, trimEnd });
  const contentRate = getClipPlaybackRate(clip);
  let frameCount = 0;

  try {
    for await (const frame of decoder.frames()) {
      const sourceElapsed = Math.max(0, frame.timestamp / 1_000_000 - trimStart);
      const elapsed = constantRateOutputElapsed(sourceElapsed, contentRate);
      try {
        drawCompositedVideoFrame(
          compositor,
          frame,
          elapsed,
          outputDuration,
          clip,
          targetWidth,
          targetHeight,
          finishing,
          frameCount,
        );
      } finally {
        frame.close();
      }

      const encodedFrame = await captureCompositedFrame(
        compositor,
        overlayPass,
        clipGlobalStartSec + elapsed,
        startTimeUs + Math.round(elapsed * 1_000_000),
        Math.max(1, Math.round(1_000_000 / TARGET_FPS / contentRate)),
      );
      encodeAndClose(encoder, encodedFrame, { keyFrame: frameCount % 60 === 0 });
      frameCount++;
      await waitForQueueBelow(encoder, MAX_ENCODE_QUEUE_DEPTH + 1);
    }
  } finally {
    decoder.close();
  }

  if (frameCount === 0) {
    throw new Error('VideoDecoder path produced no frames');
  }
  return startTimeUs + Math.round(outputDuration * 1_000_000);
}
