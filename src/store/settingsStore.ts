import { createStore } from 'zustand/vanilla';
import type { ExportSettings, RenderPlan } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { DEFAULT_FINISHING, type FinishingSettings } from '../utils/finishing';
import type { CaptionExportMode } from '../ffmpeg/captions';
import type { AutoCaptionScope } from '../utils/autoCaptionAudio';

/** localStorage key for the self-hosted transcription endpoint (#auto-caption). */
export const AUTO_CAPTION_ENDPOINT_KEY = 'clipStacker.autoCaptionEndpoint';

function readStoredEndpoint(): string {
  try {
    return localStorage.getItem(AUTO_CAPTION_ENDPOINT_KEY) ?? '';
  } catch {
    // Private windows can throw on access — the endpoint is a convenience.
    return '';
  }
}

export interface SettingsState {
  exportSettings: ExportSettings;
  finishing: FinishingSettings;
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

  status: string;
  progressStage: string;
  progressValue: number | null;
  progressIndeterminate: boolean;

  isRendering: boolean;
  ffmpegLoading: boolean;
  ffmpegFailed: boolean;
  outputUrl: string | null;
  encoderPath: string;
  renderPlan: RenderPlan | null;
  rifeProcessingClipId: string | null;
  intercutProcessing: boolean;

  setExportSettings: (settings: ExportSettings) => void;
  setFinishing: (settings: FinishingSettings) => void;
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

  setStatus: (status: string) => void;
  setProgressStage: (stage: string) => void;
  setProgressValue: (val: number | null) => void;
  setProgressIndeterminate: (val: boolean) => void;

  setIsRendering: (v: boolean) => void;
  setFfmpegLoading: (v: boolean) => void;
  setFfmpegFailed: (v: boolean) => void;
  setOutputUrl: (url: string | null) => void;
  setEncoderPath: (path: string) => void;
  setRenderPlan: (plan: RenderPlan | null) => void;
  setRifeProcessingClipId: (id: string | null) => void;
  setIntercutProcessing: (v: boolean) => void;
}

export const settingsStore = createStore<SettingsState>()((set) => ({
  exportSettings: DEFAULT_EXPORT_SETTINGS,
  finishing: DEFAULT_FINISHING,
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

  status: '',
  progressStage: '',
  progressValue: null,
  progressIndeterminate: false,

  isRendering: false,
  ffmpegLoading: false,
  ffmpegFailed: false,
  outputUrl: null,
  encoderPath: '',
  renderPlan: null,
  rifeProcessingClipId: null,
  intercutProcessing: false,

  setExportSettings: (settings) => set({ exportSettings: settings }),
  setFinishing: (settings) => set({ finishing: settings }),
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
    try {
      if (endpoint) localStorage.setItem(AUTO_CAPTION_ENDPOINT_KEY, endpoint);
      else localStorage.removeItem(AUTO_CAPTION_ENDPOINT_KEY);
    } catch {
      // Not persisting is fine; the session still has the value.
    }
  },

  setStatus: (status) => set({ status }),
  setProgressStage: (stage) => set({ progressStage: stage }),
  setProgressValue: (val) => set({ progressValue: val }),
  setProgressIndeterminate: (val) => set({ progressIndeterminate: val }),

  setIsRendering: (v) => set({ isRendering: v }),
  setFfmpegLoading: (v) => set({ ffmpegLoading: v }),
  setFfmpegFailed: (v) => set({ ffmpegFailed: v }),
  setOutputUrl: (url) => set({ outputUrl: url }),
  setEncoderPath: (path) => set({ encoderPath: path }),
  setRenderPlan: (plan) => set({ renderPlan: plan }),
  setRifeProcessingClipId: (id) => set({ rifeProcessingClipId: id }),
  setIntercutProcessing: (v) => set({ intercutProcessing: v }),
}));

export const settingsActions = settingsStore.getState();
