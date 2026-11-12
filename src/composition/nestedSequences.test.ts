import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { buildPreviewCompositionPlan, type PreviewClipLayer, type PreviewTextLayer } from './previewComposition';
import { effectiveTextOverlays, resolveNestedSequences, withNestedInstances } from './nestedSequences';
import { buildAudioSchedule } from '../audio/schedule';
import { getEffectiveTimelineClips } from '../timeline/trackModel';
import { enterSequence, exitToRoot, nestClips, sequenceBodies, type SequenceEditorState } from '../timeline/sequenceModel';
import { NESTED_SEQUENCE_MAX_DEPTH, nestedInstanceId } from '../timeline/sequenceResolve';
import { MAIN_VIDEO_TRACK_ID, OVERLAY_VIDEO_TRACK_ID } from '../timeline/trackBasics';
import { expectOk, seqTestClip, seqTestOverlay, seqTestState } from '../timeline/sequences.test.helpers';

const SETTINGS = { outputResolution: '1280x720' as const };

/** Clips as the open timeline lays them out, with nested sequences resolved. */
function timeline(state: SequenceEditorState): Clip[] {
  const flat = getEffectiveTimelineClips(state.tracks, state.clips, state.clipGroups);
  const active = state.sequencePath[state.sequencePath.length - 1] ?? null;
  return resolveNestedSequences(flat, sequenceBodies(state), active);
}

function plan(state: SequenceEditorState, t: number) {
  const clips = timeline(state);
  return buildPreviewCompositionPlan(clips, [], state.transitions, state.textOverlays, SETTINGS, t, 720, 1280);
}

const clipLayers = (layers: ReturnType<typeof plan>['layers']) =>
  layers.filter((layer): layer is PreviewClipLayer => layer.kind === 'base' || layer.kind === 'pip');
const textLayers = (layers: ReturnType<typeof plan>['layers']) =>
  layers.filter((layer): layer is PreviewTextLayer => layer.kind === 'text');

/** a (5 s) then a sequence of b (3 s) + c (4 s) + a title, placed at 5 s. */
function nestedState(): SequenceEditorState {
  const state = seqTestState(
    [seqTestClip('a', 5), seqTestClip('b', 3, { volume: 0.5 }), seqTestClip('c', 4)],
    [],
    [seqTestOverlay('title', { x: 0.25, y: 0.5, fontsize: 40 })],
  );
  return expectOk(
    nestClips(state, { clipIds: ['b', 'c'], textOverlayIds: ['title'], sequenceId: 'seq', name: 'Seq', sequenceClipId: 'S' }),
  );
}

describe('nested composition plan', () => {
  it('samples the nested sequence at parentTime − start + inPoint', () => {
    const state = nestedState();
    const at6 = plan(state, 6);
    const layers = clipLayers(at6.layers);
    expect(layers.map((layer) => layer.clipId)).toEqual([nestedInstanceId('S', 'b')]);
    expect(layers[0]!.sourceTime).toBeCloseTo(1);
    // The sequence clip itself is never drawn.
    expect(clipLayers(at6.layers).some((layer) => layer.clipId === 'S')).toBe(false);

    const at9 = clipLayers(plan(state, 9).layers);
    expect(at9.map((layer) => layer.clipId)).toEqual([nestedInstanceId('S', 'c')]);
    expect(at9[0]!.sourceTime).toBeCloseTo(1);

    // A trimmed sequence clip starts later inside its sequence.
    const trimmed = { ...state, clips: state.clips.map((clip) => (clip.id === 'S' ? { ...clip, trimStart: 2 } : clip)) };
    const atTrim = clipLayers(plan(trimmed, 6).layers);
    expect(atTrim.map((layer) => layer.clipId)).toEqual([nestedInstanceId('S', 'c')]);
    expect(atTrim[0]!.sourceTime).toBeCloseTo(0);
    expect(plan(trimmed, 0).totalDuration).toBeCloseTo(10);
  });

  it('draws the nested titles inside the sequence clip, in nested time', () => {
    const state = nestedState();
    expect(textLayers(plan(state, 2).layers)).toEqual([]);
    const at6 = plan(state, 6);
    const titles = textLayers(at6.layers);
    expect(titles).toHaveLength(1);
    expect(titles[0]!.overlayId).toBe(nestedInstanceId('S', 'title'));
    expect(titles[0]!.time).toBeCloseTo(1);
    expect(titles[0]!.x).toBeCloseTo(320);
    const base = clipLayers(at6.layers)[0]!;
    expect(titles[0]!.zIndex).toBeGreaterThan(base.zIndex);
    // Export gates see the nested title too.
    expect(effectiveTextOverlays(timeline(state), state.textOverlays)).toHaveLength(1);
  });

  it('maps a PiP sequence clip’s layers into its rect', () => {
    const base = seqTestClip('bg', 10);
    const state = expectOk(
      nestClips(
        seqTestState([base], [[seqTestClip('inner', 4), 2]], [seqTestOverlay('t', { x: 0.5, y: 0.5, fontsize: 40 })]),
        { clipIds: ['inner'], textOverlayIds: ['t'], sequenceId: 'pipseq', name: 'P', sequenceClipId: 'P' },
      ),
    );
    const asPip = {
      ...state,
      clips: state.clips.map((clip) =>
        clip.id === 'P' ? { ...clip, x: 0.5, y: 0.5, width: 0.5, height: 0.5, opacity: 0.5 } : clip,
      ),
    };
    const layers = plan(asPip, 3).layers;
    const inner = clipLayers(layers).find((layer) => layer.clipId === nestedInstanceId('P', 'inner'))!;
    expect(inner.kind).toBe('pip');
    expect(inner.rect).toEqual({ x: 640, y: 360, width: 640, height: 360 });
    expect(inner.opacity).toBeCloseTo(0.5);
    const title = textLayers(layers)[0]!;
    expect(title.x).toBeCloseTo(640 + 320);
    expect(title.y).toBeCloseTo(360 + 180);
    expect(title.overlay.fontsize).toBeCloseTo(20);
    expect(title.overlay.id).toBe(nestedInstanceId('P', 't'));
  });

  it('sees edits made inside the sequence without flattening it', () => {
    const state = nestedState();
    const inside = expectOk(enterSequence(state, 'seq'));
    const edited = {
      ...inside,
      clips: inside.clips.map((clip) => (clip.id === 'b' ? { ...clip, trimStart: 1 } : clip)),
    };
    // Inside: the open sequence is the timeline.
    expect(clipLayers(plan(edited, 0).layers)[0]!.sourceTime).toBeCloseTo(1);
    // Back at the root, the sequence clip resolves the edited body.
    const root = exitToRoot(edited);
    const nested = timeline(root).find((clip) => clip.id === 'S')!.nested!;
    expect(nested.clips.find((clip) => clip.id === 'b')!.trimStart).toBe(1);
    expect(root.clips.some((clip) => clip.id === 'b')).toBe(false);
  });
});

describe('nested instances and limits', () => {
  it('adds namespaced instances so compositors find nested clips by layer id', () => {
    const clips = withNestedInstances(timeline(nestedState()));
    const ids = clips.map((clip) => clip.id);
    expect(ids).toContain(nestedInstanceId('S', 'b'));
    expect(ids).toContain(nestedInstanceId('S', 'c'));
    // Instance ids never contain the decoder cursor key separator.
    expect(ids.every((id) => !id.includes('::'))).toBe(true);
    const instance = clips.find((clip) => clip.id === nestedInstanceId('S', 'b'))!;
    expect(instance.objectUrl).toBe('blob:b');
  });

  it('drops sequences that would recurse past the depth cap or into a cycle', () => {
    const state = nestedState();
    const bodies = sequenceBodies(state);
    const seq = bodies.get('seq')!;
    // A self-referencing body (a hand-edited file): the inner reference is dropped.
    const selfRef = new Map(bodies);
    selfRef.set('seq', { ...seq, clips: [...seq.clips, state.clips.find((clip) => clip.id === 'S')!] });
    const flat = getEffectiveTimelineClips(state.tracks, state.clips, state.clipGroups);
    const resolved = resolveNestedSequences(flat, selfRef, null).find((clip) => clip.id === 'S')!;
    expect(resolved.nested).toBeDefined();
    const inner = resolved.nested!.clips.find((clip) => clip.id === 'S');
    expect(inner?.nested).toBeUndefined();

    // A chain deeper than the cap stops at the cap.
    const chain = new Map<string, typeof seq>();
    const leaf = seqTestClip('leaf', 2);
    let below: Clip = leaf;
    for (let level = NESTED_SEQUENCE_MAX_DEPTH + 2; level >= 1; level--) {
      const id = `lvl${level}`;
      chain.set(id, {
        tracks: [{ id: MAIN_VIDEO_TRACK_ID, kind: 'video', label: 'V1', items: [{ clipId: below.id, startTime: 0 }], height: 60 }],
        clips: [below],
        clipGroups: [],
        transitions: [],
        textOverlays: [],
      });
      below = { ...seqTestClip(`c-${id}`, 2), objectUrl: '', source: { type: 'sequence', sequenceId: id } };
    }
    let depth = 0;
    let node: Clip | undefined = resolveNestedSequences([below], chain, null)[0];
    while (node?.nested) {
      depth++;
      node = node.nested.clips[0];
    }
    expect(depth).toBe(NESTED_SEQUENCE_MAX_DEPTH);
  });
});

describe('nested audio schedule', () => {
  it('recurses into the sequence, offset to its placement and scaled by its volume', () => {
    const state = nestedState();
    const withVolume = {
      ...state,
      clips: state.clips.map((clip) => (clip.id === 'S' ? { ...clip, volume: 0.5 } : clip)),
    };
    const schedule = buildAudioSchedule(timeline(withVolume), [], withVolume.transitions, withVolume.tracks);
    expect(schedule.map((entry) => entry.clipId)).toEqual(['a', nestedInstanceId('S', 'b'), nestedInstanceId('S', 'c')]);
    const b = schedule[1]!;
    expect(b.timelineStart).toBeCloseTo(5);
    expect(b.duration).toBeCloseTo(3);
    expect(b.volume).toBeCloseTo(0.25);
    expect(b.objectUrl).toBe('blob:b');
    expect(schedule[2]!.timelineStart).toBeCloseTo(8);
    expect(b.trackId).toBe(MAIN_VIDEO_TRACK_ID);
  });

  it('cuts entries to the sequence clip’s trim window', () => {
    const state = nestedState();
    const trimmed = {
      ...state,
      clips: state.clips.map((clip) => (clip.id === 'S' ? { ...clip, trimStart: 1, trimEnd: 5 } : clip)),
    };
    const nested = buildAudioSchedule(timeline(trimmed), [], [], trimmed.tracks).slice(1);
    expect(nested).toHaveLength(2);
    expect(nested[0]).toMatchObject({ timelineStart: 5, bufferOffset: 1 });
    expect(nested[0]!.duration).toBeCloseTo(2);
    expect(nested[1]!.timelineStart).toBeCloseTo(7);
    expect(nested[1]!.duration).toBeCloseTo(2);
  });

  it('honours mute on a lane inside the sequence and on the lane holding it', () => {
    const state = nestedState();
    const inside = expectOk(enterSequence(state, 'seq'));
    const mutedInside = {
      ...inside,
      tracks: inside.tracks.map((track) => (track.id === MAIN_VIDEO_TRACK_ID ? { ...track, muted: true } : track)),
    };
    const committedRoot = exitToRoot(mutedInside);
    expect(buildAudioSchedule(timeline(committedRoot), [], [], committedRoot.tracks).map((e) => e.clipId)).toEqual(['a']);

    const mutedParent = {
      ...state,
      tracks: state.tracks.map((track) => (track.id === MAIN_VIDEO_TRACK_ID ? { ...track, muted: true } : track)),
    };
    expect(buildAudioSchedule(timeline(mutedParent), [], [], mutedParent.tracks)).toEqual([]);
  });

  it('keeps overlay-lane sequences on their own lane', () => {
    const state = expectOk(
      nestClips(seqTestState([seqTestClip('bg', 10)], [[seqTestClip('inner', 4), 2]]), {
        clipIds: ['inner'],
        sequenceId: 'o',
        name: 'O',
        sequenceClipId: 'O',
      }),
    );
    const schedule = buildAudioSchedule(timeline(state), [], [], state.tracks);
    const inner = schedule.find((entry) => entry.clipId === nestedInstanceId('O', 'inner'))!;
    expect(inner.timelineStart).toBeCloseTo(2);
    expect(inner.trackId).toBe(OVERLAY_VIDEO_TRACK_ID);
  });
});
