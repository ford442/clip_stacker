import type { Clip } from '../types';
import { remappedClipDuration } from './timeRemap';

/**
 * A clip's length on the output timeline, in seconds: the trim window after
 * constant speed, `playbackRate` automation and loops.
 *
 * Lives outside the `project` barrel so timeline / render modules can import
 * it without depending on project load/save (which imports them back).
 */
export function getClipDuration(clip: Clip): number {
  return remappedClipDuration(clip);
}
