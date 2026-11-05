import { describe, expect, it } from 'vitest';
import { classifyErrors, parseTscErrors } from './check-strict.mjs';

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

  it('counts strict dirs by path segment and leaves tests out', () => {
    const result = classifyErrors(parseTscErrors(output), { strictDirs: ['src/export'], baseline: 0 });
    expect(result.strict.map((e) => e.file)).toEqual(['src/export/a.ts']);
    expect(result.elsewhere.map((e) => e.file)).toEqual(['src/exporter/b.ts', 'src/webgpu/c.ts']);
    expect(result.tests).toBe(1);
  });
});
