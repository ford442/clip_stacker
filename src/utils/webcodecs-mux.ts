import type { Clip, ClipGroup, ClipTransition } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { Mp4Writer } from './container';
import {
  AAC_CHANNELS,
  AAC_SAMPLE_RATE,
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
): Mp4Writer {
  return new Mp4Writer({
    video: { codec: encoderCodec.muxerCodec, width, height },
    ...(includeAudio
      ? { audio: { codec: 'aac' as const, sampleRate: AAC_SAMPLE_RATE, numberOfChannels: AAC_CHANNELS } }
      : {}),
  });
}

export async function muxTimelineAudioIfRequested(
  muxer: Mp4Writer,
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
