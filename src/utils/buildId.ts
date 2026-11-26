/**
 * Identifies the renderer code this page runs: a content hash of the source,
 * WASM modules and fonts, set at build time by `vite.config.ts`. Render-cache
 * keys include it, so frames cached by a different build are never reused.
 * Tests (no Vite define) read `'dev'`.
 */

declare const __CLIP_STACKER_BUILD_ID__: string | undefined;

export const BUILD_ID: string =
  typeof __CLIP_STACKER_BUILD_ID__ === 'string' ? __CLIP_STACKER_BUILD_ID__ : 'dev';

declare const __CLIP_STACKER_COMMIT_SHA__: string | undefined;

/**
 * The git commit the bundle was built from (`GITHUB_SHA` in CI, else
 * `git rev-parse HEAD`; `'unknown'` without git). Also written to
 * `<meta name="clip-stacker-commit">` so a deployed URL ties to its SHA.
 */
export const COMMIT_SHA: string =
  typeof __CLIP_STACKER_COMMIT_SHA__ === 'string' ? __CLIP_STACKER_COMMIT_SHA__ : 'unknown';
