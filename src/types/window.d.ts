/**
 * `window.clipStacker`: the page's scripting surface. Each module that hangs
 * an API off it adds its key to `ClipStackerGlobal` with its own
 * `declare global` block (`finishing` in actions/finishingPresetApi.ts,
 * `test` in app/testHarness/harness.ts), so no layer has to import the type
 * of a layer above it.
 */
declare global {
  interface ClipStackerGlobal {
    [key: string]: unknown;
  }

  interface Window {
    clipStacker?: ClipStackerGlobal;
  }
}

export {};
