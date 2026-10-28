import { describe, expect, it } from 'vitest';
import type { CaptionEntry, Project } from '../types';
import { serializeProject, applyProjectData } from './project';
import { createTestClip } from './project.test.helpers';
import { parseSrt, serializeSrt } from './subtitles';

const CLIPS = [createTestClip('a', 5, 'Clip A')];

const CAPTIONS: CaptionEntry[] = [
  { id: 'c1', startSec: 1, endSec: 2.5, text: 'First cue' },
  { id: 'c2', startSec: 3, endSec: 4, text: 'Second\ncue', style: { fontsize: 72 } },
];

describe('project captions round-trip', () => {
  it('serializes and restores cues with their per-cue styles', async () => {
    const project = serializeProject(CLIPS, [], [], [], undefined, [], undefined, null, CAPTIONS);
    const restored = await applyProjectData(project, CLIPS);

    expect(restored.captions).toHaveLength(2);
    expect(restored.captions[0]).toMatchObject({
      id: 'c1',
      startSec: 1,
      endSec: 2.5,
      text: 'First cue',
    });
    expect(restored.captions[1].text).toBe('Second\ncue');
    expect(restored.captions[1].style).toEqual({ fontsize: 72 });
  });

  it('round-trips the project-wide caption style', async () => {
    const project = serializeProject(
      CLIPS, [], [], [], undefined, [], undefined, null,
      CAPTIONS,
      { fontcolor: '#ffcc00', y: 0.8 },
    );
    const restored = await applyProjectData(project, CLIPS);
    expect(restored.captionStyle).toEqual({ fontcolor: '#ffcc00', y: 0.8 });
  });

  it('omits caption fields entirely when there are none', () => {
    const project = serializeProject(CLIPS, [], [], []);
    expect(project.captions).toBeUndefined();
    expect(project.captionStyle).toBeUndefined();
  });

  it('loads a project saved before captions existed as an empty track', async () => {
    const legacy = serializeProject(CLIPS, [], [], []);
    const restored = await applyProjectData(legacy, CLIPS);
    expect(restored.captions).toEqual([]);
    expect(restored.captionStyle).toEqual({});
  });

  it('drops malformed cues instead of failing the whole load', async () => {
    const project: Project = {
      ...serializeProject(CLIPS, [], [], []),
      captions: [
        { id: 'ok', startSec: 1, endSec: 2, text: 'Keep me' },
        { id: 'no-text', startSec: 3, endSec: 4, text: '   ' },
        { id: 'bad-time', startSec: Number.NaN, endSec: 5, text: 'Drop me' },
      ] as CaptionEntry[],
    };
    const restored = await applyProjectData(project, CLIPS);
    expect(restored.captions.map((c) => c.text)).toEqual(['Keep me']);
  });

  it('regenerates ids for cues saved without one', async () => {
    const project: Project = {
      ...serializeProject(CLIPS, [], [], []),
      captions: [{ startSec: 1, endSec: 2, text: 'No id' }] as CaptionEntry[],
    };
    const restored = await applyProjectData(project, CLIPS);
    expect(restored.captions[0].id).toBeTruthy();
  });

  it('survives the full .srt import → project save → load → .srt export path', async () => {
    const srt = `1
00:00:01,000 --> 00:00:02,500
First cue

2
00:00:03,000 --> 00:00:04,000
Second
cue
`;
    const imported = parseSrt(srt);
    const project = serializeProject(
      CLIPS, [], [], [], undefined, [], undefined, null, imported,
    );
    const restored = await applyProjectData(JSON.parse(JSON.stringify(project)), CLIPS);
    const exported = parseSrt(serializeSrt(restored.captions));

    expect(exported).toHaveLength(imported.length);
    exported.forEach((entry, index) => {
      expect(entry.startSec).toBeCloseTo(imported[index].startSec, 3);
      expect(entry.endSec).toBeCloseTo(imported[index].endSec, 3);
      expect(entry.text).toBe(imported[index].text);
    });
  });
});
