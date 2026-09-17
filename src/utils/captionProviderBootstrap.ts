/**
 * Registers the auto-caption providers the app ships with.
 *
 * Registration is deliberately separate from `captionProvider.ts` (the
 * registry) so tests can register mocks after
 * `__resetCaptionProvidersForTests()` without the real Whisper adapters
 * sneaking back in, and so a provider module is only pulled into the bundle
 * from here.
 */

import { registerCaptionProvider } from './captionProvider';
import { settingsStore } from '../store/settingsStore';
import {
  configureWhisperHttpProvider,
  whisperHttpCaptionProvider,
} from './whisperHttpCaptionProvider';
import {
  configureWhisperProvider,
  whisperCaptionProvider,
} from '../wasm/whisperCaptionProvider';

let registered = false;

export interface CaptionProviderBootstrapOptions {
  /** Overrides the default `public/models/…` weights location. */
  whisperModelUrl?: string;
  /** Self-hosted transcription endpoint; omitted / empty leaves it disabled. */
  httpEndpoint?: string | null;
}

/** Idempotent: safe under React StrictMode's double-invoked effects. */
export function registerBuiltInCaptionProviders(
  options: CaptionProviderBootstrapOptions = {},
): void {
  if (options.whisperModelUrl) {
    configureWhisperProvider({ modelUrl: options.whisperModelUrl });
  }
  configureWhisperHttpProvider(options.httpEndpoint ?? null);
  if (registered) return;
  registered = true;
  registerCaptionProvider(whisperCaptionProvider);
  registerCaptionProvider(whisperHttpCaptionProvider);
}

/**
 * Register the providers and keep the `whisper-http` endpoint in sync with the
 * setting the user typed. Returns the store unsubscribe.
 */
export function initCaptionProviders(): () => void {
  const read = () => settingsStore.getState().autoCaptionEndpoint;
  registerBuiltInCaptionProviders({ httpEndpoint: read() });
  return settingsStore.subscribe((state, prev) => {
    if (state.autoCaptionEndpoint !== prev.autoCaptionEndpoint) {
      configureWhisperHttpProvider(state.autoCaptionEndpoint);
    }
  });
}

export function __resetCaptionProviderBootstrapForTests(): void {
  registered = false;
}
