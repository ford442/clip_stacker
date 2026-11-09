/**
 * Boot script for `drive-auth.html`. This document is not cross-origin
 * isolated, so it can run the GIS token client and the Drive Picker. The
 * editor only hears BroadcastChannel messages. A closed popup does not settle
 * the request; the token callback is the only sign-in success path.
 */
import {
  DRIVE_AUTH_CHANNEL,
  DRIVE_AUTH_TIMEOUT_MS,
  DRIVE_FILE_SCOPE,
  GAPI_SCRIPT_URL,
  GIS_SCRIPT_URL,
  PICKER_MIME_TYPES,
  parseDriveAuthConfig,
  signalFromTokenClientError,
  signalFromTokenResponse,
  type DriveAuthConfig,
  type DriveAuthMessage,
  type DriveAuthMode,
  type PickerDoc,
  type TokenClientError,
  type TokenResponse,
} from './driveAuth';

export interface TokenHandlers {
  callback: (response: TokenResponse) => void;
  error: (error: TokenClientError) => void;
}

export interface PickerRequest {
  accessToken: string;
  apiKey: string;
  appId?: string;
  mimeTypes: string;
  onResult: (action: 'picked' | 'cancel', docs: PickerDoc[]) => void;
}

export interface DriveAuthPopupHooks {
  search: string;
  post: (message: DriveAuthMessage) => void;
  readConfig: () => Promise<DriveAuthConfig>;
  requestToken: (clientId: string, handlers: TokenHandlers) => void | Promise<void>;
  showPicker?: (request: PickerRequest) => void | Promise<void>;
  setStatus?: (text: string) => void;
  /** Shown when the browser blocks the Google window, so a click can retry. */
  onNeedsGesture?: (retry: () => void) => void;
  closeWindow?: () => void;
  timeoutMs?: number;
}

/** Start one sign-in or picker session. The cancel stops the timeout without posting. */
export function startDriveAuthPopup(hooks: DriveAuthPopupHooks): () => void {
  const params = new URLSearchParams(hooks.search);
  const state = params.get('state')?.trim() ?? '';
  const mode = params.get('mode')?.trim() ?? '';
  let settled = false;
  let gestureOffered = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMessage = mode === 'pick' ? 'Drive picker timed out' : 'Google sign-in timed out';

  const timeout = setTimeout(() => {
    settle({ state, type: 'error', message: timeoutMessage }, timeoutMessage);
  }, hooks.timeoutMs ?? DRIVE_AUTH_TIMEOUT_MS);

  function settle(message: DriveAuthMessage, status: string): void {
    if (settled || !state) return;
    settled = true;
    clearTimeout(timeout);
    hooks.setStatus?.(status);
    hooks.post(message);
    closeTimer = setTimeout(() => hooks.closeWindow?.(), 50);
  }

  function fail(message: string): void {
    if (!state) {
      settled = true;
      clearTimeout(timeout);
      hooks.setStatus?.(message);
      return;
    }
    settle({ state, type: 'error', message }, message);
  }

  function dispose(): void {
    clearTimeout(timeout);
    clearTimeout(closeTimer);
    settled = true;
  }

  if (!state) {
    fail('This sign-in window was opened without a request from Clip Stacker.');
    return dispose;
  }
  if (mode !== 'token' && mode !== 'pick') {
    fail('This sign-in window was opened without a request from Clip Stacker.');
    return dispose;
  }

  hooks.post({ state, type: 'ready' });
  void run(mode).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
  return dispose;

  async function run(session: DriveAuthMode): Promise<void> {
    const config = await hooks.readConfig();
    if (settled) return;
    if (!config.clientId || !config.apiKey) {
      fail('Google Drive import is not configured.');
      return;
    }

    const openPicker = (accessToken: string) => {
      if (!hooks.showPicker) {
        fail('Google Picker failed to load.');
        return;
      }
      hooks.setStatus?.('Select a file…');
      void Promise.resolve(hooks.showPicker({
        accessToken,
        apiKey: config.apiKey,
        ...(config.appId ? { appId: config.appId } : {}),
        mimeTypes: PICKER_MIME_TYPES.join(','),
        onResult: (action, docs) => {
          if (action === 'cancel') settle({ state, type: 'cancel' }, 'No file selected.');
          else settle({ state, type: 'picked', docs }, 'Selected. This window will close.');
        },
      })).catch((error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
      });
    };

    if (session === 'pick' && config.accessToken) {
      openPicker(config.accessToken);
      return;
    }
    arm(config.clientId, (accessToken, expiresIn) => {
      if (session === 'token') {
        settle(
          { state, type: 'token', accessToken, expiresIn },
          'Signed in. This window will close.',
        );
        return;
      }
      if (settled) return;
      hooks.post({ state, type: 'token', accessToken, expiresIn });
      openPicker(accessToken);
    });
  }

  function arm(clientId: string, onToken: (accessToken: string, expiresIn: number) => void): void {
    if (settled) return;
    try {
      const pending = hooks.requestToken(clientId, {
        callback: (response) => {
          const signal = signalFromTokenResponse(response);
          if (signal.kind === 'token') onToken(signal.accessToken, signal.expiresIn);
          else if (signal.kind === 'error') fail(signal.message);
        },
        error: (error) => {
          const signal = signalFromTokenClientError(error);
          if (signal.kind === 'error') fail(signal.message);
          else if (signal.kind === 'needs-gesture') offerGesture(clientId, onToken);
        },
      });
      if (pending && typeof pending.then === 'function') {
        void pending.catch((error: unknown) => {
          fail(error instanceof Error ? error.message : String(error));
        });
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  function offerGesture(clientId: string, onToken: (accessToken: string, expiresIn: number) => void): void {
    if (settled || gestureOffered) return;
    gestureOffered = true;
    hooks.setStatus?.('The Google window was blocked. Continue to try again.');
    hooks.onNeedsGesture?.(() => {
      gestureOffered = false;
      arm(clientId, onToken);
    });
  }
}

interface TokenClient {
  requestAccessToken(override?: { prompt?: string }): void;
}

interface PickerBuilderApi {
  addView(view: unknown): PickerBuilderApi;
  enableFeature(feature: unknown): PickerBuilderApi;
  setOAuthToken(token: string): PickerBuilderApi;
  setDeveloperKey(key: string): PickerBuilderApi;
  setAppId(appId: string): PickerBuilderApi;
  setTitle(title: string): PickerBuilderApi;
  setCallback(callback: (data: { action?: string; docs?: PickerDoc[] }) => void): PickerBuilderApi;
  build(): { setVisible(visible: boolean): void };
}

interface PickerApi {
  PickerBuilder: new () => PickerBuilderApi;
  DocsView: new (viewId?: unknown) => {
    setIncludeFolders(include: boolean): unknown;
    setMimeTypes(types: string): unknown;
    setSelectFolderEnabled(enabled: boolean): unknown;
  };
  ViewId: { DOCS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
}

function gisOauth2(): {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: TokenClientError) => void;
  }): TokenClient;
} | undefined {
  return (window as unknown as {
    google?: { accounts?: { oauth2?: ReturnType<typeof gisOauth2> } };
  }).google?.accounts?.oauth2;
}

function pickerApi(): PickerApi | undefined {
  return (window as unknown as { google?: { picker?: PickerApi } }).google?.picker;
}

/** Load GIS once and request a token. `prompt: ''` asks only the first time. */
export function requestGisToken(clientId: string, scope: string, handlers: TokenHandlers): Promise<void> {
  return loadScript(GIS_SCRIPT_URL).then(() => {
    const oauth2 = gisOauth2();
    if (!oauth2) throw new Error('Google sign-in did not load.');
    oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: handlers.callback,
      error_callback: handlers.error,
    }).requestAccessToken({ prompt: '' });
  });
}

/** Picker iframe. This page has no COEP, so docs.google.com is allowed to frame. */
export function openGooglePicker(request: PickerRequest): Promise<void> {
  return loadScript(GAPI_SCRIPT_URL).then(() => new Promise<void>((resolve, reject) => {
    const gapi = (window as unknown as { gapi?: { load(api: string, options: { callback: () => void; onerror?: () => void }): void } }).gapi;
    if (!gapi) {
      reject(new Error('Google Picker failed to load.'));
      return;
    }
    gapi.load('picker', {
      callback: () => {
        try {
          const picker = pickerApi();
          if (!picker) throw new Error('Google Picker failed to load.');
          const view = new picker.DocsView(picker.ViewId.DOCS);
          view.setIncludeFolders(true);
          view.setSelectFolderEnabled(false);
          view.setMimeTypes(request.mimeTypes);
          let builder = new picker.PickerBuilder()
            .addView(view)
            .enableFeature(picker.Feature.MULTISELECT_ENABLED)
            .setTitle('Import from Google Drive')
            .setOAuthToken(request.accessToken)
            .setDeveloperKey(request.apiKey);
          if (request.appId) builder = builder.setAppId(request.appId);
          builder
            .setCallback((data) => {
              if (data.action === picker.Action.PICKED) request.onResult('picked', data.docs ?? []);
              else if (data.action === picker.Action.CANCEL) request.onResult('cancel', []);
            })
            .build()
            .setVisible(true);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      onerror: () => reject(new Error('Google Picker failed to load.')),
    });
  }));
}

const scriptLoads = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
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

function bootDriveAuthPopup(): void {
  const root = document.getElementById('drive-auth');
  if (!root || root.dataset.booted === '1') return;
  root.dataset.booted = '1';
  const status = document.getElementById('drive-auth-status');
  const button = document.getElementById('drive-auth-continue');
  const params = new URLSearchParams(window.location.search);
  const state = params.get('state')?.trim() ?? '';
  const channel = new BroadcastChannel(DRIVE_AUTH_CHANNEL);
  startDriveAuthPopup({
    search: window.location.search,
    post: (message) => channel.postMessage(message),
    readConfig: () => new Promise((resolve) => {
      const wait = (event: MessageEvent) => {
        const config = parseDriveAuthConfig(event.data, state);
        if (!config) return;
        channel.removeEventListener('message', wait);
        resolve(config);
      };
      channel.addEventListener('message', wait);
    }),
    setStatus: (text) => {
      if (status) status.textContent = text;
    },
    onNeedsGesture: (retry) => {
      if (!(button instanceof HTMLButtonElement)) return;
      button.hidden = false;
      button.onclick = () => {
        button.hidden = true;
        retry();
      };
    },
    closeWindow: () => {
      channel.close();
      window.close();
    },
    requestToken: (clientId, handlers) => requestGisToken(clientId, DRIVE_FILE_SCOPE, handlers),
    showPicker: (request) => openGooglePicker(request),
  });
}

if (typeof document !== 'undefined') bootDriveAuthPopup();
