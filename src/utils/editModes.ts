import {
  fail,
  type EditResult,
  type EditState,
  type RippleOptions,
  type TimelineEditTool,
} from './editModeCore';
import { rippleTrim, rollEdit, slideClip, slipClip } from './trimEdits';

/**
 * NLE edit modes (#168 follow-up): overwrite, insert, ripple, roll, slip, slide.
 *
 * Every operation here is pure — it takes the three editable slices (`tracks`,
 * the clip pool and the base-lane transitions) and returns new ones, or a
 * human-readable reason the edit was refused. The store commits a successful
 * result in one step behind a single `pushHistory`, so one undo restores both
 * lane placements and clip trims.
 *
 * Conventions:
 *
 * - A `Clip` *is* a media placement: its trim window says which part of the
 *   source plays. Edits that split an item duplicate the placement (new clip
 *   id, same `File` / object URL) and edits that cover an item drop the
 *   placement — source files are never touched.
 * - Deltas are **output-timeline seconds**. They are converted to source time
 *   with the clip's constant playback rate; speed-ramped or looped clips are
 *   refused rather than trimmed approximately.
 * - Ripple is **lane-local** by default. `linked: true` also shifts every other
 *   lane (sync-lock), and a locked lane that would have to move blocks the edit.
 * - The base video lane (the first video track) is a gapless edit list whose
 *   output positions come from transition-aware segment math. After any edit
 *   touching it, its `TrackItem.startTime`s are rewritten from
 *   `buildClipTimelineSegments` so placements and segment math never disagree,
 *   and its xfade transitions are re-keyed to the clip pairs they joined.
 *
 * Layout: shared state and base-lane maths in `editModeCore.ts`, roll / slip /
 * slide / ripple in `trimEdits.ts`, overwrite / insert / duplicate in
 * `dropEdits.ts`. This module re-exports them.
 */

export type {
  DropEditMode,
  EditResult,
  EditState,
  RippleOptions,
  TimelineEditTool,
} from './editModeCore';
export {
  baseLaneOrder,
  isBaseLane,
  normalizeBaseLane,
  remapBaseTransitions,
  shiftClipTrim,
} from './editModeCore';
export { rippleDelete, rippleTrim, rollEdit, slideClip, slipClip } from './trimEdits';
export { dropEdit, duplicateItem, insertEdit, overwriteEdit } from './dropEdits';

/**
 * Apply the sticky tool to the selected clip for a keyboard nudge of `delta`
 * output seconds. `select` has no nudge behaviour.
 */
export function nudgeWithTool(
  state: EditState,
  tool: TimelineEditTool,
  clipId: string,
  delta: number,
  options: RippleOptions = {},
): EditResult {
  switch (tool) {
    case 'ripple':
      return rippleTrim(state, clipId, 'out', delta, options);
    case 'roll':
      return rollEdit(state, clipId, delta);
    case 'slip':
      return slipClip(state, clipId, delta);
    case 'slide':
      return slideClip(state, clipId, delta);
    default:
      return fail('Pick the Ripple, Roll, Slip or Slide tool to nudge an edit.');
  }
}
