import { describe, expect, it } from 'vitest';
import {
  buildAssDocument,
  captionsAtTime,
  detectSubtitleFormat,
  escapeAssText,
  ffmpegColorToAss,
  formatAssTimestamp,
  formatSrtTimestamp,
  normalizeCaptions,
  parseAss,
  parseSrt,
  parseSubtitleTimestamp,
  parseSubtitles,
  resolveCaptionStyle,
  serializeSrt,
  DEFAULT_CAPTION_STYLE,
  MIN_CAPTION_DURATION_SEC,
} from './subtitles';
import type { CaptionEntry } from '../types';

const BASIC_SRT = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
Second cue
`;

describe('parseSubtitleTimestamp', () => {
  it('parses SubRip milliseconds', () => {
    expect(parseSubtitleTimestamp('01:02:03,500')).toBeCloseTo(3723.5, 6);
  });

  it('parses SSA centiseconds by fraction width', () => {
    expect(parseSubtitleTimestamp('0:00:01.50')).toBeCloseTo(1.5, 6);
    expect(parseSubtitleTimestamp('0:00:01.5')).toBeCloseTo(1.5, 6);
  });

  it('treats the hours field as optional', () => {
    expect(parseSubtitleTimestamp('02:03,250')).toBeCloseTo(123.25, 6);
  });

  it('returns null for non-timestamps', () => {
    expect(parseSubtitleTimestamp('not a time')).toBeNull();
    expect(parseSubtitleTimestamp('')).toBeNull();
  });
});

describe('formatSrtTimestamp', () => {
  it('pads every field', () => {
    expect(formatSrtTimestamp(3723.5)).toBe('01:02:03,500');
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
  });

  it('rounds to milliseconds before splitting fields', () => {
    // 59.9999s must roll over to a whole minute, not produce ",1000".
    expect(formatSrtTimestamp(59.9999)).toBe('00:01:00,000');
  });

  it('clamps negative and non-finite input to zero', () => {
    expect(formatSrtTimestamp(-5)).toBe('00:00:00,000');
    expect(formatSrtTimestamp(Number.NaN)).toBe('00:00:00,000');
  });
});

describe('formatAssTimestamp', () => {
  it('uses SSA centisecond form with an unpadded hour', () => {
    expect(formatAssTimestamp(3723.5)).toBe('1:02:03.50');
    expect(formatAssTimestamp(0)).toBe('0:00:00.00');
  });
});

describe('parseSrt', () => {
  it('parses a well-formed file', () => {
    const captions = parseSrt(BASIC_SRT);
    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatchObject({
      startSec: 1,
      endSec: 3.5,
      text: 'Hello world',
    });
    expect(captions[1]).toMatchObject({ startSec: 4, endSec: 6, text: 'Second cue' });
    expect(captions[0].id).not.toBe(captions[1].id);
  });

  it('preserves multi-line cue text', () => {
    const captions = parseSrt(`1
00:00:01,000 --> 00:00:02,000
First line
Second line
Third line
`);
    expect(captions[0].text).toBe('First line\nSecond line\nThird line');
  });

  it('handles Windows line endings', () => {
    const captions = parseSrt(BASIC_SRT.replace(/\n/g, '\r\n'));
    expect(captions).toHaveLength(2);
    expect(captions[0].text).toBe('Hello world');
    expect(captions[0].text).not.toContain('\r');
  });

  it('handles lone carriage returns', () => {
    const captions = parseSrt(BASIC_SRT.replace(/\n/g, '\r'));
    expect(captions).toHaveLength(2);
    expect(captions[1].text).toBe('Second cue');
  });

  it('strips a UTF-8 BOM', () => {
    const captions = parseSrt(`﻿${BASIC_SRT}`);
    expect(captions).toHaveLength(2);
    expect(captions[0].startSec).toBe(1);
  });

  it('parses cues that are not separated by blank lines', () => {
    const captions = parseSrt(`1
00:00:01,000 --> 00:00:02,000
One
2
00:00:03,000 --> 00:00:04,000
Two
3
00:00:05,000 --> 00:00:06,000
Three`);
    expect(captions.map((c) => c.text)).toEqual(['One', 'Two', 'Three']);
    expect(captions.map((c) => c.startSec)).toEqual([1, 3, 5]);
  });

  it('keeps a trailing numeric line on the final cue', () => {
    // Nothing follows, so "42" is cue text rather than the next sequence number.
    const captions = parseSrt(`1
00:00:01,000 --> 00:00:02,000
The answer is
42`);
    expect(captions[0].text).toBe('The answer is\n42');
  });

  it('parses cues with no sequence numbers at all', () => {
    const captions = parseSrt(`00:00:01,000 --> 00:00:02,000
No number

00:00:03,000 --> 00:00:04,000
Still fine`);
    expect(captions.map((c) => c.text)).toEqual(['No number', 'Still fine']);
  });

  it('accepts dot separators and missing hour fields', () => {
    const captions = parseSrt(`1
00:01.000 --> 00:02.500
Loose timing`);
    expect(captions[0]).toMatchObject({ startSec: 1, endSec: 2.5 });
  });

  it('ignores trailing SubRip coordinates', () => {
    const captions = parseSrt(`1
00:00:01,000 --> 00:00:02,000  X1:100 X2:200 Y1:10 Y2:20
Positioned`);
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe('Positioned');
  });

  it('skips cues with empty text instead of emitting blanks', () => {
    const captions = parseSrt(`1
00:00:01,000 --> 00:00:02,000

2
00:00:03,000 --> 00:00:04,000
Real text`);
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe('Real text');
  });

  it('returns an empty list for empty or junk input', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseSrt('   \n\n  ')).toEqual([]);
    expect(parseSrt('not a subtitle file at all')).toEqual([]);
  });

  it('sorts out-of-order cues by start time', () => {
    const captions = parseSrt(`1
00:00:05,000 --> 00:00:06,000
Late

2
00:00:01,000 --> 00:00:02,000
Early`);
    expect(captions.map((c) => c.text)).toEqual(['Early', 'Late']);
  });

  it('widens zero-length cues to the minimum duration', () => {
    const captions = parseSrt(`1
00:00:01,000 --> 00:00:01,000
Instant`);
    expect(captions[0].endSec).toBeCloseTo(1 + MIN_CAPTION_DURATION_SEC, 6);
  });
});

describe('serializeSrt', () => {
  it('round-trips timings and text', () => {
    const captions = parseSrt(BASIC_SRT);
    const reparsed = parseSrt(serializeSrt(captions));
    expect(reparsed).toHaveLength(captions.length);
    reparsed.forEach((entry, index) => {
      expect(entry.startSec).toBeCloseTo(captions[index].startSec, 3);
      expect(entry.endSec).toBeCloseTo(captions[index].endSec, 3);
      expect(entry.text).toBe(captions[index].text);
    });
  });

  it('round-trips multi-line text edited in the UI', () => {
    const edited: CaptionEntry[] = [
      { id: 'a', startSec: 0.5, endSec: 2, text: 'Line one\nLine two' },
      { id: 'b', startSec: 2, endSec: 4.25, text: 'Solo' },
    ];
    const reparsed = parseSrt(serializeSrt(edited));
    expect(reparsed.map((c) => c.text)).toEqual(['Line one\nLine two', 'Solo']);
    expect(reparsed.map((c) => c.startSec)).toEqual([0.5, 2]);
    expect(reparsed.map((c) => c.endSec)).toEqual([2, 4.25]);
  });

  it('renumbers cues from one in sorted order', () => {
    const out = serializeSrt([
      { id: 'b', startSec: 3, endSec: 4, text: 'Second' },
      { id: 'a', startSec: 1, endSec: 2, text: 'First' },
    ]);
    expect(out.startsWith('1\n')).toBe(true);
    expect(out).toContain('\n2\n');
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
  });

  it('produces an empty string for no captions', () => {
    expect(serializeSrt([])).toBe('');
  });
});

describe('parseAss', () => {
  const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Roboto,36

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\an8}Styled, with a comma
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,Not rendered
`;

  it('parses dialogue rows and skips comments', () => {
    const captions = parseAss(ASS);
    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatchObject({ startSec: 1, endSec: 3.5, text: 'Hello world' });
  });

  it('strips override tags and keeps commas in the text field', () => {
    const captions = parseAss(ASS);
    expect(captions[1].text).toBe('Styled, with a comma');
  });

  it('converts \\N and \\h escapes', () => {
    const captions = parseAss(`[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Top\\NBottom\\hspaced`);
    expect(captions[0].text).toBe('Top\nBottom spaced');
  });

  it('honours a reordered Format line', () => {
    const captions = parseAss(`[Events]
Format: Start, End, Style, Text
Dialogue: 0:00:02.00,0:00:04.00,Default,Reordered fields`);
    expect(captions[0]).toMatchObject({ startSec: 2, endSec: 4, text: 'Reordered fields' });
  });

  it('falls back to the v4+ field order when Format is missing', () => {
    const captions = parseAss(`[Events]
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,No format line`);
    expect(captions[0].text).toBe('No format line');
  });

  it('ignores dialogue outside the Events section', () => {
    const captions = parseAss(`[Script Info]
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Wrong section`);
    expect(captions).toEqual([]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseAss('')).toEqual([]);
  });
});

describe('detectSubtitleFormat / parseSubtitles', () => {
  it('prefers the file extension', () => {
    expect(detectSubtitleFormat(BASIC_SRT, 'movie.srt')).toBe('srt');
    expect(detectSubtitleFormat('', 'movie.ASS')).toBe('ass');
    expect(detectSubtitleFormat('', 'movie.ssa')).toBe('ass');
  });

  it('sniffs ASS section headers when there is no filename', () => {
    expect(detectSubtitleFormat('[Script Info]\nScriptType: v4.00+')).toBe('ass');
    expect(detectSubtitleFormat(BASIC_SRT)).toBe('srt');
  });

  it('dispatches to the matching parser', () => {
    expect(parseSubtitles(BASIC_SRT, 'a.srt')).toHaveLength(2);
    expect(
      parseSubtitles(
        `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi`,
        'a.ass',
      ),
    ).toHaveLength(1);
  });
});

describe('normalizeCaptions', () => {
  it('clamps negative starts and enforces a minimum duration', () => {
    const [entry] = normalizeCaptions([
      { id: 'a', startSec: -2, endSec: -5, text: 'x' },
    ]);
    expect(entry.startSec).toBe(0);
    expect(entry.endSec).toBeCloseTo(MIN_CAPTION_DURATION_SEC, 6);
  });

  it('leaves overlapping cues overlapping', () => {
    const out = normalizeCaptions([
      { id: 'a', startSec: 0, endSec: 5, text: 'a' },
      { id: 'b', startSec: 2, endSec: 7, text: 'b' },
    ]);
    expect(out.map((c) => c.endSec)).toEqual([5, 7]);
  });
});

describe('captionsAtTime', () => {
  const captions: CaptionEntry[] = [
    { id: 'a', startSec: 0, endSec: 2, text: 'a' },
    { id: 'b', startSec: 1, endSec: 3, text: 'b' },
  ];

  it('returns every cue covering the time', () => {
    expect(captionsAtTime(captions, 1.5).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('treats the end time as exclusive', () => {
    expect(captionsAtTime(captions, 2).map((c) => c.id)).toEqual(['b']);
    expect(captionsAtTime(captions, 3)).toEqual([]);
  });
});

describe('resolveCaptionStyle', () => {
  it('layers cue over project over defaults', () => {
    const style = resolveCaptionStyle(
      { style: { fontsize: 64 } },
      { fontcolor: '#ff0000' },
    );
    expect(style.fontsize).toBe(64);
    expect(style.fontcolor).toBe('#ff0000');
    expect(style.boxColor).toBe(DEFAULT_CAPTION_STYLE.boxColor);
  });
});

describe('ffmpegColorToAss', () => {
  it('reverses the channel order and inverts alpha', () => {
    expect(ffmpegColorToAss('#ffffff')).toBe('&H00FFFFFF');
    expect(ffmpegColorToAss('#ff0000')).toBe('&H000000FF');
    expect(ffmpegColorToAss('#0000ff')).toBe('&H00FF0000');
  });

  it('maps an @alpha suffix to ASS transparency', () => {
    expect(ffmpegColorToAss('black@0.5')).toBe('&H80000000');
    expect(ffmpegColorToAss('black')).toBe('&H00000000');
  });
});

describe('escapeAssText', () => {
  it('escapes braces and turns newlines into hard breaks', () => {
    expect(escapeAssText('a{b}c')).toBe('a\\{b\\}c');
    expect(escapeAssText('one\ntwo')).toBe('one\\Ntwo');
    expect(escapeAssText('one\r\ntwo')).toBe('one\\Ntwo');
  });
});

describe('buildAssDocument', () => {
  const captions: CaptionEntry[] = [
    { id: 'a', startSec: 1, endSec: 2, text: 'Plain' },
    { id: 'b', startSec: 3, endSec: 4, text: 'Big', style: { fontsize: 72 } },
  ];

  it('emits PlayRes matching the output size', () => {
    const doc = buildAssDocument(captions, { width: 1920, height: 1080 });
    expect(doc).toContain('PlayResX: 1920');
    expect(doc).toContain('PlayResY: 1080');
  });

  it('positions cues in PlayRes pixels from the normalized style', () => {
    const doc = buildAssDocument([captions[0]], { width: 1280, height: 720 });
    // Defaults: x 0.5, y 0.92 → centre 640, bottom 662.
    expect(doc).toContain('{\\pos(640,662)}Plain');
  });

  it('adds one extra Style row per distinct per-cue override', () => {
    const doc = buildAssDocument(
      [
        captions[0],
        captions[1],
        { id: 'c', startSec: 5, endSec: 6, text: 'Also big', style: { fontsize: 72 } },
      ],
      { width: 1280, height: 720 },
    );
    const styleRows = doc.split('\n').filter((l) => l.startsWith('Style: '));
    expect(styleRows).toHaveLength(2);
    expect(doc.match(/,Cue1,,/g)).toHaveLength(2);
  });

  it('uses the box border style only when the style asks for a box', () => {
    const boxed = buildAssDocument([], {
      width: 1280,
      height: 720,
      projectStyle: { box: true },
    });
    const plain = buildAssDocument([], {
      width: 1280,
      height: 720,
      projectStyle: { box: false },
    });
    // Style: rows follow the Format order — BorderStyle is the 16th field.
    const borderStyleOf = (doc: string) =>
      doc.split('\n').find((l) => l.startsWith('Style: '))!.split(',')[15];
    expect(borderStyleOf(boxed)).toBe('3');
    expect(borderStyleOf(plain)).toBe('1');
  });

  it('sets the bold flag for the bold Roboto rather than renaming the family', () => {
    const doc = buildAssDocument([], {
      width: 1280,
      height: 720,
      projectStyle: { font: 'robotoBold' },
    });
    const row = doc.split('\n').find((l) => l.startsWith('Style: '))!.split(',');
    expect(row[1]).toBe('Roboto');
    expect(row[7]).toBe('-1');
  });

  it('emits dialogue rows in sorted order', () => {
    const doc = buildAssDocument(
      [
        { id: 'b', startSec: 5, endSec: 6, text: 'Late' },
        { id: 'a', startSec: 1, endSec: 2, text: 'Early' },
      ],
      { width: 1280, height: 720 },
    );
    expect(doc.indexOf('Early')).toBeLessThan(doc.indexOf('Late'));
  });
});
