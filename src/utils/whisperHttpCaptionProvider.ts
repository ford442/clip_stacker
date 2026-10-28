/**
 * `CaptionProvider` for a self-hosted transcription endpoint.
 *
 * The escape hatch for machines that cannot run `small`+ models in a tab: the
 * user points this at their own Whisper server (or a HuggingFace Space) and
 * the app POSTs the mixed timeline audio as a WAV.
 *
 * No credentials live here. Baking an API key into a static client would
 * publish it to every visitor, so the endpoint is expected to be one the user
 * controls — anything needing a secret belongs behind their own proxy.
 *
 * The response is read leniently because every server spells this differently;
 * OpenAI's `verbose_json` (`segments: [{ start, end, text }]`) and
 * whisper.cpp's server (`transcription: [{ offsets: { from, to }, text }]`)
 * both parse.
 */

import type { CaptionEntry } from '../types';
import type { CaptionProvider, CaptionTranscribeOptions } from './captionProvider';
import { segmentsToCaptions, type TranscriptSegment } from './captionSegments';
import { audioBufferToWav } from './clipAutomation';

export const WHISPER_HTTP_PROVIDER_ID = 'whisper-http';

let endpoint: string | null = null;

/** Point the provider at an endpoint. An empty value disables it. */
export function configureWhisperHttpProvider(url: string | null | undefined): void {
  const trimmed = (url ?? '').trim();
  endpoint = trimmed.length > 0 ? trimmed : null;
}

export function getWhisperHttpEndpoint(): string | null {
  return endpoint;
}

/** Only `https:` (and same-origin / blob) endpoints — the app's CSP allows no other. */
function isAllowedEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined);
    return parsed.protocol === 'https:' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pull `{ startSec, endSec, text }` out of whichever shape the server sent. */
export function parseTranscriptionResponse(payload: unknown): TranscriptSegment[] {
  const root = payload as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return [];

  const rows = (Array.isArray(root.segments)
    ? root.segments
    : Array.isArray(root.transcription)
      ? root.transcription
      : Array.isArray(root.chunks)
        ? root.chunks
        : []) as Record<string, unknown>[];

  const segments: TranscriptSegment[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const offsets = row.offsets as Record<string, unknown> | undefined;
    const timestamp = row.timestamp as unknown[] | undefined;

    const startSec =
      num(row.start) ??
      (offsets ? (num(offsets.from) ?? 0) / 1000 : null) ??
      (Array.isArray(timestamp) ? num(timestamp[0]) : null);
    const endSec =
      num(row.end) ??
      (offsets ? (num(offsets.to) ?? 0) / 1000 : null) ??
      (Array.isArray(timestamp) ? num(timestamp[1]) : null);
    const text = typeof row.text === 'string' ? row.text : '';
    if (startSec == null || endSec == null) continue;
    segments.push({ startSec, endSec, text });
  }
  return segments;
}

async function toWavBlob(audio: Blob | AudioBuffer): Promise<Blob> {
  if (audio instanceof Blob) return audio;
  return new Blob([audioBufferToWav(audio)], { type: 'audio/wav' });
}

export const whisperHttpCaptionProvider: CaptionProvider = {
  id: WHISPER_HTTP_PROVIDER_ID,
  label: 'Whisper (self-hosted endpoint)',

  async isAvailable(): Promise<boolean> {
    return endpoint != null && isAllowedEndpoint(endpoint);
  },

  async transcribe(
    audio: Blob | AudioBuffer,
    options?: CaptionTranscribeOptions,
  ): Promise<CaptionEntry[]> {
    if (!endpoint) throw new Error('No transcription endpoint is configured.');
    if (!isAllowedEndpoint(endpoint)) {
      throw new Error('The transcription endpoint must be an https:// URL.');
    }

    options?.onProgress?.({ progress: null, stage: 'Uploading audio for transcription…' });
    const form = new FormData();
    form.append('file', await toWavBlob(audio), 'timeline.wav');
    form.append('response_format', 'verbose_json');
    if (options?.language) form.append('language', options.language);

    const response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: options?.signal,
    });
    if (!response.ok) {
      throw new Error(`Transcription endpoint returned ${response.status} ${response.statusText}`);
    }

    options?.onProgress?.({ progress: null, stage: 'Reading transcription…' });
    const segments = parseTranscriptionResponse(await response.json());
    return segmentsToCaptions(segments, { timeOffsetSec: options?.timeOffsetSec });
  },
};
