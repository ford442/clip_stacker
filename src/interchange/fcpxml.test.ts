import { describe, expect, it } from 'vitest';
import { writeFcpxml } from './fcpxml';
import { readFcpxml } from './fcpxmlRead';
import { toInterchange } from './toInterchange';
import { fromInterchange } from './fromInterchange';
import { FIXTURE_CASES, fixtureProject, normalizedProject } from './interchange.test.helpers';

describe('FCPXML round trip', () => {
  it.each(FIXTURE_CASES.map((c) => [c.name, c.spec] as const))('%s: export → import → export is byte-identical', async (_name, spec) => {
    const project = await fixtureProject(spec);
    const first = writeFcpxml(toInterchange(project));
    const imported = fromInterchange(readFcpxml(first)).project;
    expect(writeFcpxml(toInterchange(imported))).toBe(first);
    expect(normalizedProject(imported)).toEqual(normalizedProject(project));
  });
});
