/**
 * WebCodecs-based encoder for GPU-accelerated video export.
 *
 * Architecture:
 *  - Video: HTMLVideoElement → requestVideoFrameCallback → VideoEncoder (H.264 hardware) → mp4-muxer
 *  - Audio: fetch(objectUrl) → AudioContext.decodeAudioData → AudioEncoder (AAC) → mp4-muxer
 *
 * Falls back gracefully; callers should wrap in try/catch and fall back to FFmpeg.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Clip } from '../types';
import type { ExportSettings } from '../types';
import type { StatusCallback } from '../ffmpeg/ffmpegService';
import { getClipDuration } from './project';

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;
const AUDIO_FRAME_SIZE = 1024; // AAC standard

// ---------------------------------------------------------------------------
// Type declarations for APIs not yet present in all TS DOM libs
// ---------------------------------------------------------------------------

declare global {
  interface HTMLVideoElement {
    requestVideoFrameCallback(
      callback: (now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void,
    ): number;
    cancelVideoFrameCallback(handle: number): void;
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export async function isWebCodecsAvailable(): Promise<boolean> {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof AudioEncoder === 'undefined'
  ) {
    return false;
  }
  try {
    const [videoSupport, audioSupport] = await Promise.all([
      VideoEncoder.isConfigSupported({
        codec: 'avc1.42001e',
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        hardwareAcceleration: 'prefer-hardware',
      }),
      AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfChannels: AUDIO_CHANNELS,
        bitrate: 128_000,
      }),
    ]);
    return videoSupport.supported === true && audioSupport.supported === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main encode entry point
// ---------------------------------------------------------------------------

export async function encodeClipsWithWebCodecs(
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
): Promise<Blob> {
  onStatus('Initializing GPU encoder...');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: TARGET_WIDTH, height: TARGET_HEIGHT },
    audio: { codec: 'aac', sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS },
    fastStart: 'in-memory',
  });

  let videoError: Error | null = null;
  let audioError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { videoError = e; },
  });

  videoEncoder.configure({
    codec: 'avc1.42001e',
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    bitrate: settings.videoBitrate,
    framerate: TARGET_FPS,
    hardwareAcceleration: 'prefer-hardware',
  });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { audioError = e; },
  });

  audioEncoder.configure({
    codec: 'mp4a.40.2',
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: 128_000,
  });

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = TARGET_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  let videoTimeUs = 0;
  let audioTimeUs = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    onStatus(`GPU encode [${i + 1}/${clips.length}]: "${clip.title}"...`);

    const clipDuration = getClipDuration(clip);

    // Encode video frames
    videoTimeUs = await encodeVideoFrames(
      videoEncoder,
      canvas,
      ctx,
      clip,
      videoTimeUs,
    );
    if (videoError) throw videoError;

    // Encode audio frames
    audioTimeUs = await encodeAudioFrames(audioEncoder, clip, audioTimeUs, clipDuration);
    if (audioError) throw audioError;
  }

  onStatus('Flushing encoders...');
  await videoEncoder.flush();
  await audioEncoder.flush();

  if (videoError) throw videoError;
  if (audioError) throw audioError;

  muxer.finalize();

  const { buffer } = muxer.target as ArrayBufferTarget;
  return new Blob([buffer], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------------
// Video encoding — requestVideoFrameCallback path
// ---------------------------------------------------------------------------

async function encodeVideoFrames(
  encoder: VideoEncoder,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  startTimeUs: number,
): Promise<number> {
  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const clipDuration = trimEnd - trimStart;

  if (clip.kind === 'audio') {
    // For audio-only clips, synthesise a black video frame at the start + end
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const frame = new VideoFrame(canvas, {
      timestamp: startTimeUs,
      duration: Math.round(clipDuration * 1_000_000),
    });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    return startTimeUs + Math.round(clipDuration * 1_000_000);
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // Append off-screen so requestVideoFrameCallback is fully supported
  video.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
  document.body.appendChild(video);

  try {
    video.src = clip.objectUrl;
    video.currentTime = trimStart;
    await waitForSeeked(video);

    let frameCount = 0;

    if (video.requestVideoFrameCallback) {
      // requestVideoFrameCallback path — fires for every decoded frame
      await new Promise<void>((resolve, reject) => {
        let done = false;

        const onFrame = (_now: DOMHighResTimeStamp, meta: { mediaTime: number }) => {
          if (done) return;

          const mediaTime = meta.mediaTime;
          if (mediaTime >= trimEnd - 1 / TARGET_FPS) {
            done = true;
            resolve();
            return;
          }

          const elapsed = Math.max(0, mediaTime - trimStart);
          const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          applyFadeOverlay(ctx, canvas, elapsed, clipDuration, clip.videoFadeIn, clip.videoFadeOut);

          const frame = new VideoFrame(canvas, {
            timestamp,
            duration: Math.round(1_000_000 / TARGET_FPS),
          });
          encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
          frame.close();
          frameCount++;

          video.requestVideoFrameCallback!(onFrame);
        };

        video.addEventListener('ended', () => { done = true; resolve(); }, { once: true });
        video.addEventListener('error', reject, { once: true });
        video.requestVideoFrameCallback!(onFrame);
        video.play().catch(reject);
      });
    } else {
      // Seek-step fallback (slower but universal)
      const stepSeconds = 1 / TARGET_FPS;
      let t = trimStart;
      while (t < trimEnd) {
        video.currentTime = t;
        await waitForSeeked(video);

        const elapsed = t - trimStart;
        const timestamp = startTimeUs + Math.round(elapsed * 1_000_000);

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        applyFadeOverlay(ctx, canvas, elapsed, clipDuration, clip.videoFadeIn, clip.videoFadeOut);

        const frame = new VideoFrame(canvas, {
          timestamp,
          duration: Math.round(1_000_000 / TARGET_FPS),
        });
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

// ---------------------------------------------------------------------------
// Audio encoding — Web Audio API path
// ---------------------------------------------------------------------------

async function encodeAudioFrames(
  encoder: AudioEncoder,
  clip: Clip,
  startTimeUs: number,
  clipDuration: number,
): Promise<number> {
  let arrayBuffer: ArrayBuffer;
  try {
    const response = await fetch(clip.objectUrl);
    arrayBuffer = await response.arrayBuffer();
  } catch {
    // If fetching fails (e.g., revoked URL), write silence
    return startTimeUs + Math.round(clipDuration * 1_000_000);
  }

  const audioCtx = new OfflineAudioContext(
    AUDIO_CHANNELS,
    Math.ceil(clipDuration * AUDIO_SAMPLE_RATE),
    AUDIO_SAMPLE_RATE,
  );

  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch {
    // Non-audio or undecodable — skip audio for this clip
    return startTimeUs + Math.round(clipDuration * 1_000_000);
  }

  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const trimmedLength = Math.ceil((trimEnd - trimStart) * audioBuffer.sampleRate);

  // Feed audio to encoder in AAC frame-sized chunks
  let offset = 0;
  let audioTimeUs = startTimeUs;
  const frameUs = Math.round((AUDIO_FRAME_SIZE / AUDIO_SAMPLE_RATE) * 1_000_000);

  while (offset < trimmedLength) {
    const chunkSize = Math.min(AUDIO_FRAME_SIZE, trimmedLength - offset);
    const srcOffset = Math.floor(trimStart * audioBuffer.sampleRate) + offset;

    // Build interleaved float32 data for all channels
    const interleaved = new Float32Array(chunkSize * AUDIO_CHANNELS);
    for (let ch = 0; ch < Math.min(AUDIO_CHANNELS, audioBuffer.numberOfChannels); ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < chunkSize; i++) {
        const sampleIndex = srcOffset + i;
        let sample = sampleIndex < channelData.length ? channelData[sampleIndex] : 0;

        // Apply audio fades
        const elapsed = (offset + i) / audioBuffer.sampleRate;
        const fadeGain = computeFadeAlpha(elapsed, clipDuration, clip.audioFadeIn, clip.audioFadeOut);
        sample *= fadeGain;

        interleaved[i * AUDIO_CHANNELS + ch] = sample;
      }
    }

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfFrames: chunkSize,
      numberOfChannels: AUDIO_CHANNELS,
      timestamp: audioTimeUs,
      data: buildPlanarData(interleaved, chunkSize, AUDIO_CHANNELS),
    });

    encoder.encode(audioData);
    audioData.close();

    offset += chunkSize;
    audioTimeUs += frameUs;
  }

  return startTimeUs + Math.round(clipDuration * 1_000_000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isNaN(video.readyState) && video.readyState >= 2) {
      resolve();
      return;
    }
    const onSeeked = () => { off(); resolve(); };
    const onError = () => { off(); reject(new Error('Video seek failed')); };
    const off = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function applyFadeOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  elapsed: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
): void {
  const alpha = computeFadeAlpha(elapsed, duration, fadeIn, fadeOut);
  if (alpha < 1) {
    ctx.fillStyle = `rgba(0,0,0,${(1 - alpha).toFixed(4)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function computeFadeAlpha(elapsed: number, duration: number, fadeIn: number, fadeOut: number): number {
  let alpha = 1;
  if (fadeIn > 0 && elapsed < fadeIn) alpha = Math.min(alpha, elapsed / fadeIn);
  if (fadeOut > 0 && elapsed > duration - fadeOut) {
    alpha = Math.min(alpha, (duration - elapsed) / fadeOut);
  }
  return Math.max(0, Math.min(1, alpha));
}

/** Convert interleaved float32 to planar format (required by f32-planar AudioData). */
function buildPlanarData(
  interleaved: Float32Array,
  frames: number,
  channels: number,
): Float32Array<ArrayBuffer> {
  const planar = new Float32Array(new ArrayBuffer(frames * channels * 4));
  for (let ch = 0; ch < channels; ch++) {
    for (let i = 0; i < frames; i++) {
      planar[ch * frames + i] = interleaved[i * channels + ch];
    }
  }
  return planar;
}
