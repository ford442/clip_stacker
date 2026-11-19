import { describe, expect, it } from 'vitest';
import { readEdl, reelName, writeEdl } from './edl';
import { exportTimeline, importTimeline } from './index';
import { fixtureProject } from './interchange.test.helpers';

const XFADE = {
  clips: [{ demo: 'a', trimEnd: 3 }, { demo: 'b', trimStart: 1, trimEnd: 4 }, { demo: 'a', trimStart: 2, trimEnd: 5 }],
  transitions: [{ afterClipIndex: 1, type: 'dissolve', duration: 1 }],
  resolution: '320x180',
};

describe('CMX 3600 EDL', () => {
  it('writes cuts, a dissolve and record timecode from 01:00:00:00', async () => {
    const edl = exportTimeline(await fixtureProject(XFADE), 'edl');
    expect(edl).toContain('FCM: NON-DROP FRAME');
    const events = edl.split('\n').filter((line) => /^\d{3} /.test(line));
    expect(events).toEqual([
      '001  DEMOCLIP AA/V  C        00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00',
      '002  DEMOCLIP AA/V  C        00:00:02:00 00:00:02:00 01:00:02:00 01:00:02:00',
      '002  DEMOCLIP AA/V  D    030 00:00:01:00 00:00:04:00 01:00:02:00 01:00:05:00',
      '003  DEMOCLIP AA/V  C        00:00:02:00 00:00:05:00 01:00:05:00 01:00:08:00',
    ]);
    expect(edl).toContain('* FROM CLIP NAME: demo-clip-a.mp4');
    expect(edl).toContain('* TO CLIP NAME: demo-clip-b.mp4');
  });

  it('round-trips cuts, dissolves and speed (to the frame)', async () => {
    const project = await fixtureProject({
      ...XFADE,
      clips: [{ demo: 'a', trimEnd: 3 }, { demo: 'b', trimStart: 1, trimEnd: 4 }, { demo: 'a', trimStart: 2, trimEnd: 5 }],
    });
    project.clips[2]!.playbackRate = 1.5;
    const first = exportTimeline(project, 'edl');
    const imported = importTimeline(first, { fileName: 'cut.edl' });
    expect(imported.format).toBe('edl');
    const clips = imported.project.clips;
    expect(clips.map((c) => c.fileName)).toEqual(['demo-clip-a.mp4', 'demo-clip-b.mp4', 'demo-clip-a.mp4']);
    expect(clips.map((c) => [c.trimStart, c.trimEnd])).toEqual([
      [0, 3],
      [1, 4],
      [2, 5],
    ]);
    expect(clips[2]!.playbackRate).toBeCloseTo(1.5, 3);
    expect(imported.project.transitions).toEqual([{ afterClipIndex: 1, type: 'dissolve', duration: 1 }]);
    expect(exportTimeline(imported.project, 'edl')).toBe(first);
  });

  it('reads drop-frame EDLs and M2 speed lines from other tools', () => {
    const edl = [
      'TITLE: From Avid',
      'FCM: DROP FRAME',
      '',
      '001  TAPE01   V     C        01:00:10;00 01:00:12;00 01:00:00;00 01:00:02;00',
      'M2   TAPE01       059.9                01:00:10;00',
      '* FROM CLIP NAME: Interview.mov',
      '002  TAPE02   A     C        00:00:00;00 00:00:02;00 01:00:00;00 01:00:02;00',
      '* FROM CLIP NAME: Music.wav',
      '* LOC: 01:00:01;00 RED     beat',
    ].join('\n');
    const timeline = readEdl(edl);
    expect(timeline.rate.id).toBe('29.97df');
    expect(timeline.startFrame).toBe(107_892);
    const [video, audio] = timeline.tracks;
    const clip = video!.items[0]!;
    expect(clip.type === 'clip' && clip.media.name).toBe('Interview.mov');
    expect(clip.type === 'clip' && clip.speed).toBeCloseTo(59.9 / 30, 6);
    expect(audio!.role).toBe('audio');
    expect(timeline.markers).toEqual([{ frame: 30, duration: 0, name: 'beat' }]);
  });

  it('refuses text with no events and tags reels from file names', () => {
    expect(() => readEdl('TITLE: nothing\n')).toThrow(/No EDL events/);
    expect(reelName('my clip (2).mp4')).toBe('MYCLIP2');
    expect(reelName('.mp4')).toBe('AX');
  });

  it('writes the timeline at the project timecode rate', async () => {
    const project = await fixtureProject(XFADE);
    project.timecodeRate = '25';
    project.timecodeStart = '10:00:00:00';
    const edl = writeEdl((await import('./toInterchange')).toInterchange(project));
    expect(edl).toContain('* FRAME RATE: 25');
    expect(edl).toMatch(/^001 .* 10:00:00:00 10:00:02:00$/m);
  });
});
