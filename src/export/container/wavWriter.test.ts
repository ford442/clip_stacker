import { describe, expect, it } from 'vitest';
import { createWavWriter, encodeWav, timeReferenceSamples, type WavWriterOptions } from './wavWriter';

interface RiffChunk {
  id: string;
  offset: number;
  size: number;
  payload: Uint8Array;
}

/** A strict RIFF reader: every chunk on an even offset, pad bytes zero, sizes adding up to the file. */
function parseRiff(bytes: Uint8Array): { riffSize: number; form: string; chunks: RiffChunk[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCc = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  expect(fourCc(0)).toBe('RIFF');
  const riffSize = view.getUint32(4, true);
  expect(riffSize).toBe(bytes.length - 8);
  expect(bytes.length % 2).toBe(0);
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset < bytes.length) {
    expect(offset % 2).toBe(0);
    const size = view.getUint32(offset + 4, true);
    expect(offset + 8 + size).toBeLessThanOrEqual(bytes.length);
    chunks.push({ id: fourCc(offset), offset, size, payload: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size;
    if (size % 2 === 1) {
      expect(bytes[offset]).toBe(0);
      offset += 1;
    }
  }
  expect(offset).toBe(bytes.length);
  return { riffSize, form: fourCc(8), chunks };
}

function chunk(bytes: Uint8Array, id: string): RiffChunk {
  const found = parseRiff(bytes).chunks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} chunk`);
  return found;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Byte equality without a per-element deep diff (the streamed files are megabytes). */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  let mismatch = -1;
  for (let i = 0; i < actual.length && mismatch === -1; i++) if (actual[i] !== expected[i]) mismatch = i;
  expect(mismatch).toBe(-1);
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function pcm24Values(bytes: Uint8Array): number[] {
  const data = chunk(bytes, 'data').payload;
  const values: number[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    values.push(((data[i + 2]! << 24) | (data[i + 1]! << 16) | (data[i]! << 8)) >> 8);
  }
  return values;
}

function asciiField(payload: Uint8Array, offset: number, width: number): string {
  const field = payload.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return String.fromCharCode(...(end === -1 ? field : field.subarray(0, end)));
}

/** Deterministic noise in [-1.2, 1.2] (some samples clip). */
function noise(samples: number, seed = 1): Float32Array {
  const out = new Float32Array(samples);
  let state = seed >>> 0;
  for (let i = 0; i < samples; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state / 0xffffffff) * 2.4 - 1.2;
  }
  return out;
}

const FIXED = {
  trackName: 'Dialogue',
  bext: { originationDate: '2026-11-19', originationTime: '10:20:30' },
} satisfies WavWriterOptions;

const CODING_HISTORY = 'A=PCM,F=48000,W=24,M=stereo,T=Clip Stacker\r\n';

describe('encodeWav (24-bit PCM)', () => {
  const file = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), FIXED);

  it('starts with the reference RIFF / fmt header and ends with the data chunk', () => {
    const header = [
      ...ascii('RIFF'), ...u32(file.length - 8), ...ascii('WAVE'),
      ...ascii('fmt '), ...u32(16),
      ...u16(1), // WAVE_FORMAT_PCM
      ...u16(2), // channels
      ...u32(48000), // sample rate
      ...u32(48000 * 6), // byte rate
      ...u16(6), // block align
      ...u16(24), // bits per sample
      ...ascii('bext'), ...u32(602 + CODING_HISTORY.length),
    ];
    expect([...file.subarray(0, header.length)]).toEqual(header);
    expect([...file.subarray(file.length - 20)]).toEqual([
      ...ascii('data'), ...u32(12),
      0x00, 0x00, 0x00, // 0
      0x00, 0x00, 0x40, // +0.5 → 4 194 304 (4 194 303.5 rounds away from zero)
      0x00, 0x00, 0xc0, // −0.5 → −4 194 304
      0xff, 0xff, 0x7f, // +1 → 8 388 607
    ]);
  });

  it('writes fmt, bext, iXML, data in order, word aligned, with patched sizes', () => {
    const riff = parseRiff(file);
    expect(riff.form).toBe('WAVE');
    expect(riff.chunks.map((c) => c.id)).toEqual(['fmt ', 'bext', 'iXML', 'data']);
    expect(riff.chunks.every((c) => c.offset % 2 === 0)).toBe(true);
    expect(chunk(file, 'data').size).toBe(12);
    expect(chunk(file, 'iXML').size % 2).toBe(0);
  });

  it('fills the bext fields at their EBU Tech 3285 offsets', () => {
    const tc = timeReferenceSamples(3600, 48000);
    const bext = chunk(encodeWav(new Float32Array(2), { ...FIXED, timeReference: tc }), 'bext').payload;
    const view = new DataView(bext.buffer, bext.byteOffset, bext.byteLength);
    expect(asciiField(bext, 0, 256)).toBe('Dialogue');
    expect(asciiField(bext, 256, 32)).toBe('Clip Stacker');
    expect(asciiField(bext, 288, 32)).toBe('');
    expect(asciiField(bext, 320, 10)).toBe('2026-11-19');
    expect(asciiField(bext, 330, 8)).toBe('10:20:30');
    expect(view.getUint32(338, true)).toBe(172_800_000);
    expect(view.getUint32(342, true)).toBe(0);
    expect(view.getUint16(346, true)).toBe(1);
    expect(bext.subarray(348, 602).every((b) => b === 0)).toBe(true); // UMID, v1 reserved
    expect(String.fromCharCode(...bext.subarray(602))).toBe(CODING_HISTORY);
  });

  it('splits a TimeReference past 32 bits into its low and high words', () => {
    const timeReference = 3 * 2 ** 32 + 5;
    const bext = chunk(encodeWav(new Float32Array(2), { ...FIXED, timeReference }), 'bext').payload;
    const view = new DataView(bext.buffer, bext.byteOffset, bext.byteLength);
    expect(view.getUint32(338, true)).toBe(5);
    expect(view.getUint32(342, true)).toBe(3);
    const xml = new TextDecoder().decode(chunk(encodeWav(new Float32Array(2), { ...FIXED, timeReference }), 'iXML').payload);
    expect(xml).toContain('<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>3</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>');
    expect(xml).toContain('<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>5</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>');
  });

  it('writes a version 2 bext with loudness ×100 and 0x7FFF for what was not measured', () => {
    const bext = chunk(
      encodeWav(new Float32Array(2), {
        ...FIXED,
        bext: {
          ...FIXED.bext,
          loudness: { integrated: -23, range: 7.25, maxTruePeak: -1, maxMomentary: Number.NaN, maxShortTerm: -Infinity },
        },
      }),
      'bext',
    ).payload;
    const view = new DataView(bext.buffer, bext.byteOffset, bext.byteLength);
    expect(view.getUint16(346, true)).toBe(2);
    expect([412, 414, 416, 418, 420].map((o) => view.getInt16(o, true))).toEqual([-2300, 725, -100, 0x7fff, -32768]);
    expect(bext.subarray(422, 602).every((b) => b === 0)).toBe(true);
    const partial = chunk(encodeWav(new Float32Array(2), { ...FIXED, bext: { ...FIXED.bext, loudness: {} } }), 'bext');
    const partialView = new DataView(partial.payload.buffer, partial.payload.byteOffset);
    expect([412, 414, 416, 418, 420].map((o) => partialView.getInt16(o, true))).toEqual(Array(5).fill(0x7fff));
  });

  it('NUL-pads the coding history to an even length and maps non-ASCII text', () => {
    const bext = chunk(
      encodeWav(new Float32Array(1), {
        channels: 1,
        bext: {
          ...FIXED.bext,
          description: 'Café\nmix',
          originator: 'x'.repeat(40),
          codingHistory: 'A=PCM,F=48000,W=24,M=mono,T=Tests',
        },
      }),
      'bext',
    );
    expect(bext.size % 2).toBe(0);
    expect(asciiField(bext.payload, 0, 256)).toBe('Caf? mix');
    expect(asciiField(bext.payload, 256, 32)).toBe('x'.repeat(32));
    expect(String.fromCharCode(...bext.payload.subarray(602))).toBe('A=PCM,F=48000,W=24,M=mono,T=Tests\r\n\0');
  });

  it('converts samples with rounding, clamping and NaN → 0', () => {
    const lsb = 1 / 8388607;
    const input = [
      1, -1, 2, -2, Math.fround(-1.0000001), Number.NaN, Infinity, -Infinity, 0.5, -0.5, 0, -0,
      1.4 * lsb, 1.6 * lsb, -1.4 * lsb, -1.6 * lsb,
    ];
    expect(pcm24Values(encodeWav(new Float32Array(input), { ...FIXED, channels: 1 }))).toEqual([
      8388607, -8388607, 8388607, -8388608, -8388608, 0, 8388607, -8388608, 4194304, -4194304, 0, 0, 1, 2, -1, -2,
    ]);
  });

  it('pads an odd-sized data chunk with one zero byte the sizes account for', () => {
    const odd = encodeWav(new Float32Array([0.25, -0.25, 1]), { ...FIXED, channels: 1 });
    const data = chunk(odd, 'data');
    expect(data.size).toBe(9);
    expect(data.offset + 8 + 9 + 1).toBe(odd.length);
    expect(odd[odd.length - 1]).toBe(0);
    expect(parseRiff(odd).riffSize).toBe(odd.length - 8);
  });
});

describe('iXML', () => {
  it('writes the BWFXML document with speed, timestamp and one track per channel', () => {
    const xml = new TextDecoder().decode(
      chunk(
        encodeWav(new Float32Array(2), {
          ...FIXED,
          timeReference: 172_800_000,
          ixml: { project: 'Demo', scene: '12A', take: '3', tape: 'T01', note: 'stem', frameRate: 25 },
        }),
        'iXML',
      ).payload,
    );
    expect(xml.trimEnd()).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<BWFXML>',
        '  <IXML_VERSION>1.61</IXML_VERSION>',
        '  <PROJECT>Demo</PROJECT>',
        '  <SCENE>12A</SCENE>',
        '  <TAKE>3</TAKE>',
        '  <TAPE>T01</TAPE>',
        '  <NOTE>stem</NOTE>',
        '  <SPEED>',
        '    <MASTER_SPEED>25/1</MASTER_SPEED>',
        '    <CURRENT_SPEED>25/1</CURRENT_SPEED>',
        '    <TIMECODE_RATE>25/1</TIMECODE_RATE>',
        '    <TIMECODE_FLAG>NDF</TIMECODE_FLAG>',
        '    <FILE_SAMPLE_RATE>48000</FILE_SAMPLE_RATE>',
        '    <AUDIO_BIT_DEPTH>24</AUDIO_BIT_DEPTH>',
        '    <DIGITIZER_SAMPLE_RATE>48000</DIGITIZER_SAMPLE_RATE>',
        '    <TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>0</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>',
        '    <TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>172800000</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>',
        '    <TIMESTAMP_SAMPLE_RATE>48000</TIMESTAMP_SAMPLE_RATE>',
        '  </SPEED>',
        '  <TRACK_LIST>',
        '    <TRACK_COUNT>2</TRACK_COUNT>',
        '    <TRACK>',
        '      <CHANNEL_INDEX>1</CHANNEL_INDEX>',
        '      <INTERLEAVE_INDEX>1</INTERLEAVE_INDEX>',
        '      <NAME>Dialogue L</NAME>',
        '    </TRACK>',
        '    <TRACK>',
        '      <CHANNEL_INDEX>2</CHANNEL_INDEX>',
        '      <INTERLEAVE_INDEX>2</INTERLEAVE_INDEX>',
        '      <NAME>Dialogue R</NAME>',
        '    </TRACK>',
        '  </TRACK_LIST>',
        '</BWFXML>',
      ].join('\n'),
    );
  });

  it('escapes XML text, drops forbidden characters and keeps UTF-8', () => {
    const xml = new TextDecoder().decode(
      chunk(
        encodeWav(new Float32Array(1), {
          channels: 1,
          trackName: 'Böse <Mädchen> & "Co" \'s',
          ixml: { project: 'a\u0001b￿c' },
          bext: FIXED.bext,
        }),
        'iXML',
      ).payload,
    );
    expect(xml).toContain('<PROJECT>abc</PROJECT>');
    expect(xml).toContain('<TRACK_COUNT>1</TRACK_COUNT>');
    expect(xml).toContain('<NAME>Böse &lt;Mädchen&gt; &amp; &quot;Co&quot; &apos;s</NAME>');
    expect(xml).not.toContain('<SCENE>');
  });

  it('writes NTSC rates as x000/1001 and the drop-frame flag', () => {
    const xml = new TextDecoder().decode(
      chunk(encodeWav(new Float32Array(2), { ...FIXED, ixml: { frameRate: 29.97, dropFrame: true } }), 'iXML').payload,
    );
    expect(xml).toContain('<MASTER_SPEED>30000/1001</MASTER_SPEED>');
    expect(xml).toContain('<TIMECODE_FLAG>DF</TIMECODE_FLAG>');
    const film = new TextDecoder().decode(
      chunk(encodeWav(new Float32Array(2), { ...FIXED, ixml: { frameRate: { numerator: 24000, denominator: 1001 } } }), 'iXML')
        .payload,
    );
    expect(film).toContain('<TIMECODE_RATE>24000/1001</TIMECODE_RATE>');
  });

  it('keeps the chunk even whatever the text length', () => {
    const texts = ['a', 'ab'].map((project) => {
      const ixml = chunk(encodeWav(new Float32Array(2), { ...FIXED, ixml: { project } }), 'iXML');
      expect(ixml.size % 2).toBe(0);
      return new TextDecoder().decode(ixml.payload);
    });
    // The two texts differ by one byte, so exactly one took the pad newline.
    expect(texts.filter((text) => text.endsWith('</BWFXML>\n\n'))).toHaveLength(1);
    expect(texts.every((text) => text.endsWith('</BWFXML>\n') || text.endsWith('</BWFXML>\n\n'))).toBe(true);
  });
});

describe('encodeWav (32-bit float)', () => {
  it('writes WAVE_FORMAT_IEEE_FLOAT with cbSize, a fact chunk and the floats bit for bit', () => {
    const bits = new Uint32Array([0x3fc00000, 0x80000000, 0x7f800000, 0x7fc00001, 0x00000001, 0xbf800000]);
    const samples = new Float32Array(bits.buffer);
    const file = encodeWav(samples, { ...FIXED, format: 'float32' });
    const riff = parseRiff(file);
    expect(riff.chunks.map((c) => c.id)).toEqual(['fmt ', 'bext', 'iXML', 'fact', 'data']);
    const fmt = chunk(file, 'fmt ');
    expect(fmt.size).toBe(18);
    expect([...fmt.payload]).toEqual([
      ...u16(3), ...u16(2), ...u32(48000), ...u32(48000 * 8), ...u16(8), ...u16(32), ...u16(0),
    ]);
    expect([...chunk(file, 'fact').payload]).toEqual(u32(3));
    expect([...chunk(file, 'data').payload]).toEqual([...new Uint8Array(bits.buffer)]);
    const history = String.fromCharCode(...chunk(file, 'bext').payload.subarray(602));
    expect(history).toBe('A=PCM,F=48000,W=32,M=stereo,T=Clip Stacker\r\n');
    expect(new TextDecoder().decode(chunk(file, 'iXML').payload)).toContain('<AUDIO_BIT_DEPTH>32</AUDIO_BIT_DEPTH>');
  });

  it('reads float data from a view at an offset', () => {
    const backing = new Float32Array([9, 0.25, -0.75, 9]);
    const file = encodeWav(backing.subarray(1, 3), { ...FIXED, channels: 1, format: 'float32' });
    expect([...new Float32Array(chunk(file, 'data').payload.slice().buffer)]).toEqual([0.25, -0.75]);
  });
});

describe('createWavWriter', () => {
  for (const format of ['pcm24', 'float32'] as const) {
    it(`streams the same bytes as the one-shot encoder (${format})`, () => {
      const options: WavWriterOptions = { ...FIXED, format, timeReference: 1234 };
      const signal = noise(2 * 300_000, format === 'pcm24' ? 1 : 2); // > 1 MiB of PCM: several blocks
      const writer = createWavWriter(options);
      const frameSizes = [1, 7, 1000, 0, 174_763, 3, 65_536];
      let frame = 0;
      for (let i = 0; frame < 300_000; i++) {
        const frames = Math.min(frameSizes[i % frameSizes.length]!, 300_000 - frame);
        writer.write(signal.subarray(frame * 2, (frame + frames) * 2));
        frame += frames;
        expect(writer.frames).toBe(frame);
      }
      const file = writer.finish();
      const streamed = concat(file.parts);
      expect(file.frames).toBe(300_000);
      expect(file.byteLength).toBe(streamed.length);
      expect(file.parts.length).toBeGreaterThan(2);
      expectSameBytes(streamed, encodeWav(signal, options));
      expect(chunk(streamed, 'data').size).toBe(300_000 * 2 * (format === 'pcm24' ? 3 : 4));
    });
  }

  it('patches the sizes and pad byte of an odd mono file', () => {
    const writer = createWavWriter({ ...FIXED, channels: 1 });
    writer.write(new Float32Array([0.1, 0.2]));
    writer.write(new Float32Array([0.3]));
    const file = writer.finish();
    const bytes = concat(file.parts);
    expect(file.parts.at(-1)).toEqual(new Uint8Array(1));
    expect(chunk(bytes, 'data').size).toBe(9);
    expect(bytes).toEqual(encodeWav(new Float32Array([0.1, 0.2, 0.3]), { ...FIXED, channels: 1 }));
  });

  it('writes a valid empty file', () => {
    const file = createWavWriter({ ...FIXED, format: 'float32' }).finish();
    const bytes = concat(file.parts);
    expect(file.frames).toBe(0);
    expect(chunk(bytes, 'data').size).toBe(0);
    expect([...chunk(bytes, 'fact').payload]).toEqual(u32(0));
  });

  it('refuses partial frames, use after finish and files past the RIFF limit', () => {
    const writer = createWavWriter(FIXED);
    expect(() => writer.write(new Float32Array(3))).toThrow(/whole number of 2-channel frames/);
    // A stand-in for 1.5 billion samples: the size check runs before any conversion.
    const huge = { length: 1_500_000_000 } as unknown as Float32Array;
    expect(() => writer.write(huge)).toThrow(/4 GiB RIFF limit/);
    expect(() => encodeWav(huge, FIXED)).toThrow(/4 GiB RIFF limit/);
    writer.write(new Float32Array(2));
    expect(writer.finish().frames).toBe(1);
    expect(() => writer.write(new Float32Array(2))).toThrow(/after finish/);
    expect(() => writer.finish()).toThrow(/twice/);
  });

  it('rejects bad metadata up front', () => {
    expect(() => createWavWriter({ channels: 3 } as unknown as WavWriterOptions)).toThrow(/channels/);
    expect(() => createWavWriter({ sampleRate: 44100.5 })).toThrow(/sample rate/);
    expect(() => createWavWriter({ timeReference: -1 })).toThrow(/time reference/);
    expect(() => createWavWriter({ bext: { originationDate: '19/11/2026' } })).toThrow(/yyyy-mm-dd/);
    expect(() => createWavWriter({ bext: { originationTime: '10:20' } })).toThrow(/hh:mm:ss/);
    expect(() => createWavWriter({ ixml: { frameRate: 25, dropFrame: true } })).toThrow(/drop-frame/);
    expect(() => createWavWriter({ ixml: { frameRate: 12.5 } })).toThrow(/NTSC/);
    expect(() => createWavWriter({ ixml: { frameRate: { numerator: 30, denominator: 0 } } })).toThrow(/ratio/);
  });

  it('defaults the origination date and time to now', () => {
    const bext = chunk(encodeWav(new Float32Array(2)), 'bext').payload;
    expect(asciiField(bext, 320, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(asciiField(bext, 330, 8)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(asciiField(bext, 0, 256)).toBe('Track');
  });
});

describe('timeReferenceSamples', () => {
  it('turns a timecode start into samples since midnight, rounded to the nearest sample', () => {
    expect(timeReferenceSamples(3600, 48000)).toBe(172_800_000);
    expect(timeReferenceSamples(0, 48000)).toBe(0);
    expect(timeReferenceSamples(0.0000104, 48000)).toBe(0);
    expect(timeReferenceSamples(0.0000105, 48000)).toBe(1);
    expect(timeReferenceSamples(36000 + 1 / 3, 44100)).toBe(1_587_614_700);
  });

  it('rejects negative or non-finite input', () => {
    expect(() => timeReferenceSamples(-1, 48000)).toThrow(RangeError);
    expect(() => timeReferenceSamples(Number.NaN, 48000)).toThrow(RangeError);
    expect(() => timeReferenceSamples(1, 0)).toThrow(RangeError);
  });
});

describe('loudness measured while writing', () => {
  it('patches the version 2 bext loudness fields at finish', () => {
    const writer = createWavWriter({ trackName: 'Dialog', bext: { originationDate: '2026-01-02', originationTime: '03:04:05', loudness: {} } });
    writer.write(new Float32Array([0.5, -0.5]));
    const file = writer.finish({ loudness: { integrated: -23.04, range: 6.5, maxTruePeak: -1.2 } });
    const header = file.parts[0]!;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const bext = 12 + 8 + 16 + 8; // RIFF/WAVE, fmt chunk (16 bytes), bext chunk header
    expect(String.fromCharCode(...header.subarray(bext - 8, bext - 4))).toBe('bext');
    expect(view.getUint16(bext + 346, true)).toBe(2);
    expect(view.getInt16(bext + 412, true)).toBe(-2304);
    expect(view.getInt16(bext + 414, true)).toBe(650);
    expect(view.getInt16(bext + 416, true)).toBe(-120);
    expect(view.getInt16(bext + 418, true)).toBe(0x7fff);
  });

  it('refuses loudness at finish for a version 1 bext', () => {
    const writer = createWavWriter({ bext: { originationDate: '2026-01-02', originationTime: '03:04:05' } });
    expect(() => writer.finish({ loudness: { integrated: -23 } })).toThrow(/version 2 bext/);
  });
});
