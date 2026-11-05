import { useState } from 'react';

/**
 * Return `next`, or the previous object when every own property is identical
 * (`Object.is`). Lets a composition root hand panels a bundle of callbacks
 * whose identity changes only when one of them does — the same re-render
 * behaviour as passing each callback as its own prop.
 */
export function useStableObject<T extends object>(next: T): T {
  const [stable, setStable] = useState(next);
  if (stable !== next && !shallowEqual(stable, next)) {
    // Derived state: React re-renders this component before committing.
    setStable(next);
    return next;
  }
  return stable;
}

export function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
