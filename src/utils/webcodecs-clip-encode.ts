/**
 * Sequential per-clip WebCodecs encode (VideoDecoder hot path + HTMLVideo fallback).
 */

import type { Clip } from '../types';
import { DEFAULT_FINISHING, type FinishingSettings } from './finishing';
import { ClipFrameDecoder } from './webcodecs-decoder';
import {
  TARGET_FPS,
  waitForEncoderDequeue,
} from './webcodecs-codec';
import {
  captureCompositedFrame,
  drawBlackFrame,
  drawCompositedFrame,
  drawCompositedVideoFrame,
  waitForSeeked,
  type DecoderTextOverlayPass,
  type ResolvedCompositor,
} from './webcodecs-compositor';
import { shouldWaitForEncoderBackpressure } from './webcodecs-timeline';

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
  const clipDuration = trimEnd - trimStart;

  if (clip.kind === 'audio') {
    drawBlackFrame(compositor, targetWidth, targetHeight);
    const frame = await captureCompositedFrame(
      compositor,
      overlayPass,
      clipGlobalStartSec,
      startTimeUs,
      Math.round(clipDuration * 1_000_000),
    );
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    return startTimeUs + Math.round(clipDuration * 1_000_000);
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
      clipDuration,
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
    video.playbackRate = 3.0;

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

          const elapsed = Math.max(0, mediaTime - trimStart);
          const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);
          drawCompositedFrame(
            compositor,
            video,
            elapsed,
            clipDuration,
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
              Math.round(1_000_000 / TARGET_FPS),
            );
            encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
            frame.close();
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

        const elapsed = t - trimStart;
        const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);
        drawCompositedFrame(
          compositor,
          video,
          elapsed,
          clipDuration,
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
          Math.round(1_000_000 / TARGET_FPS),
        );
        encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
        frame.close();
        frameCount++;
        t += stepSeconds;
      }
    }
  } finally {
    video.src = '';
    if (document.body.contains(video)) document.body.removeChild(video);
  }

  return startTimeUs + Math.round(clipDuration * 1_000_000);
}

/**
 * Decoder-driven frame delivery: VideoDecoder → ring buffer → compositor →
 * VideoEncoder, no HTMLVideoElement in the loop. Runs at decode speed rather
 * than playback speed.
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
  clipDuration: number,
  clipGlobalStartSec: number,
  overlayPass: DecoderTextOverlayPass | null,
): Promise<number> {
  const decoder = await ClipFrameDecoder.open(clip.file, { trimStart, trimEnd });
  let frameCount = 0;

  try {
    for await (const frame of decoder.frames()) {
      const elapsed = Math.max(0, frame.timestamp / 1_000_000 - trimStart);
      try {
        drawCompositedVideoFrame(
          compositor,
          frame,
          elapsed,
          clipDuration,
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
        Math.round(1_000_000 / TARGET_FPS),
      );
      encoder.encode(encodedFrame, { keyFrame: frameCount % 60 === 0 });
      encodedFrame.close();
      frameCount++;

      if (shouldWaitForEncoderBackpressure(encoder.encodeQueueSize)) {
        await waitForEncoderDequeue(encoder);
      }
    }
  } finally {
    decoder.close();
  }

  if (frameCount === 0) {
    throw new Error('VideoDecoder path produced no frames');
  }
  return startTimeUs + Math.round(clipDuration * 1_000_000);
}
