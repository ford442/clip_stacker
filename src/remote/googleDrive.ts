import type { DriveMediaItem } from '../types';
import {
  buildDriveAuthUrl,
  DRIVE_AUTH_CHANNEL,
  DRIVE_AUTH_TIMEOUT_MS,
  DRIVE_FILE_SCOPE,
  GAPI_SCRIPT_URL,
  GIS_SCRIPT_URL,
  parseDriveAuthMessage,
  type DriveAuthMode,
  type PickerDoc,
} from './driveAuth';

/**
 * Google Drive file picking. Only *references* come back — {@link DriveMediaItem}
 * — the media bytes are never fetched here.
 *
 * Scope is `drive.file`: the app can read only the files the user picks in the
 * Picker, which is also why the Contabo worker can download them with the same
 * token. Configure with `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY` and
 * (recommended, required for `drive.file` grants) `VITE_GOOGLE_APP_ID` — the
 * Cloud project number.
 *
 * The token client and the Picker both run in `drive-auth.html`. This page is
 * cross-origin isolated, so it cannot host the Picker iframe or receive
 * `window.opener` messages. The sign-in window reports back on a
 * BroadcastChannel. A closed popup is not a failure; see `driveAuth.ts`.
 */

export { DRIVE_FILE_SCOPE, GAPI_SCRIPT_URL, GIS_SCRIPT_URL };

/** Token lifetime is ~1h; renew a minute early so a job never starts with one about to lapse. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface GoogleDriveConfig {
  clientId: string;
  apiKey: string;
  appId?: string;
}

export const DRIVE_NOT_CONFIGURED_MESSAGE =
  'Google Drive import is not configured. Set VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY (and VITE_GOOGLE_APP_ID) when building.';

export function readGoogleDriveConfig(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): GoogleDriveConfig | null {
  const clientId = env.VITE_GOOGLE_CLIENT_ID?.trim();
  const apiKey = env.VITE_GOOGLE_API_KEY?.trim();
  if (!clientId || !apiKey) return null;
  const appId = env.VITE_GOOGLE_APP_ID?.trim();
  return { clientId, apiKey, ...(appId ? { appId } : {}) };
}

const scriptLoads = new Map<string, Promise<void>>();

/** Inject a script once; a failed load is forgotten so the next click can retry. */
export function loadScriptOnce(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoads.delete(src);
      script.remove();
      reject(new Error(`Could not load ${new URL(src).host}. Check your connection or content blockers.`));
    };
    document.head.appendChild(script);
  });
  scriptLoads.set(src, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Access token — memory only. It is a bearer credential for the user's Drive
// files, so it is not written to storage; after a reload the next action opens
// the sign-in window again. Google skips the account chooser when consent
// is still on file.
// ---------------------------------------------------------------------------
let cachedToken: { value: string; expiresAt: number } | null = null;
let stopPending: (() => void) | null = null;
let gate: Promise<void> = Promise.resolve();
let tokenInflight: Promise<string> | null = null;
let pickInflight: Promise<DriveMediaItem[]> | null = null;

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = gate.then(run, run);
  gate = result.then(() => undefined, () => undefined);
  return result;
}

function rememberToken(token: string, expiresIn: number): void {
  const seconds = expiresIn > 0 ? expiresIn : 3600;
  cachedToken = { value: token, expiresAt: Date.now() + seconds * 1000 };
}

export function getCachedDriveToken(now = Date.now()): string | null {
  return cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now ? cachedToken.value : null;
}

export function clearDriveToken(): void {
  cachedToken = null;
}

function openDriveWindow(config: GoogleDriveConfig, mode: 'token'): Promise<string>;
function openDriveWindow(config: GoogleDriveConfig, mode: 'pick'): Promise<DriveMediaItem[]>;
function openDriveWindow(config: GoogleDriveConfig, mode: DriveAuthMode): Promise<string | DriveMediaItem[]> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.reject(new Error('Google sign-in needs BroadcastChannel in this browser.'));
  }

  const state = globalThis.crypto.randomUUID();
  const channel = new BroadcastChannel(DRIVE_AUTH_CHANNEL);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMessage = mode === 'pick' ? 'Drive picker timed out' : 'Google sign-in timed out';

  const promise = new Promise<string | DriveMediaItem[]>((resolve, reject) => {
    const finish = (err: Error | null, value?: string | DriveMediaItem[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.onmessage = null;
      channel.close();
      stopPending = null;
      if (err) reject(err);
      else resolve(value ?? (mode === 'pick' ? [] : ''));
    };

    stopPending = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.onmessage = null;
      channel.close();
    };

    // Callback and picker results are the only success paths. Do not watch
    // popup.closed: COOP makes the handle null, and a real popup also closes
    // the moment the result is on its way.
    channel.onmessage = (event: MessageEvent) => {
      const message = parseDriveAuthMessage(event.data, state);
      if (!message) return;
      if (message.type === 'ready') {
        const accessToken = mode === 'pick' ? getCachedDriveToken() : null;
        channel.postMessage({
          state,
          type: 'config',
          clientId: config.clientId,
          apiKey: config.apiKey,
          ...(config.appId ? { appId: config.appId } : {}),
          ...(accessToken ? { accessToken } : {}),
        });
        return;
      }
      if (message.type === 'error') {
        finish(new Error(message.message));
        return;
      }
      if (message.type === 'token') {
        rememberToken(message.accessToken, message.expiresIn);
        if (mode === 'token') finish(null, message.accessToken);
        return;
      }
      if (mode === 'pick' && message.type === 'picked') {
        finish(null, message.docs.flatMap((doc: PickerDoc) => driveItemFromPickerDoc(doc) ?? []));
        return;
      }
      if (mode === 'pick' && message.type === 'cancel') finish(null, []);
    };

    timer = setTimeout(() => finish(new Error(timeoutMessage)), DRIVE_AUTH_TIMEOUT_MS);

    try {
      window.open(
        buildDriveAuthUrl(document.baseURI, state, mode),
        'clip-stacker-drive-auth',
        'popup,width=960,height=700',
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return promise;
}

/** A valid Drive token: the cached one, or a fresh one from the sign-in window. */
export function getDriveAccessToken(config = readGoogleDriveConfig()): Promise<string> {
  const cached = getCachedDriveToken();
  if (cached) return Promise.resolve(cached);
  if (!config) return Promise.reject(new Error(DRIVE_NOT_CONFIGURED_MESSAGE));
  if (tokenInflight) return tokenInflight;
  const pending = exclusive(async () => {
    const again = getCachedDriveToken();
    if (again) return again;
    return openDriveWindow(config, 'token');
  });
  const wrapped = pending.finally(() => {
    if (tokenInflight === wrapped) tokenInflight = null;
  });
  tokenInflight = wrapped;
  return wrapped;
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/** Library reference for a picked file, or null when it is not audio/video. */
export function driveItemFromPickerDoc(doc: PickerDoc): DriveMediaItem | null {
  const mimeType = doc.mimeType ?? '';
  if (!doc.id || !doc.name || !/^(video|audio)\//.test(mimeType)) return null;
  const size = Number(doc.sizeBytes);
  return {
    kind: 'drive',
    fileId: doc.id,
    name: doc.name,
    // 0 = Drive did not say; routing treats unknown as large.
    size: Number.isFinite(size) && size > 0 ? size : 0,
    mimeType,
  };
}

/**
 * Open the Drive Picker in the sign-in window and resolve with references to
 * the audio/video files the user chose (empty when they cancel or pick
 * nothing playable). The editor never embeds the Picker.
 */
export function pickDriveFiles(
  config: GoogleDriveConfig | null = readGoogleDriveConfig(),
): Promise<DriveMediaItem[]> {
  if (!config) return Promise.reject(new Error(DRIVE_NOT_CONFIGURED_MESSAGE));
  if (pickInflight) return pickInflight;
  const pending = exclusive(() => openDriveWindow(config, 'pick'));
  const wrapped = pending.finally(() => {
    if (pickInflight === wrapped) pickInflight = null;
  });
  pickInflight = wrapped;
  return wrapped;
}

/** Test seam: forget loaded scripts, the cached token, and an in-flight sign-in. */
export function __resetGoogleDriveForTests(): void {
  scriptLoads.clear();
  cachedToken = null;
  stopPending?.();
  stopPending = null;
  tokenInflight = null;
  pickInflight = null;
  gate = Promise.resolve();
}
