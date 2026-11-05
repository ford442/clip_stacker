import { createStore } from 'zustand/vanilla';
import type { RenderPlan } from '../types';

/**
 * Render-job state: the status line, progress, FFmpeg load state, the last
 * output and its render plan, and the long-running library jobs (RIFE,
 * intercut). Session-only — never part of a project, autosave or undo.
 * Project / export settings live in `settingsStore`.
 */
export interface RenderJobState {
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

export const renderJobStore = createStore<RenderJobState>()((set) => ({
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

export const renderJobActions = renderJobStore.getState();
