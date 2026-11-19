/**
 * Identifies the renderer code this page runs: a content hash of the source,
 * WASM modules and fonts, set at build time by `vite.config.ts`. Render-cache
 * keys include it, so frames cached by a different build are never reused.
 * Tests (no Vite define) read `'dev'`.
 */

declare const __CLIP_STACKER_BUILD_ID__: string | undefined;

export const BUILD_ID: string =
  typeof __CLIP_STACKER_BUILD_ID__ === 'string' ? __CLIP_STACKER_BUILD_ID__ : 'dev';
