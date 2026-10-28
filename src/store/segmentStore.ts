import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ProcessingBackendId, SegmentOperation, SegmentRequest } from '../types';
import type { ExtractedSegment } from '../utils/segments/extractSegment';

/**
 * The one segment extract / process / replace in flight (or waiting to be
 * replaced). View state only: never serialized, never in the undo history — the
 * replace itself is the undoable edit.
 */
export interface SegmentSession {
  request: SegmentRequest;
  backend: ProcessingBackendId;
  operation: SegmentOperation;
  phase: 'working' | 'ready' | 'error';
  /** Latest progress / error text. */
  message: string;
  /** 0..1 while a server job reports it. */
  progress?: number;
  result?: ExtractedSegment;
  /** Colab: the cut segment is ready to take away; waiting for the processed file. */
  awaitingImport?: boolean;
}

export interface SegmentState {
  session: SegmentSession | null;
  setSession: (session: SegmentSession | null) => void;
  patchSession: (patch: Partial<SegmentSession>) => void;
}

export const segmentStore = createStore<SegmentState>()((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  patchSession: (patch) => set((s) => (s.session ? { session: { ...s.session, ...patch } } : s)),
}));

export const segmentActions: Pick<SegmentState, 'setSession' | 'patchSession'> = segmentStore.getState();

export const useSegmentSession = () => useStore(segmentStore, (s) => s.session);
