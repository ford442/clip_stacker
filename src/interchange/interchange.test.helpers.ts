import type { Clip, Project } from '../types';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { serializeProject } from '../project/serialize';
import { selectProjectSnapshot } from '../project/snapshot';
import { buildFixture, type HarnessFixtureSpec } from '../app/testHarness/fixtureBuilder';
import { GOLDEN_CASES } from '../../e2e/fixtures';

let nextId = 0;

/** A stand-in for a bundled demo clip: same name, length and size, no bytes. */
export function demoStandIn(demo: 'a' | 'b'): Clip {
  nextId += 1;
  const name = `demo-clip-${demo}.mp4`;
  return {
    id: `clip-${demo}-${nextId}`,
    file: new File([], name, { type: 'video/mp4' }),
    objectUrl: `blob:test/${nextId}`,
    title: name,
    kind: 'video',
    duration: 6,
    videoWidth: 640,
    videoHeight: 360,
    hasAudio: true,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

/** The saved project a golden fixture builds (stand-in media). */
export async function fixtureProject(spec: Record<string, unknown>): Promise<Project> {
  __resetEditorStoreForTests();
  nextId = 0;
  await buildFixture(spec as unknown as HarnessFixtureSpec, async (demo) => demoStandIn(demo));
  const settings = settingsStore.getState();
  return serializeProject(selectProjectSnapshot(editorStore.getState(), settings), {
    layoutReferenceResolution: settings.exportSettings.outputResolution,
  });
}

export const FIXTURE_CASES = GOLDEN_CASES;

/** A project with its clip pool in id order (load order is not part of a project's meaning). */
export function normalizedProject(project: Project): unknown {
  return JSON.parse(JSON.stringify({ ...project, clips: [...project.clips].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }));
}
