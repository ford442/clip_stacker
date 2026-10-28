import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGoogleDriveForTests,
  DRIVE_FILE_SCOPE,
  DRIVE_NOT_CONFIGURED_MESSAGE,
  driveItemFromPickerDoc,
  GAPI_SCRIPT_URL,
  getCachedDriveToken,
  getDriveAccessToken,
  GIS_SCRIPT_URL,
  loadScriptOnce,
  pickDriveFiles,
  readGoogleDriveConfig,
} from './googleDrive';

const CONFIG = { clientId: 'client-id', apiKey: 'api-key', appId: '12345' };

type GoogleWin = { google?: unknown; gapi?: unknown };
const w = () => window as unknown as GoogleWin;

/** Make injected <script> tags "load" (or fail) without touching the network. */
function interceptScripts(fail: string[] = []) {
  const loaded: string[] = [];
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const script = node as unknown as HTMLScriptElement;
    loaded.push(script.src);
    queueMicrotask(() => (fail.some((f) => script.src.includes(f)) ? script.onerror?.(new Event('error')) : script.onload?.(new Event('load'))));
    return node;
  });
  return loaded;
}

interface PickerSetup {
  tokenResponse?: Record<string, unknown>;
  tokenError?: { type?: string; message?: string };
  pickerAction?: string;
  docs?: unknown[];
}

function installGoogle(setup: PickerSetup = {}) {
  const calls = { scopes: [] as string[], pickerToken: '', view: {} as Record<string, unknown>, features: [] as unknown[], appId: '', key: '' };
  const tokenClient = {
    requestAccessToken: vi.fn(),
  };
  w().google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { scope: string; callback: (r: unknown) => void; error_callback: (e: unknown) => void }) => {
          calls.scopes.push(cfg.scope);
          tokenClient.requestAccessToken.mockImplementation(() => {
            if (setup.tokenError) cfg.error_callback(setup.tokenError);
            else cfg.callback(setup.tokenResponse ?? { access_token: 'tok-1', expires_in: 3600 });
          });
          return tokenClient;
        },
      },
    },
    picker: {
      ViewId: { DOCS: 'docs' },
      Feature: { MULTISELECT_ENABLED: 'multi' },
      Action: { PICKED: 'picked', CANCEL: 'cancel' },
      DocsView: class {
        setIncludeFolders(v: boolean) { calls.view.folders = v; return this; }
        setSelectFolderEnabled(v: boolean) { calls.view.selectFolder = v; return this; }
        setMimeTypes(v: string) { calls.view.mime = v; return this; }
      },
      PickerBuilder: class {
        private cb: (d: unknown) => void = () => {};
        addView() { return this; }
        enableFeature(f: unknown) { calls.features.push(f); return this; }
        setTitle() { return this; }
        setOAuthToken(t: string) { calls.pickerToken = t; return this; }
        setDeveloperKey(k: string) { calls.key = k; return this; }
        setAppId(a: string) { calls.appId = a; return this; }
        setCallback(cb: (d: unknown) => void) { this.cb = cb; return this; }
        build() {
          return { setVisible: () => this.cb({ action: setup.pickerAction ?? 'picked', docs: setup.docs ?? [] }) };
        }
      },
    },
  };
  w().gapi = { load: (_api: string, o: { callback: () => void }) => o.callback() };
  return { calls, tokenClient };
}

beforeEach(() => __resetGoogleDriveForTests());
afterEach(() => {
  vi.restoreAllMocks();
  delete w().google;
  delete w().gapi;
});

describe('readGoogleDriveConfig', () => {
  it('needs both a client id and an API key', () => {
    expect(readGoogleDriveConfig({})).toBeNull();
    expect(readGoogleDriveConfig({ VITE_GOOGLE_CLIENT_ID: 'c' })).toBeNull();
    expect(readGoogleDriveConfig({ VITE_GOOGLE_CLIENT_ID: ' c ', VITE_GOOGLE_API_KEY: 'k' })).toEqual({ clientId: 'c', apiKey: 'k' });
    expect(readGoogleDriveConfig({ VITE_GOOGLE_CLIENT_ID: 'c', VITE_GOOGLE_API_KEY: 'k', VITE_GOOGLE_APP_ID: '9' })).toEqual({
      clientId: 'c', apiKey: 'k', appId: '9',
    });
  });
});

describe('driveItemFromPickerDoc', () => {
  it('keeps only a reference: id, name, size and MIME type', () => {
    expect(driveItemFromPickerDoc({ id: 'f1', name: 'Big.mp4', mimeType: 'video/mp4', sizeBytes: '3221225472' })).toEqual({
      kind: 'drive', fileId: 'f1', name: 'Big.mp4', size: 3221225472, mimeType: 'video/mp4',
    });
  });

  it('records an unknown size as 0 and skips non-media or incomplete docs', () => {
    expect(driveItemFromPickerDoc({ id: 'f', name: 'a.wav', mimeType: 'audio/wav' })?.size).toBe(0);
    expect(driveItemFromPickerDoc({ id: 'f', name: 'doc', mimeType: 'application/pdf' })).toBeNull();
    expect(driveItemFromPickerDoc({ name: 'a.mp4', mimeType: 'video/mp4' })).toBeNull();
  });
});

describe('loadScriptOnce', () => {
  it('injects a script once and shares the promise', async () => {
    const loaded = interceptScripts();
    await Promise.all([loadScriptOnce(GIS_SCRIPT_URL), loadScriptOnce(GIS_SCRIPT_URL)]);
    expect(loaded).toEqual([GIS_SCRIPT_URL]);
  });

  it('forgets a failed load so a later click can retry', async () => {
    const failing = interceptScripts(['accounts.google.com']);
    await expect(loadScriptOnce(GIS_SCRIPT_URL)).rejects.toThrow('accounts.google.com');
    vi.restoreAllMocks();
    const loaded = interceptScripts();
    await loadScriptOnce(GIS_SCRIPT_URL);
    expect(failing).toHaveLength(1);
    expect(loaded).toEqual([GIS_SCRIPT_URL]);
  });
});

describe('getDriveAccessToken', () => {
  it('requests the least-privilege drive.file scope and caches the token in memory', async () => {
    interceptScripts();
    const { calls, tokenClient } = installGoogle();
    expect(getCachedDriveToken()).toBeNull();
    await expect(getDriveAccessToken(CONFIG)).resolves.toBe('tok-1');
    await expect(getDriveAccessToken(CONFIG)).resolves.toBe('tok-1');
    expect(calls.scopes).toEqual([DRIVE_FILE_SCOPE]);
    expect(tokenClient.requestAccessToken).toHaveBeenCalledTimes(1);
    expect(getCachedDriveToken()).toBe('tok-1');
    expect(JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage))).not.toContain('tok-1');
  });

  it('asks again once the token is within a minute of expiring', async () => {
    interceptScripts();
    installGoogle({ tokenResponse: { access_token: 'short', expires_in: 30 } });
    await getDriveAccessToken(CONFIG);
    expect(getCachedDriveToken()).toBeNull();
  });

  it('reports a closed popup and a denied grant in plain words', async () => {
    interceptScripts();
    installGoogle({ tokenError: { type: 'popup_closed' } });
    await expect(getDriveAccessToken(CONFIG)).rejects.toThrow('closed before it finished');
    installGoogle({ tokenResponse: { error: 'access_denied' } });
    await expect(getDriveAccessToken(CONFIG)).rejects.toThrow('access_denied');
  });

  it('explains missing configuration', async () => {
    await expect(getDriveAccessToken(null)).rejects.toThrow(DRIVE_NOT_CONFIGURED_MESSAGE);
  });
});

describe('pickDriveFiles', () => {
  it('opens a multi-select media picker with the token, key and app id and returns references', async () => {
    const loaded = interceptScripts();
    const { calls } = installGoogle({
      docs: [
        { id: 'a', name: 'one.mp4', mimeType: 'video/mp4', sizeBytes: 5_000_000_000 },
        { id: 'b', name: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      ],
    });
    const items = await pickDriveFiles(CONFIG);

    expect(items).toEqual([{ kind: 'drive', fileId: 'a', name: 'one.mp4', size: 5_000_000_000, mimeType: 'video/mp4' }]);
    expect(loaded).toEqual([GIS_SCRIPT_URL, GAPI_SCRIPT_URL]);
    expect(calls.pickerToken).toBe('tok-1');
    expect(calls.key).toBe('api-key');
    expect(calls.appId).toBe('12345');
    expect(calls.features).toEqual(['multi']);
    expect(String(calls.view.mime)).toContain('video/mp4');
    expect(calls.view.selectFolder).toBe(false);
  });

  it('resolves empty when the user cancels', async () => {
    interceptScripts();
    installGoogle({ pickerAction: 'cancel' });
    await expect(pickDriveFiles(CONFIG)).resolves.toEqual([]);
  });

  it('fails clearly without configuration', async () => {
    await expect(pickDriveFiles(null)).rejects.toThrow(DRIVE_NOT_CONFIGURED_MESSAGE);
  });
});
