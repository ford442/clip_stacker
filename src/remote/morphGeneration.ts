import type { Clip, ClipTransition } from '../types';
import {
  createFailedMorphSegment,
  createGeneratingMorphSegment,
  createReadyMorphSegment,
  formatMorphFailureMessage,
  getMorphNeighborClips,
  morphFrameCountForDuration,
} from './morphTransition';

type StatusCallback = (message: string) => void;

/**
 * Extract a frame pair, call the HF /morph endpoint, and store the segment on
 * the transition. Surfaces progress through `onStatus` (upload/processing/download).
 */
export async function requestMorphSegment(
  transition: ClipTransition,
  timelineClips: Clip[],
  onStatus: StatusCallback,
  onTransitionUpdate: (updated: ClipTransition) => void,
): Promise<void> {
  const neighbors = getMorphNeighborClips(transition, timelineClips);
  if (!neighbors) {
    onStatus(
      'Morph transitions require two adjacent video clips with valid trim windows.',
    );
    onTransitionUpdate({
      ...transition,
      morphSegment: createFailedMorphSegment(
        transition.duration,
        'Adjacent video clips are required for morph.',
        transition.morphSegment,
      ),
    });
    return;
  }

  onTransitionUpdate({
    ...transition,
    morphSegment: createGeneratingMorphSegment(
      transition.duration,
      transition.morphSegment,
    ),
  });

  try {
    const { extractMorphFramePair } = await import('../ffmpeg/extract');
    const { generateMorphTransition } = await import('./huggingface');

    const pairBlob = await extractMorphFramePair(
      neighbors.clipA,
      neighbors.clipB,
      onStatus,
    );

    const frameCount = morphFrameCountForDuration(transition.duration);
    const { blob, duration } = await generateMorphTransition(
      pairBlob,
      frameCount,
      (event) => {
        onStatus(event.message ?? `Morph: ${event.stage}…`);
      },
    );

    const file = new File(
      [blob],
      `morph_${transition.afterClipIndex}.mp4`,
      { type: blob.type || 'video/mp4' },
    );
    const objectUrl = URL.createObjectURL(file);

    onTransitionUpdate({
      ...transition,
      morphSegment: createReadyMorphSegment(objectUrl, file.name, duration),
    });
    onStatus(`Morph segment ready (${duration.toFixed(2)}s).`);
  } catch (err: unknown) {
    const message = formatMorphFailureMessage(err);
    onTransitionUpdate({
      ...transition,
      morphSegment: createFailedMorphSegment(
        transition.duration,
        message,
        transition.morphSegment,
      ),
    });
    onStatus(message);
  }
}
