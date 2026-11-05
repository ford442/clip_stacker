/**
 * Hooks the composition root hands to the `?test_harness` API
 * (`testHarness/harness.ts`). Empty on a normal load.
 */
export const harnessBindings: {
  performRender: (() => Promise<void>) | null;
  /** Make `App` throw on its next render, so `RootErrorBoundary` takes over. */
  crash: ((error: Error) => void) | null;
} = {
  performRender: null,
  crash: null,
};

/** True when the page was opened with `?test_harness`. */
export function testHarnessRequested(search: string = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).has('test_harness');
}
