import { describe, expect, it } from 'vitest';
import type { MasterAudio } from '../types';
import { applyProjectData, serializeProject } from './project';
import { createTestClip } from './project.test.helpers';

function makeMasterAudio(overrides: Partial<MasterAudio> = {}): MasterAudio {
  const file = new File([], 'song.mp3', { type: 'audio/mpeg' });
  return {
    file,
    objectUrl: 'blob:song',
    fileName: 'song.mp3',
    duration: 30,
    startTime: 0,
    ...overrides,
  };
}

describe('project tempo metadata roundtrip', () => {
  it('roundtrips clip bpmOverride, bpmEstimate and bpmConfidence', async () => {
    const clip = createTestClip('a', 5, 'Clip A');
    clip.beatTimestamps = [0.5, 1, 1.5, 2];
    clip.bpmEstimate = 120;
    clip.bpmConfidence = 0.82;
    clip.bpmOverride = 128;

    const serialized = serializeProject([clip], [], [], []);
    expect(serialized.clips[0].bpmOverride).toBe(128);
    expect(serialized.clips[0].bpmConfidence).toBe(0.82);

    const result = await applyProjectData(serialized, [createTestClip('a', 5, 'Clip A')]);
    expect(result.clips[0].bpmEstimate).toBe(120);
    expect(result.clips[0].bpmConfidence).toBe(0.82);
    expect(result.clips[0].bpmOverride).toBe(128);
    expect(result.clips[0].beatTimestamps).toEqual([0.5, 1, 1.5, 2]);
  });

  it('omits the tempo fields when the clip has none', () => {
    const serialized = serializeProject([createTestClip('a', 5)], [], [], []);
    expect(serialized.clips[0]).not.toHaveProperty('bpmOverride');
    expect(serialized.clips[0]).not.toHaveProperty('bpmConfidence');
  });

  it('roundtrips master audio beats and BPM', async () => {
    const clip = createTestClip('a', 5);
    const masterAudio = makeMasterAudio({
      beatTimestamps: [0, 0.5, 1, 1.5],
      bpmEstimate: 120,
      bpmConfidence: 0.9,
      startTime: 2,
    });

    const serialized = serializeProject(
      [clip],
      [],
      [],
      [],
      undefined,
      [],
      undefined,
      masterAudio,
    );
    expect(serialized.masterAudio?.beatTimestamps).toEqual([0, 0.5, 1, 1.5]);
    expect(serialized.masterAudio?.bpmEstimate).toBe(120);

    // The master file is not among the project clips, so restore it from bytes.
    serialized.masterAudio!.sourceMediaDataUrl = 'data:audio/mpeg;base64,';
    const restored = await applyProjectData(serialized, [clip]);
    expect(restored.masterAudio?.bpmEstimate).toBe(120);
    expect(restored.masterAudio?.bpmConfidence).toBe(0.9);
    expect(restored.masterAudio?.beatTimestamps).toEqual([0, 0.5, 1, 1.5]);
    expect(restored.masterAudio?.startTime).toBe(2);
  });

  it('leaves master audio without tempo when the project has none', async () => {
    const clip = createTestClip('a', 5);
    const serialized = serializeProject(
      [clip],
      [],
      [],
      [],
      undefined,
      [],
      undefined,
      makeMasterAudio(),
    );
    serialized.masterAudio!.sourceMediaDataUrl = 'data:audio/mpeg;base64,';
    const restored = await applyProjectData(serialized, [clip]);
    expect(restored.masterAudio).not.toBeNull();
    expect(restored.masterAudio?.bpmEstimate).toBeUndefined();
    expect(restored.masterAudio?.beatTimestamps).toBeUndefined();
  });
});
