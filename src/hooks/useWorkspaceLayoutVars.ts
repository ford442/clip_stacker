import { useLayoutEffect, type RefObject } from 'react';
import { layoutStore, selectWorkspaceLayout, type LayoutState } from '../store/layoutStore';
import { workspaceShellAttributes } from '../utils/workspaceLayout';

/**
 * Mirror the workspace layout onto the shell element as CSS variables and
 * data attributes, straight from a store subscription.
 *
 * This is deliberately not React state: a splitter drag updates the store up
 * to once per frame, and routing that through a render would re-render every
 * panel (and the preview) under the shell. Only the grid re-lays out.
 */
export function useWorkspaceLayoutVars(ref: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (state: LayoutState) => {
      const { vars, data } = workspaceShellAttributes(selectWorkspaceLayout(state));
      for (const [name, value] of Object.entries(vars)) {
        if (value === null) el.style.removeProperty(name);
        else el.style.setProperty(name, value);
      }
      for (const [name, value] of Object.entries(data)) {
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
      }
    };
    apply(layoutStore.getState());
    return layoutStore.subscribe(apply);
  }, [ref]);
}
