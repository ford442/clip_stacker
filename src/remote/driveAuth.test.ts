import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_COOP,
  buildDriveAuthUrl,
  DRIVE_AUTH_COOP,
  DRIVE_FILE_SCOPE,
  GAPI_SCRIPT_URL,
  isDriveAuthDocument,
  parseDriveAuthMessage,
  signalFromTokenClientError,
  signalFromTokenResponse,
} from './driveAuth';
import { openGooglePicker, startDriveAuthPopup, type PickerRequest, type TokenHandlers } from './driveAuthPopup';

describe('drive auth signals', () => {
  it('treats the token callback as the only success', () => {
    expect(signalFromTokenResponse({ access_token: 'tok', expires_in: '120' })).toEqual({
      kind: 'token',
      accessToken: 'tok',
      expiresIn: 120,
    });
    expect(signalFromTokenResponse({ error: 'access_denied' })).toEqual({ kind: 'error', message: 'access_denied' });
    expect(signalFromTokenResponse({})).toEqual({ kind: 'error', message: 'No access token received' });
    expect(signalFromTokenResponse({ access_token: 'tok', expires_in: 9_000_000 })).toEqual({
      kind: 'token',
      accessToken: 'tok',
      expiresIn: 86_400,
    });
  });

  it('ignores a closed popup and asks for a click when the window was blocked', () => {
    expect(signalFromTokenClientError({ type: 'popup_closed' })).toEqual({ kind: 'ignore' });
    expect(signalFromTokenClientError(undefined)).toEqual({ kind: 'ignore' });
    expect(signalFromTokenClientError({ type: 'popup_failed_to_open' })).toEqual({ kind: 'needs-gesture' });
    expect(signalFromTokenClientError({ type: 'unknown', message: 'blocked' })).toEqual({
      kind: 'error',
      message: 'Google sign-in failed: blocked',
    });
  });

  it('builds a same-directory sign-in url and ignores other requests', () => {
    const href = buildDriveAuthUrl('https://example.com/clip-stacker/', 'state-1', 'pick');
    expect(href).toBe('https://example.com/clip-stacker/drive-auth.html?state=state-1&mode=pick');
    expect(parseDriveAuthMessage({ state: 'other', type: 'token', accessToken: 'x', expiresIn: 10 }, 'state-1')).toBeNull();
    expect(parseDriveAuthMessage({ state: 'state-1', type: 'picked', docs: [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4', url: 'https://evil.example' }] }, 'state-1')).toEqual({
      state: 'state-1',
      type: 'picked',
      docs: [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4' }],
    });
  });

  it('keeps isolation on the app and opts the sign-in document out of COOP and COEP', () => {
    expect(isDriveAuthDocument('/drive-auth.html?state=c')).toBe(true);
    expect(isDriveAuthDocument('/clip-stacker/drive-auth.html')).toBe(true);
    expect(isDriveAuthDocument('/drive-auth.html.evil')).toBe(false);
    expect(isDriveAuthDocument('/')).toBe(false);
    const htaccess = readFileSync('public/.htaccess', 'utf8');
    const files = /<Files "drive-auth\.html">([\s\S]*?)<\/Files>/.exec(htaccess);
    expect(files).not.toBeNull();
    expect(files![1]).toContain(`Cross-Origin-Opener-Policy "${DRIVE_AUTH_COOP}"`);
    expect(files![1]).toContain('Header always unset Cross-Origin-Embedder-Policy');
    expect(htaccess).toContain(`Cross-Origin-Opener-Policy "${APP_COOP}"`);
    expect(htaccess).toContain('Cross-Origin-Embedder-Policy "require-corp"');
  });
});

describe('startDriveAuthPopup', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.useRealTimers();
  });

  function start(
    search: string,
    requestToken: (clientId: string, handlers: TokenHandlers) => void,
    showPicker?: (request: PickerRequest) => void,
  ) {
    const posted: unknown[] = [];
    const statuses: string[] = [];
    let retry: (() => void) | undefined;
    const stop = startDriveAuthPopup({
      search,
      post: (message) => posted.push(message),
      readConfig: async () => ({ clientId: 'client', apiKey: 'key', appId: '9' }),
      requestToken,
      showPicker,
      setStatus: (text) => statuses.push(text),
      onNeedsGesture: (again) => {
        retry = again;
      },
      timeoutMs: 120_000,
    });
    stops.push(stop);
    return { posted, statuses, retry: () => retry };
  }

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  const query = '?state=s1&mode=token';

  it('sends the token when the popup closes and the callback arrives afterwards', async () => {
    const { posted } = start(query, (_clientId, handlers) => {
      handlers.error({ type: 'popup_closed' });
      handlers.callback({ access_token: 'tok-1', expires_in: 3600 });
    });
    await flush();
    expect(posted).toEqual([
      { state: 's1', type: 'ready' },
      { state: 's1', type: 'token', accessToken: 'tok-1', expiresIn: 3600 },
    ]);
  });

  it('does not fail when the popup closes; only the safety timeout does', async () => {
    vi.useFakeTimers();
    const { posted } = start(query, (_clientId, handlers) => {
      handlers.error({ type: 'popup_closed' });
    });
    await flush();
    expect(posted).toEqual([{ state: 's1', type: 'ready' }]);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(posted).toEqual([{ state: 's1', type: 'ready' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posted.at(-1)).toEqual({ state: 's1', type: 'error', message: 'Google sign-in timed out' });
  });

  it('reports a denied grant from the callback', async () => {
    const denied = start(query, (_clientId, handlers) => {
      handlers.callback({ error: 'access_denied', error_description: 'access_denied' });
    });
    await flush();
    expect(denied.posted.at(-1)).toEqual({ state: 's1', type: 'error', message: 'access_denied' });
  });

  it('retries after a blocked window and then accepts the token', async () => {
    let attempt = 0;
    const { posted, retry } = start(query, (_clientId, handlers) => {
      attempt += 1;
      if (attempt === 1) handlers.error({ type: 'popup_failed_to_open' });
      else handlers.callback({ access_token: 'tok-2', expires_in: 3600 });
    });
    await flush();
    expect(posted).toEqual([{ state: 's1', type: 'ready' }]);
    retry()?.();
    expect(posted.at(-1)).toEqual({ state: 's1', type: 'token', accessToken: 'tok-2', expiresIn: 3600 });
  });

  it('shows the picker after the token and does not ask again when a token was supplied', async () => {
    const picked: PickerRequest[] = [];
    const withConsent = start('?state=s1&mode=pick', (_clientId, handlers) => {
      handlers.callback({ access_token: 'tok-1', expires_in: 3600 });
    }, (request) => {
      picked.push(request);
      request.onResult('picked', [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 3 }]);
    });
    await flush();
    expect(picked).toHaveLength(1);
    expect(picked[0].accessToken).toBe('tok-1');
    expect(picked[0].apiKey).toBe('key');
    expect(picked[0].mimeTypes).toContain('video/mp4');
    expect(picked[0].mimeTypes).toContain('audio/mpeg');
    expect(withConsent.posted.at(-1)).toEqual({
      state: 's1',
      type: 'picked',
      docs: [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 3 }],
    });
  });

  it('skips sign-in when the editor already holds a token', async () => {
    const shown: string[] = [];
    const posted: unknown[] = [];
    startDriveAuthPopup({
      search: '?state=s2&mode=pick',
      post: (message) => posted.push(message),
      readConfig: async () => ({ clientId: 'client', apiKey: 'key', accessToken: 'cached' }),
      requestToken: () => {
        throw new Error('should reuse the supplied token');
      },
      showPicker: (request) => {
        shown.push(request.accessToken);
        request.onResult('cancel', []);
      },
    });
    await flush();
    expect(shown).toEqual(['cached']);
    expect(posted.at(-1)).toEqual({ state: 's2', type: 'cancel' });
  });

  it('rejects a window that is not a token or picker request', () => {
    const { posted } = start('?state=s1&mode=everything', () => {
      throw new Error('should not request a token');
    });
    expect(posted).toEqual([
      { state: 's1', type: 'error', message: 'This sign-in window was opened without a request from Clip Stacker.' },
    ]);
  });
});

describe('openGooglePicker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { google?: unknown }).google;
    delete (window as unknown as { gapi?: unknown }).gapi;
  });

  it('builds a multiselect media picker with the token, key and app id', async () => {
    const calls = { token: '', key: '', appId: '', mime: '', features: [] as unknown[], selectFolder: true };
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      const script = node as unknown as HTMLScriptElement;
      expect(script.src).toBe(GAPI_SCRIPT_URL);
      queueMicrotask(() => script.onload?.(new Event('load')));
      return node;
    });
    (window as unknown as { gapi: unknown }).gapi = {
      load: (_api: string, options: { callback: () => void }) => options.callback(),
    };
    (window as unknown as { google: unknown }).google = {
      picker: {
        ViewId: { DOCS: 'docs' },
        Feature: { MULTISELECT_ENABLED: 'multi' },
        Action: { PICKED: 'picked', CANCEL: 'cancel' },
        DocsView: class {
          setIncludeFolders() { return this; }
          setSelectFolderEnabled(value: boolean) { calls.selectFolder = value; return this; }
          setMimeTypes(value: string) { calls.mime = value; return this; }
        },
        PickerBuilder: class {
          private cb: (data: { action?: string; docs?: unknown[] }) => void = () => {};
          addView() { return this; }
          enableFeature(feature: unknown) { calls.features.push(feature); return this; }
          setTitle() { return this; }
          setOAuthToken(token: string) { calls.token = token; return this; }
          setDeveloperKey(key: string) { calls.key = key; return this; }
          setAppId(appId: string) { calls.appId = appId; return this; }
          setCallback(cb: (data: { action?: string; docs?: unknown[] }) => void) { this.cb = cb; return this; }
          build() {
            return { setVisible: () => this.cb({ action: 'picked', docs: [{ id: 'a', name: 'a.mp4', mimeType: 'video/mp4' }] }) };
          }
        },
      },
    };

    let action = '';
    await openGooglePicker({
      accessToken: 'tok',
      apiKey: 'key',
      appId: '9',
      mimeTypes: 'video/mp4,audio/mpeg',
      onResult: (next) => { action = next; },
    });
    expect(action).toBe('picked');
    expect(calls).toMatchObject({ token: 'tok', key: 'key', appId: '9', selectFolder: false, features: ['multi'] });
    expect(calls.mime).toContain('video/mp4');
    expect(DRIVE_FILE_SCOPE).toContain('drive.file');
  });
});
