import { describe, expect, it } from 'vitest';
import { INTERCHANGE_MAPPING, agreeing, sortKeys, stableJson } from './mapping';
import { detectInterchangeFormat, importTimeline } from './index';

describe('interchange mapping table', () => {
  it('has a row per concept, each saying what every format does', () => {
    const concepts = INTERCHANGE_MAPPING.map((row) => row.concept);
    for (const concept of ['Main video lane', 'Base-lane transition', 'Captions', 'Nested sequence', 'Media', 'Lane mute', 'Constant speed']) {
      expect(concepts.some((c) => c.startsWith(concept))).toBe(true);
    }
    for (const row of INTERCHANGE_MAPPING) {
      expect(row.otio && row.fcpxml && row.edl && row.note).toBeTruthy();
    }
    expect(new Set(concepts).size).toBe(concepts.length);
  });

  it('trusts exact metadata only while it agrees with the file', () => {
    expect(agreeing(1.234, 1.2333, 1 / 30)).toBe(1.234);
    expect(agreeing(1.234, 2, 1 / 30)).toBe(2);
    expect(agreeing(null, 2, 1 / 30)).toBe(2);
  });

  it('writes metadata with sorted keys and no undefined fields', () => {
    expect(stableJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}]},"b":1}');
    expect(sortKeys(null)).toBeNull();
  });
});

describe('detectInterchangeFormat', () => {
  it('goes by extension, then content', () => {
    expect(detectInterchangeFormat('', 'cut.OTIO')).toBe('otio');
    expect(detectInterchangeFormat('', 'cut.fcpxml')).toBe('fcpxml');
    expect(detectInterchangeFormat('{"OTIO_SCHEMA": "Timeline.1"}')).toBe('otio');
    expect(detectInterchangeFormat('<?xml version="1.0"?>\n<fcpxml version="1.10">')).toBe('fcpxml');
    expect(detectInterchangeFormat('TITLE: x\nFCM: NON-DROP FRAME\n')).toBe('edl');
    expect(detectInterchangeFormat('hello')).toBeNull();
    expect(() => importTimeline('hello')).toThrow(/Not a timeline file/);
  });
});
