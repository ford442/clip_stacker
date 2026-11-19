import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mediaMocks = vi.hoisted(() => ({ getMediaInfo: vi.fn() }));
vi.mock('../../media/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../media/media')>()),
  getMediaInfo: mediaMocks.getMediaInfo,
}));

import { editorStore } from '../../store/editorStore';
import { settingsStore } from '../../store/settingsStore';
import { fixtureProject } from '../../interchange/interchange.test.helpers';
import { applyProjectOps } from './apply';
import { projectOpsJsonSchema, validateProjectOps } from './schema';
import { createProjectApi } from '../projectApi';

const SCHEMA_PATH = resolve(process.cwd(), 'docs/project-ops.schema.json');

async function twoClips(): Promise<string[]> {
  await fixtureProject({ clips: [{ demo: 'a', trimEnd: 4 }, { demo: 'b', trimEnd: 4 }, { demo: 'a', trimStart: 1, trimEnd: 3, layer: 1, startTime: 1 }] });
  return editorStore.getState().clips.map((c) => c.id);
}

describe('ProjectOp schema', () => {
  it('the committed docs/project-ops.schema.json is up to date', () => {
    // Regenerate after changing an op spec:
    //   UPDATE_PROJECT_OPS_SCHEMA=1 npx vitest --run src/actions/projectOps
    const schema = projectOpsJsonSchema();
    if (process.env['UPDATE_PROJECT_OPS_SCHEMA']) {
      writeFileSync(SCHEMA_PATH, `${JSON.stringify(schema, null, 2)}\n`);
      return;
    }
    expect(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))).toEqual(schema);
  });

  it('validates strictly, with paths', () => {
    expect(validateProjectOps([{ op: 'trim', clipId: 'a', trimStart: 1 }]).ok).toBe(true);
    const bad = validateProjectOps([{ op: 'trim', clipId: 'a', trimStart: -1, extra: 1 }, { op: 'nope' }, { op: 'split', time: 'x' }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual([
        'ops[0].extra is not a field (allowed: clipId, trimStart, trimEnd)',
        'ops[0].trimStart must be ≥ 0',
        expect.stringMatching(/^ops\[1\]\.op must be one of addClip, /),
        'ops[2].clipId is required',
        'ops[2].time must be a finite number (got string)',
      ]);
    }
    expect(validateProjectOps('{"op": "addTrack", "kind": "audio"}').ok).toBe(true);
    expect(validateProjectOps('{').ok).toBe(false);
  });
});

describe('applyProjectOps', () => {
  beforeEach(() => {
    mediaMocks.getMediaInfo.mockReset().mockImplementation(async (file: File) => ({ duration: 5, objectUrl: `blob:${file.name}`, videoWidth: 640, videoHeight: 360, hasAudio: true }));
  });

  it('applies a batch as one undo step and returns created ids', async () => {
    const [a, b, overlay] = await twoClips();
    const depth = editorStore.getState().undoDepth;
    const result = await applyProjectOps([
      { op: 'trim', clipId: a, trimStart: 0.5, trimEnd: 3.5 },
      { op: 'setTransition', clipId: b, type: 'dissolve', duration: 1 },
      { op: 'split', clipId: b, time: 4.5 },
      { op: 'move', clipId: overlay, startTime: 2 },
      { op: 'setClip', clipId: overlay, fields: { opacity: 0.5, volume: 0.25 } },
      { op: 'setKeyframes', clipId: a, prop: 'volume', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      { op: 'addTrack', kind: 'text', label: 'Lower thirds' },
      { op: 'addMarker', time: 1.5, text: 'beat' },
      { op: 'setCaptions', captions: [{ startSec: 0, endSec: 1, text: 'Hello' }] },
      { op: 'setMasterBus', masterBus: { loudness: { targetLufs: -16, truePeakDb: -1 } } },
      { op: 'setFinishing', preset: { finishing: { grain: { enabled: true, amount: 0.3 } } } },
      { op: 'setTimecode', start: '10:00:00:00', rate: '25' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const splitId = result.results[2]!['clipId']!;
    const titlesLane = result.results[6]!['trackId']!;
    const state = editorStore.getState();
    expect(state.undoDepth).toBe(depth + 1);
    expect(state.clips.find((c) => c.id === a)).toMatchObject({ trimStart: 0.5, trimEnd: 3.5 });
    expect(state.clips.find((c) => c.id === a)!.automation?.volume).toHaveLength(2);
    expect(state.clips.some((c) => c.id === splitId)).toBe(true);
    expect(state.transitions.find((t) => t.afterClipIndex === 1)).toMatchObject({ type: 'dissolve', duration: 1 });
    expect(state.tracks.find((t) => t.items.some((i) => i.clipId === overlay))!.items.find((i) => i.clipId === overlay)!.startTime).toBe(2);
    expect(state.clips.find((c) => c.id === overlay)).toMatchObject({ opacity: 0.5, volume: 0.25 });
    expect(state.tracks.find((t) => t.id === titlesLane)).toMatchObject({ kind: 'text', label: 'Lower thirds' });
    expect(state.masterAudioMarkers).toEqual([expect.objectContaining({ time: 1.5, text: 'beat' })]);
    expect(state.captions[0]).toMatchObject({ text: 'Hello' });
    expect(state.masterBus?.loudness?.targetLufs).toBe(-16);
    expect(settingsStore.getState().finishing.grain?.enabled).toBe(true);
    expect(settingsStore.getState().timecode).toEqual({ start: '10:00:00:00', rate: '25' });

    // One undo takes the whole batch back, finishing included.
    editorStore.getState().undo();
    const undone = editorStore.getState();
    expect(undone.clips.find((c) => c.id === a)).toMatchObject({ trimStart: 0, trimEnd: 4 });
    expect(undone.clips.some((c) => c.id === splitId)).toBe(false);
    expect(undone.captions).toEqual([]);
    expect(settingsStore.getState().finishing.grain?.enabled).toBe(false);
  });

  it('is all or nothing: a locked lane refuses with a structured error and nothing changes', async () => {
    const [a, b] = await twoClips();
    editorStore.getState().toggleTrackLocked('v1');
    const before = editorStore.getState();
    const result = await applyProjectOps([
      { op: 'addMarker', time: 1, text: 'kept?' },
      { op: 'trim', clipId: b, trimEnd: 2 },
      { op: 'trim', clipId: a, trimEnd: 2 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.refused).toMatchObject({ index: 1, op: 'trim' });
    expect(result.refused!.message).toMatch(/locked/i);
    expect(editorStore.getState().masterAudioMarkers).toBe(before.masterAudioMarkers);
    expect(editorStore.getState().clips).toBe(before.clips);
    expect(editorStore.getState().undoDepth).toBe(before.undoDepth);
  });

  it('adds a clip from the library by file name onto a lane', async () => {
    await twoClips();
    const result = await applyProjectOps([{ op: 'addClip', id: 'new-clip', fileName: 'demo-clip-b.mp4', trackId: 'v2', startTime: 4 }]);
    expect(result.errors).toEqual([]);
    const state = editorStore.getState();
    expect(state.clips.find((c) => c.id === 'new-clip')).toMatchObject({ duration: 5, title: 'demo-clip-b.mp4' });
    expect(state.tracks.find((t) => t.id === 'v2')!.items).toContainEqual({ clipId: 'new-clip', startTime: 4 });
    const missing = await applyProjectOps([{ op: 'addClip', fileName: 'nowhere.mp4' }]);
    expect(missing.refused).toMatchObject({ index: 0, op: 'addClip' });
  });

  it('is what window.clipStacker.project.apply runs, beside getState and exportTimeline', async () => {
    const [a] = await twoClips();
    const api = createProjectApi();
    expect(api.version).toBe(1);
    expect((await api.apply({ op: 'trim', clipId: a, trimEnd: 2 })).ok).toBe(true);
    expect(api.getState().clips.find((c) => c.id === a)!.trimEnd).toBe(2);
    expect(api.exportTimeline('edl')).toMatch(/^TITLE: /);
    expect(api.agentBrief()).toContain('setTransition');
    api.undo();
    expect(api.getState().clips.find((c) => c.id === a)!.trimEnd).toBe(4);
  });
});
