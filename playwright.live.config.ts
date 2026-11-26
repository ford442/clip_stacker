import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Live smoke (`e2e/live.spec.ts`) against a deployed build: `LIVE_URL=https://… npm run e2e:live`.
 * Same Chromium / SwiftShader flags as the render harness; no local web server.
 */
const LIVE_URL = process.env.LIVE_URL;
// Checked when a run starts (not at import, so tooling can load the config).
const baseURL = LIVE_URL ? (LIVE_URL.endsWith('/') ? LIVE_URL : `${LIVE_URL}/`) : 'http://localhost:4173/';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: 'live.spec.ts',
  // A flake is a failure here: the acceptance bar is consecutive clean runs.
  retries: 0,
  webServer: undefined,
  use: { ...base.use, baseURL, acceptDownloads: true },
});
