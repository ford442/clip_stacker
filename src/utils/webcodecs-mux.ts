import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Clip, ClipGroup, ClipTransition } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import {
  addAacChunksToMuxer,
  encodeTimelineAudio,
} from './webcodecs-audio';
import type { ResolvedEncoderCodec } from './webcodecs-codec';
import { WEBCODECS_PROGRESS_STAGES } from './webcodecs-codec';

export function createExportMuxer(
  width: number,
  height: number,
  encoderCodec: ResolvedEncoderCodec,
  includeAudio: boolean,
): Muxer<ArrayBufferTarget> {
  return new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: encoderCodec.muxerCodec, width, height },
    ...(includeAudio
      ? {
          audio: {
            codec: 'aac' as const,
            sampleRate: 48_000,
            numberOfChannels: 2,
          },
        }
      : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
}

export async function muxTimelineAudioIfRequested(
  muxer: Muxer<ArrayBufferTarget>,
  clips: Clip[],
  clipGroups: ClipGroup[],
  transitions: ClipTransition[],
  includeAudio: boolean,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (!includeAudio) return;
  onStatus('Mixing and encoding timeline audio (WebCodecs AAC)...');
  onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.audio, progress: 0.93, indeterminate: false });
  const encoded = await encodeTimelineAudio(clips, clipGroups, transitions);
  if (encoded) {
    addAacChunksToMuxer(muxer, encoded.chunks);
  }
}
