import { describe, expect, it } from 'vitest';
import { classifyErrors, countByDir, parseTscErrors } from './check-strict.mjs';

describe('check-strict', () => {
  const output = [
    "src/export/a.ts(3,5): error TS2532: Object is possibly 'undefined'.",
    "src/export/a.test.ts(9,1): error TS2532: Object is possibly 'undefined'.",
    "src/exporter/b.ts(1,1): error TS18048: 'x' is possibly 'undefined'.",
    'src/webgpu/c.ts(2,2): error TS2375: Type mismatch.',
    'not an error line',
  ].join('\n');

  it('parses tsc --pretty false lines', () => {
    expect(parseTscErrors(output).map((e) => [e.file, e.line, e.code])).toEqual([
      ['src/export/a.ts', 3, 'TS2532'],
      ['src/export/a.test.ts', 9, 'TS2532'],
      ['src/exporter/b.ts', 1, 'TS18048'],
      ['src/webgpu/c.ts', 2, 'TS2375'],
    ]);
  });

  it('matches strict dirs by path segment and counts tests', () => {
    const result = classifyErrors(parseTscErrors(output), { strictDirs: ['src/export'] });
    expect(result.strict.map((e) => e.file)).toEqual(['src/export/a.ts', 'src/export/a.test.ts']);
    expect(result.elsewhere.map((e) => e.file)).toEqual(['src/exporter/b.ts', 'src/webgpu/c.ts']);
  });

  it('treats src as every file under it', () => {
    const result = classifyErrors(parseTscErrors(output), { strictDirs: ['src'] });
    expect(result.strict).toHaveLength(4);
    expect(result.elsewhere).toHaveLength(0);
  });

  it('counts errors per top-level directory', () => {
    expect(countByDir(parseTscErrors(output))).toEqual([
      ['src/export', 2],
      ['src/exporter', 1],
      ['src/webgpu', 1],
    ]);
  });
});

describe('check-strict excludeTests', () => {
  it('reports test-file errors without counting them', () => {
    const errors = parseTscErrors(
      ["src/a/x.ts(1,1): error TS2532: m", "src/a/x.test.ts(1,1): error TS2532: m", "src/a/h.test.helpers.ts(1,1): error TS2532: m"].join('\n'),
    );
    const result = classifyErrors(errors, { strictDirs: [], excludeTests: true });
    expect(result.elsewhere.map((e) => e.file)).toEqual(['src/a/x.ts']);
    expect(result.tests).toBe(2);
  });
});
