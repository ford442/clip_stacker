import type { ClipTransition } from "../types";

/**
 * After swapping two adjacent clips at indices i and j (j = i+1),
 * transitions are positional and stay at their slots — no remapping needed.
 * Users can adjust transition types after reordering via the TransitionEditor.
 */
export function reindexAfterSwap(
  transitions: ClipTransition[],
  _i: number,
  _j: number,
): ClipTransition[] {
  return transitions;
}
