import { createStore } from 'zustand/vanilla';
import type {
  AutoCaptionScope,
  CaptionExportMode,
  ExportSettings,
} from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { registerExportStateSource } from '../export/exportSources';
import { safeGet, safeRemove, safeSet } from '../utils/storageKeys';
import { DEFAULT_FINISHING, type FinishingSettings } from '../finishing/finishing';
import {
  DEFAULT_COLOR_MANAGEMENT,
  type ColorManagementSettings,
} from '../finishing/colorManagement';

function readStoredEndpoint(): string {
  // A blocked storage reads as unset — the endpoint is a convenience.
  return safeGet('autoCaptionEndpoint') ?? '';
}

/**
 * Project and export settings (what a project saves: export settings,
 * finishing, colour management) plus per-session export preferences.
 * Render-job progress lives in `renderJobStore`.
 */
export interface SettingsState {
  exportSettings: ExportSettings;
  finishing: FinishingSettings;
  colorManagement: ColorManagementSettings;
  forceFFmpeg: boolean;
  useCanvasRenderer: boolean;
  audioReactive: boolean;
  forceReencode: boolean;
  /**
   * How the caption track is attached to the exported MP4 (#captions).
   * Runs as a post-pass over the finished file, so it applies to every
   * encoder path. Sidecar `.srt` export is a separate explicit action.
   */
  captionExportMode: CaptionExportMode;
  /**
   * Draw caption cues in the live preview and (for burn-in export) in the
   * compositor. On by default — the preview used to be the one place the CC
   * lane's cues never showed up.
   */
  showCaptionsInPreview: boolean;

  /** Selected auto-caption provider id, or null for "first available". */
  autoCaptionProviderId: string | null;
  /** BCP-47 hint passed to the provider. Empty string = let it auto-detect. */
  autoCaptionLanguage: string;
  /** Transcribe the whole timeline or just the selected clip. */
  autoCaptionScope: AutoCaptionScope;
  /** Merge cues into the existing track instead of replacing it. */
  autoCaptionMerge: boolean;
  /** Self-hosted transcription endpoint for the `whisper-http` provider. */
  autoCaptionEndpoint: string;

  setExportSettings: (settings: ExportSettings) => void;
  setFinishing: (settings: FinishingSettings) => void;
  setColorManagement: (settings: ColorManagementSettings) => void;
  setForceFFmpeg: (v: boolean) => void;
  setUseCanvasRenderer: (v: boolean) => void;
  setAudioReactive: (v: boolean) => void;
  setForceReencode: (v: boolean) => void;
  setCaptionExportMode: (mode: CaptionExportMode) => void;
  setShowCaptionsInPreview: (v: boolean) => void;
  setAutoCaptionProviderId: (id: string | null) => void;
  setAutoCaptionLanguage: (language: string) => void;
  setAutoCaptionScope: (scope: AutoCaptionScope) => void;
  setAutoCaptionMerge: (v: boolean) => void;
  setAutoCaptionEndpoint: (endpoint: string) => void;
}

export const settingsStore = createStore<SettingsState>()((set) => ({
  exportSettings: DEFAULT_EXPORT_SETTINGS,
  finishing: DEFAULT_FINISHING,
  colorManagement: DEFAULT_COLOR_MANAGEMENT,
  forceFFmpeg: false,
  useCanvasRenderer: false,
  audioReactive: true,
  forceReencode: false,
  captionExportMode: 'none',
  showCaptionsInPreview: true,

  autoCaptionProviderId: null,
  autoCaptionLanguage: '',
  autoCaptionScope: 'timeline',
  autoCaptionMerge: false,
  autoCaptionEndpoint: readStoredEndpoint(),

  setExportSettings: (settings) => set({ exportSettings: settings }),
  setFinishing: (settings) => set({ finishing: settings }),
  setColorManagement: (settings) => set({ colorManagement: settings }),
  setForceFFmpeg: (v) => set({ forceFFmpeg: v }),
  setUseCanvasRenderer: (v) => set({ useCanvasRenderer: v }),
  setAudioReactive: (v) => set({ audioReactive: v }),
  setForceReencode: (v) => set({ forceReencode: v }),
  setCaptionExportMode: (mode) => set({ captionExportMode: mode }),
  setShowCaptionsInPreview: (v) => set({ showCaptionsInPreview: v }),
  setAutoCaptionProviderId: (id) => set({ autoCaptionProviderId: id }),
  setAutoCaptionLanguage: (language) => set({ autoCaptionLanguage: language }),
  setAutoCaptionScope: (scope) => set({ autoCaptionScope: scope }),
  setAutoCaptionMerge: (v) => set({ autoCaptionMerge: v }),
  setAutoCaptionEndpoint: (endpoint) => {
    set({ autoCaptionEndpoint: endpoint });
    // Not persisting is fine; the session still has the value.
    if (endpoint) safeSet('autoCaptionEndpoint', endpoint);
    else safeRemove('autoCaptionEndpoint');
  },
}));

export const settingsActions = settingsStore.getState();

// The export layer reads the master limiter from here without importing a store.
registerExportStateSource({
  masterLimiter: () => settingsStore.getState().exportSettings.masterLimiter,
});
