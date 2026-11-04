/**
 * Google Drive sign-in protocol shared by the editor and `drive-auth.html`.
 *
 * The editor is cross-origin isolated (`COOP: same-origin` + COEP) so
 * SharedArrayBuffer and the multi-threaded FFmpeg core keep working. That
 * severs `window.opener` (it is null, and `window.open` returns null even
 * when the window did open), so neither the GIS token popup nor
 * `postMessage` to the opener can reach the editor. `drive-auth.html` is the
 * one response served with `COOP: unsafe-none` and without COEP, so the
 * token popup and the Drive Picker iframe can load there. Results come back
 * on a same-origin {@link BroadcastChannel}. The token is never written to
 * storage.
 *
 * Closing the Google popup is not a result. GIS fires `popup_closed` when
 * the window goes away, including the moment after a successful consent,
 * and the token callback can still arrive after that.
 */

export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Audio/video the Picker may offer. Anything else is dropped after selection. */
export const PICKER_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/mpeg',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
];
export const DRIVE_AUTH_CHANNEL = 'clip-stacker.drive-auth';
/** Safety net only. A dismissed popup is not itself a failure. */
export const DRIVE_AUTH_TIMEOUT_MS = 120_000;

/** App pages. Required for cross-origin isolation. */
export const APP_COOP = 'same-origin';
/** Sign-in document only. Lets the GIS popup post the token back. */
export const DRIVE_AUTH_COOP = 'unsafe-none';

export function isDriveAuthDocument(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return path === '/drive-auth.html' || path.endsWith('/drive-auth.html');
}

export type DriveAuthMode = 'token' | 'pick';

/** State and mode only. The API key travels on the channel, not in this URL. */
export function buildDriveAuthUrl(base: string, state: string, mode: DriveAuthMode): string {
  const url = new URL('drive-auth.html', base);
  url.searchParams.set('state', state);
  url.searchParams.set('mode', mode);
  return url.href;
}

export interface PickerDoc {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number | string;
}

export interface DriveAuthConfig {
  clientId: string;
  apiKey: string;
  appId?: string;
  /** Pick mode can skip a new consent when the editor still holds a token. */
  accessToken?: string;
}

export interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

export interface TokenClientError {
  type?: string;
  message?: string;
}

export type TokenSignal =
  | { kind: 'token'; accessToken: string; expiresIn: number }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' }
  | { kind: 'needs-gesture' };

const MAX_TOKEN_LIFETIME_SEC = 86_400;

function lifetimeSeconds(expiresIn: number | string | undefined): number {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return 3600;
  return Math.min(seconds, MAX_TOKEN_LIFETIME_SEC);
}

/** Official token callback. This is the only success path. */
export function signalFromTokenResponse(response: TokenResponse | null | undefined): TokenSignal {
  if (response?.error) {
    return { kind: 'error', message: response.error_description || response.error };
  }
  if (!response?.access_token) return { kind: 'error', message: 'No access token received' };
  return {
    kind: 'token',
    accessToken: response.access_token,
    expiresIn: lifetimeSeconds(response.expires_in),
  };
}

/**
 * Non-OAuth client errors. `popup_closed` is ignored: the popup can close
 * as soon as the user consents, and the token callback still follows.
 * `popup_failed_to_open` asks for another click instead of failing.
 */
export function signalFromTokenClientError(error: TokenClientError | null | undefined): TokenSignal {
  if (!error || error.type === 'popup_closed') return { kind: 'ignore' };
  if (error.type === 'popup_failed_to_open') return { kind: 'needs-gesture' };
  const detail = error.message?.trim();
  return { kind: 'error', message: detail ? `Google sign-in failed: ${detail}` : 'Google sign-in failed.' };
}

export type DriveAuthMessage =
  | { state: string; type: 'ready' }
  | { state: string; type: 'token'; accessToken: string; expiresIn: number }
  | { state: string; type: 'picked'; docs: PickerDoc[] }
  | { state: string; type: 'cancel' }
  | { state: string; type: 'error'; message: string };

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Editor → sign-in window. Ignored unless the state matches this request. */
export function parseDriveAuthConfig(data: unknown, state: string): DriveAuthConfig | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.type !== 'config' || message.state !== state) return null;
  const clientId = trimmed(message.clientId);
  const apiKey = trimmed(message.apiKey);
  if (!clientId || !apiKey) return null;
  const appId = trimmed(message.appId);
  const accessToken = typeof message.accessToken === 'string' && message.accessToken ? message.accessToken : undefined;
  return {
    clientId,
    apiKey,
    ...(appId ? { appId } : {}),
    ...(accessToken ? { accessToken } : {}),
  };
}

function pickerDocs(value: unknown): PickerDoc[] {
  if (!Array.isArray(value)) return [];
  const docs: PickerDoc[] = [];
  for (const entry of value.slice(0, 100)) {
    if (!entry || typeof entry !== 'object') continue;
    const doc = entry as Record<string, unknown>;
    const sizeBytes = typeof doc.sizeBytes === 'number' || typeof doc.sizeBytes === 'string' ? doc.sizeBytes : undefined;
    docs.push({
      ...(trimmed(doc.id) ? { id: trimmed(doc.id) } : {}),
      ...(trimmed(doc.name) ? { name: trimmed(doc.name) } : {}),
      ...(trimmed(doc.mimeType) ? { mimeType: trimmed(doc.mimeType) } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }
  return docs;
}

/** Sign-in window → editor. A closed popup is not a message. */
export function parseDriveAuthMessage(data: unknown, state: string): DriveAuthMessage | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.state !== state || typeof message.state !== 'string') return null;
  if (message.type === 'ready') return { state, type: 'ready' };
  if (message.type === 'cancel') return { state, type: 'cancel' };
  if (message.type === 'error') {
    const text = typeof message.message === 'string' ? message.message.trim() : '';
    return { state, type: 'error', message: text || 'Google sign-in failed.' };
  }
  if (message.type === 'token' && typeof message.accessToken === 'string' && message.accessToken) {
    return {
      state,
      type: 'token',
      accessToken: message.accessToken,
      expiresIn: lifetimeSeconds(typeof message.expiresIn === 'number' || typeof message.expiresIn === 'string' ? message.expiresIn : undefined),
    };
  }
  if (message.type === 'picked') return { state, type: 'picked', docs: pickerDocs(message.docs) };
  return null;
}
