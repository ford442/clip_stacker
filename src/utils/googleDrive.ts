import type { DriveMediaItem } from '../types';

/**
 * Google Drive file picking: Google Identity Services (OAuth token) + the
 * Drive Picker. Only *references* come back — {@link DriveMediaItem} — the
 * media bytes are never fetched here.
 *
 * Scope is `drive.file`: the app can read only the files the user picks in the
 * Picker, which is also why the Contabo worker can download them with the same
 * token. Configure with `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY` and
 * (recommended, required for `drive.file` grants) `VITE_GOOGLE_APP_ID` — the
 * Cloud project number.
 */

export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Token lifetime is ~1h; renew a minute early so a job never starts with one about to lapse. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

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

// ---------------------------------------------------------------------------
// Minimal typings for the pieces of the Google globals this module touches.
// ---------------------------------------------------------------------------
interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface PickerDocument {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number | string;
}

interface PickerResponse {
  action?: string;
  docs?: PickerDocument[];
}

interface PickerBuilderApi {
  addView(view: unknown): PickerBuilderApi;
  enableFeature(feature: unknown): PickerBuilderApi;
  setOAuthToken(token: string): PickerBuilderApi;
  setDeveloperKey(key: string): PickerBuilderApi;
  setAppId(appId: string): PickerBuilderApi;
  setTitle(title: string): PickerBuilderApi;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilderApi;
  build(): { setVisible(visible: boolean): void };
}

interface DocsViewApi {
  setIncludeFolders(include: boolean): DocsViewApi;
  setMimeTypes(types: string): DocsViewApi;
  setSelectFolderEnabled(enabled: boolean): DocsViewApi;
}

interface GoogleGlobals {
  accounts?: {
    oauth2?: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }): TokenClient;
    };
  };
  picker?: {
    PickerBuilder: new () => PickerBuilderApi;
    DocsView: new (viewId?: unknown) => DocsViewApi;
    ViewId: { DOCS: unknown };
    Feature: { MULTISELECT_ENABLED: unknown };
    Action: { PICKED: string; CANCEL: string };
  };
}

interface GoogleWindow {
  google?: GoogleGlobals;
  gapi?: { load(api: string, options: { callback: () => void; onerror?: () => void }): void };
}

const win = () => window as unknown as GoogleWindow;

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
// files, so it is not written to storage; after a reload the next action asks
// Google again (usually silent once consent was given).
// ---------------------------------------------------------------------------
let cachedToken: { value: string; expiresAt: number } | null = null;

export function getCachedDriveToken(now = Date.now()): string | null {
  return cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now ? cachedToken.value : null;
}

export function clearDriveToken(): void {
  cachedToken = null;
}

async function requestAccessToken(config: GoogleDriveConfig): Promise<string> {
  await loadScriptOnce(GIS_SCRIPT_URL);
  const oauth2 = win().google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google sign-in did not load.');
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Google did not return an access token.'));
          return;
        }
        const seconds = Number(response.expires_in) || 3600;
        cachedToken = { value: response.access_token, expiresAt: Date.now() + seconds * 1000 };
        resolve(response.access_token);
      },
      error_callback: (error) => {
        reject(
          new Error(
            error.type === 'popup_closed'
              ? 'Google sign-in was closed before it finished.'
              : `Google sign-in failed${error.message ? `: ${error.message}` : '.'}`,
          ),
        );
      },
    });
    client.requestAccessToken();
  });
}

/** A valid Drive token: the cached one, or a fresh one (needs a user gesture if consent is due). */
export async function getDriveAccessToken(config = readGoogleDriveConfig()): Promise<string> {
  const cached = getCachedDriveToken();
  if (cached) return cached;
  if (!config) throw new Error(DRIVE_NOT_CONFIGURED_MESSAGE);
  return requestAccessToken(config);
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/** Library reference for a picked file, or null when it is not audio/video. */
export function driveItemFromPickerDoc(doc: PickerDocument): DriveMediaItem | null {
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

async function loadPicker(): Promise<NonNullable<GoogleGlobals['picker']>> {
  await loadScriptOnce(GAPI_SCRIPT_URL);
  const gapi = win().gapi;
  if (!gapi) throw new Error('Google API client did not load.');
  await new Promise<void>((resolve, reject) => {
    gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Picker failed to load.')) });
  });
  const picker = win().google?.picker;
  if (!picker) throw new Error('Google Picker failed to load.');
  return picker;
}

/**
 * Open the Drive Picker and resolve with references to the audio/video files
 * the user chose (empty when they cancel or pick nothing playable).
 */
export async function pickDriveFiles(
  config: GoogleDriveConfig | null = readGoogleDriveConfig(),
): Promise<DriveMediaItem[]> {
  if (!config) throw new Error(DRIVE_NOT_CONFIGURED_MESSAGE);
  const token = await getDriveAccessToken(config);
  const picker = await loadPicker();

  return new Promise<DriveMediaItem[]>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMimeTypes(PICKER_MIME_TYPES.join(','));
    let builder = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setTitle('Import from Google Drive')
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey);
    if (config.appId) builder = builder.setAppId(config.appId);
    builder
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve((data.docs ?? []).flatMap((doc) => driveItemFromPickerDoc(doc) ?? []));
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build()
      .setVisible(true);
  });
}

/** Test seam: forget loaded scripts and the cached token. */
export function __resetGoogleDriveForTests(): void {
  scriptLoads.clear();
  cachedToken = null;
}
