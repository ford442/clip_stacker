import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_AUTH_CHANNEL, DRIVE_AUTH_TIMEOUT_MS } from './driveAuth';
import {
  __resetGoogleDriveForTests,
  DRIVE_NOT_CONFIGURED_MESSAGE,
  driveItemFromPickerDoc,
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

/** What the sign-in window sends after the editor opens it. */
function deliverOnOpen(messages: (state: string) => unknown[], options: { hang?: boolean } = {}) {
  const opened: string[] = [];
  const configs: unknown[] = [];
  vi.spyOn(window, 'open').mockImplementation((url?: string | URL) => {
    const href = String(url);
    opened.push(href);
    if (!options.hang) {
      const state = new URL(href).searchParams.get('state') ?? '';
      queueMicrotask(() => {
        const channel = new BroadcastChannel(DRIVE_AUTH_CHANNEL);
        channel.onmessage = (event: MessageEvent) => {
          if (event.data?.type === 'config' && event.data?.state === state) configs.push(event.data);
        };
        for (const message of messages(state)) channel.postMessage(message);
      });
    }
    return null;
  });
  return { opened, configs };
}

beforeEach(() => __resetGoogleDriveForTests());
afterEach(() => {
  vi.useRealTimers();
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
    const { opened } = deliverOnOpen((state) => [{ state, type: 'token', accessToken: 'tok-1', expiresIn: 3600 }]);
    expect(getCachedDriveToken()).toBeNull();
    await expect(getDriveAccessToken(CONFIG)).resolves.toBe('tok-1');
    await expect(getDriveAccessToken(CONFIG)).resolves.toBe('tok-1');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('drive-auth.html');
    expect(opened[0]).toContain('mode=token');
    expect(opened[0]).not.toContain('api-key');
    expect(opened[0]).not.toContain('client-id');
    expect(getCachedDriveToken()).toBe('tok-1');
    expect(JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage))).not.toContain('tok-1');
  });

  it('asks again once the token is within a minute of expiring', async () => {
    deliverOnOpen((state) => [{ state, type: 'token', accessToken: 'short', expiresIn: 30 }]);
    await getDriveAccessToken(CONFIG);
    expect(getCachedDriveToken()).toBeNull();
  });

  it('times out when the callback never arrives', async () => {
    vi.useFakeTimers();
    deliverOnOpen(() => [], { hang: true });
    const timedOut = getDriveAccessToken(CONFIG);
    const timeoutAssertion = expect(timedOut).rejects.toThrow('Google sign-in timed out');
    await vi.advanceTimersByTimeAsync(DRIVE_AUTH_TIMEOUT_MS);
    await timeoutAssertion;
  });

  it('reports a denied grant from the callback', async () => {
    deliverOnOpen((state) => [{ state, type: 'error', message: 'access_denied' }]);
    await expect(getDriveAccessToken(CONFIG)).rejects.toThrow('access_denied');
  });

  it('shares one sign-in window across overlapping requests', async () => {
    const { opened } = deliverOnOpen((state) => [{ state, type: 'token', accessToken: 'tok-1', expiresIn: 3600 }]);
    const [first, second] = await Promise.all([getDriveAccessToken(CONFIG), getDriveAccessToken(CONFIG)]);
    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(opened).toHaveLength(1);
  });

  it('explains missing configuration', async () => {
    await expect(getDriveAccessToken(null)).rejects.toThrow(DRIVE_NOT_CONFIGURED_MESSAGE);
  });
});

describe('pickDriveFiles', () => {
  it('takes media references from the sign-in window and keeps the api key off the url', async () => {
    const { opened, configs } = deliverOnOpen((state) => [
      { state, type: 'ready' },
      { state, type: 'token', accessToken: 'tok-1', expiresIn: 3600 },
      {
        state,
        type: 'picked',
        docs: [
          { id: 'a', name: 'one.mp4', mimeType: 'video/mp4', sizeBytes: 5_000_000_000, url: 'https://drive.example/a' },
          { id: 'b', name: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
        ],
      },
    ]);
    const items = await pickDriveFiles(CONFIG);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(items).toEqual([{ kind: 'drive', fileId: 'a', name: 'one.mp4', size: 5_000_000_000, mimeType: 'video/mp4' }]);
    expect(opened[0]).toContain('mode=pick');
    expect(opened[0]).not.toContain('api-key');
    expect(opened[0]).not.toContain('docs.google.com');
    expect(configs).toEqual([expect.objectContaining({ clientId: 'client-id', apiKey: 'api-key', appId: '12345' })]);
    expect(getCachedDriveToken()).toBe('tok-1');
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('tok-1');
  });

  it('resolves empty when the user cancels', async () => {
    deliverOnOpen((state) => [{ state, type: 'cancel' }]);
    await expect(pickDriveFiles(CONFIG)).resolves.toEqual([]);
  });

  it('fails clearly without configuration', async () => {
    await expect(pickDriveFiles(null)).rejects.toThrow(DRIVE_NOT_CONFIGURED_MESSAGE);
  });
});
