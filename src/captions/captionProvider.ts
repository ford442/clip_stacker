/**
 * Auto-caption provider interface.
 *
 * Nothing in the app implements this yet — it exists so a speech-to-text
 * backend (Whisper compiled to WASM, or a cloud transcription endpoint) can be
 * dropped in later without the caption feature knowing anything about the
 * model. A provider takes audio and returns the same {@link CaptionEntry}
 * shape the timeline, `.srt` import and every export path already speak.
 *
 * Deliberately narrow: no model configuration, no streaming partials, no
 * speaker labels. Those belong to whichever adapter needs them, behind
 * `options`, rather than in a contract every provider must satisfy.
 */

import type { CaptionEntry } from '../types';

export interface CaptionProviderProgress {
  /** 0–1 when the provider can estimate it, otherwise `null`. */
  progress: number | null;
  /** Human-readable stage, shown in the app's status line. */
  stage: string;
}

export interface CaptionTranscribeOptions {
  /**
   * BCP-47 language hint (e.g. `'en'`). Providers that auto-detect may
   * ignore it; those that cannot should treat it as required.
   */
  language?: string;
  /**
   * Seconds to add to every returned cue, so a provider handed a slice of the
   * timeline can still return output-timeline times.
   */
  timeOffsetSec?: number;
  onProgress?: (event: CaptionProviderProgress) => void;
  /** Aborts a long transcription when the user cancels or edits. */
  signal?: AbortSignal;
}

export interface CaptionProvider {
  /** Stable id used to select a provider (e.g. `'whisper-wasm'`). */
  id: string;
  /** Human label for the provider picker. */
  label: string;
  /**
   * Whether this provider can run right now — WASM module present, network
   * reachable, credentials configured. Checked before it is offered.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Transcribe audio into caption cues, ordered by start time. Times are
   * seconds from the start of `audio`, plus `options.timeOffsetSec`.
   */
  transcribe(
    audio: Blob | AudioBuffer,
    options?: CaptionTranscribeOptions,
  ): Promise<CaptionEntry[]>;
}

/** Providers registered at runtime, keyed by {@link CaptionProvider.id}. */
const providers = new Map<string, CaptionProvider>();

export function registerCaptionProvider(provider: CaptionProvider): void {
  providers.set(provider.id, provider);
}

export function getCaptionProvider(id: string): CaptionProvider | undefined {
  return providers.get(id);
}

/** Every registered provider, in registration order. */
export function listCaptionProviders(): CaptionProvider[] {
  return [...providers.values()];
}

/** Registered providers that report themselves as usable right now. */
export async function listAvailableCaptionProviders(): Promise<CaptionProvider[]> {
  const results = await Promise.all(
    listCaptionProviders().map(async (provider) => {
      try {
        return (await provider.isAvailable()) ? provider : null;
      } catch {
        // A provider that throws while probing is simply not available.
        return null;
      }
    }),
  );
  return results.filter((p): p is CaptionProvider => p !== null);
}

/** Test-only reset so specs do not leak providers between cases. */
export function __resetCaptionProvidersForTests(): void {
  providers.clear();
}
