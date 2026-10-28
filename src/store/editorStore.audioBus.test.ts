import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorStore, editorActions, __resetEditorStoreForTests } from './editorStore';
import { createBusEffect, type BusEffect } from '../utils/audioBus';

const lane = (id: string) => editorStore.getState().tracks.find((t) => t.id === id)!;

describe('editorStore: lane and master buses', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a whole FX-chain edit is one undo step', () => {
    const chain: BusEffect[] = [createBusEffect('eq'), createBusEffect('compressor'), createBusEffect('limiter')];
    editorActions.setTrackAudioFx('a1', chain);
    expect(lane('a1').audioFx).toHaveLength(3);
    expect(editorStore.getState().undoDepth).toBe(1);

    // Reorder + bypass in one edit, then undo: back to the original chain.
    editorActions.setTrackAudioFx('a1', [{ ...chain[2]!, enabled: false }, chain[0]!, chain[1]!]);
    editorActions.undo();
    expect(lane('a1').audioFx!.map((e) => e.kind)).toEqual(['eq', 'compressor', 'limiter']);
    editorActions.undo();
    expect(lane('a1')).not.toHaveProperty('audioFx');
  });

  it('coalesces a slider drag into one step', () => {
    const comp = createBusEffect('compressor') as Extract<BusEffect, { kind: 'compressor' }>;
    editorActions.setTrackAudioFx('v1', [comp]);
    const depth = editorStore.getState().undoDepth;
    for (const thresholdDb of [-21, -22, -23, -24]) {
      editorActions.setTrackAudioFx('v1', [{ ...comp, thresholdDb }], 'busfx:v1');
    }
    expect(editorStore.getState().undoDepth).toBe(depth + 1);
    vi.advanceTimersByTime(1000);
    editorActions.undo();
    expect((lane('v1').audioFx![0] as typeof comp).thresholdDb).toBe(comp.thresholdDb);
  });

  it('locked lanes refuse FX and duck edits (no undo step either)', () => {
    editorActions.toggleTrackLocked('a1');
    const depth = editorStore.getState().undoDepth;
    editorActions.setTrackAudioFx('a1', [createBusEffect('gate')]);
    editorActions.setTrackDuck('a1', 'off');
    expect(lane('a1')).not.toHaveProperty('audioFx');
    expect(lane('a1')).not.toHaveProperty('duck');
    expect(editorStore.getState().undoDepth).toBe(depth);
  });

  it('sets, clears and refuses self-keyed ducks', () => {
    editorActions.setTrackDuck('a1', {
      sourceTrackId: 'v1',
      depthDb: 9,
      thresholdDb: -40,
      attack: 0.05,
      hold: 0.2,
      release: 0.5,
    });
    expect(lane('a1').duck).toMatchObject({ sourceTrackId: 'v1' });
    const depth = editorStore.getState().undoDepth;
    editorActions.setTrackDuck('a1', { ...(lane('a1').duck as object), sourceTrackId: 'a1' } as never);
    expect(editorStore.getState().undoDepth).toBe(depth);
    editorActions.setTrackDuck('a1', undefined);
    expect(lane('a1')).not.toHaveProperty('duck');
  });

  it('master bus edits are undoable and a no-op edit pushes nothing', () => {
    editorActions.setMasterBus({ loudness: { targetLufs: -14, truePeakDb: -1 } });
    expect(editorStore.getState().masterBus).toEqual({ loudness: { targetLufs: -14, truePeakDb: -1 } });
    const depth = editorStore.getState().undoDepth;
    editorActions.setMasterBus({ loudness: { targetLufs: -14, truePeakDb: -1 } });
    expect(editorStore.getState().undoDepth).toBe(depth);
    editorActions.undo();
    expect(editorStore.getState().masterBus).toBeUndefined();
    editorActions.redo();
    expect(editorStore.getState().masterBus?.loudness?.targetLufs).toBe(-14);
  });
});
