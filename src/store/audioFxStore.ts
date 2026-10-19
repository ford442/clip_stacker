import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AudioFxPreviewState } from '../wasm/audioFx';
import type { MixMeterReading } from '../wasm/mediaEngineSession';

/**
 * Live state of the preview's bus graph (`audio/busRouting.ts`): whether
 * lane / master FX are being previewed, and the latest meter readout. View
 * state only — never in a project or undo history.
 */
export interface AudioFxState {
  preview: AudioFxPreviewState;
  /** Latest readout (~10 Hz while playing); null when nothing meters. */
  meters: MixMeterReading | null;
  /** Lane track ids in the readout's `laneGainReduction` order. */
  meterLaneTrackIds: string[];
  /**
   * Mounted loudness meters. While above zero the preview keeps the bus graph
   * running (as a pure meter) even when the project has no FX.
   */
  meterRequests: number;

  setPreview: (preview: AudioFxPreviewState) => void;
  setMeters: (meters: MixMeterReading | null, laneTrackIds?: string[]) => void;
  /** Register a meter UI; returns its release. */
  requestMeter: () => () => void;
}

export const audioFxStore = createStore<AudioFxState>()((set) => ({
  preview: { state: 'idle' },
  meters: null,
  meterLaneTrackIds: [],
  meterRequests: 0,
  setPreview: (preview) => set({ preview }),
  setMeters: (meters, laneTrackIds) =>
    set((s) => ({ meters, meterLaneTrackIds: laneTrackIds ?? s.meterLaneTrackIds })),
  requestMeter: () => {
    set((s) => ({ meterRequests: s.meterRequests + 1 }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((s) => ({ meterRequests: Math.max(0, s.meterRequests - 1) }));
    };
  },
}));

export const useAudioFxPreview = () => useStore(audioFxStore, (s) => s.preview);
export const useAudioFxMeters = () => useStore(audioFxStore, (s) => s.meters);

/** Gain reduction (dB) the preview last reported for one lane, or 0. */
export const useLaneGainReduction = (trackId: string) =>
  useStore(audioFxStore, (s) => {
    const index = s.meterLaneTrackIds.indexOf(trackId);
    return index >= 0 ? (s.meters?.laneGainReduction[index] ?? 0) : 0;
  });
