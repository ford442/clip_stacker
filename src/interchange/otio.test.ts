import { describe, expect, it } from 'vitest';
import { readOtio, writeOtio } from './otio';
import { toInterchange } from './toInterchange';
import { fromInterchange } from './fromInterchange';
import { FIXTURE_CASES, fixtureProject } from './interchange.test.helpers';

describe('OTIO round trip', () => {
  it.each(FIXTURE_CASES.map((c) => [c.name, c.spec] as const))('%s: export → import → export is byte-identical', async (_name, spec) => {
    const project = await fixtureProject(spec);
    const first = writeOtio(toInterchange(project));
    const imported = fromInterchange(readOtio(first)).project;
    const second = writeOtio(toInterchange(imported));
    expect(second).toBe(first);
  });
});
