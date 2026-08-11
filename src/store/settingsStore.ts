import { createStore } from 'zustand/vanilla';
import type { ExportSettings, RenderPlan } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { DEFAULT_FINISHING, type FinishingSettings } from '../utils/finishing';

export interface SettingsState {
  exportSettings: ExportSettings;
  finishing: FinishingSettings;
  forceFFmpeg: boolean;
  useCanvasRenderer: boolean;
  audioReactive: boolean;
  forceReencode: boolean;

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

  setExportSettings: (settings: ExportSettings) => void;
  setFinishing: (settings: FinishingSettings) => void;
  setForceFFmpeg: (v: boolean) => void;
  setUseCanvasRenderer: (v: boolean) => void;
  setAudioReactive: (v: boolean) => void;
  setForceReencode: (v: boolean) => void;

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
}

export const settingsStore = createStore<SettingsState>()((set) => ({
  exportSettings: DEFAULT_EXPORT_SETTINGS,
  finishing: DEFAULT_FINISHING,
  forceFFmpeg: false,
  useCanvasRenderer: false,
  audioReactive: true,
  forceReencode: false,

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

  setExportSettings: (settings) => set({ exportSettings: settings }),
  setFinishing: (settings) => set({ finishing: settings }),
  setForceFFmpeg: (v) => set({ forceFFmpeg: v }),
  setUseCanvasRenderer: (v) => set({ useCanvasRenderer: v }),
  setAudioReactive: (v) => set({ audioReactive: v }),
  setForceReencode: (v) => set({ forceReencode: v }),

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
}));

export const settingsActions = settingsStore.getState();
