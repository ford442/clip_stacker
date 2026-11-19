import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Clip, Track } from '../types';
import { loadMediaEngineModule } from '../wasm/mediaEngine';
import { exportStems, STEM_NORMALIZE_LUFS, StemExportError } from './exportStems';

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;
const RATE = 48_000;

function fakeAudioBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate: RATE,
    duration: channels[0]!.length / RATE,
    getChannelData: (ch: number) => channels[ch]!,
  } as unknown as AudioBuffer;
}

function tone(seconds: number, freq: number, amp: number): Float32Array {
  const out = new Float32Array(seconds * RATE);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}

function clip(id: string, kind: 'video' | 'audio', duration: number): Clip {
  return {
    id,
    file: new File([], `${id}.${kind === 'audio' ? 'wav' : 'mp4'}`),
    objectUrl: `blob:${id}`,
    title: id,
    kind,
    duration,
    hasAudio: true,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    layerIndex: 0,
    timelineStart: 0,
  };
}

const tracks: Track[] = [
  { id: 'v1', kind: 'video', label: 'Picture', items: [{ clipId: 'pic', startTime: 0 }] },
  { id: 'a1', kind: 'audio', label: 'Music / Bed', items: [{ clipId: 'bed', startTime: 0.5 }] },
];

const pcm: Record<string, Float32Array> = { pic: tone(2, 440, 0.3), bed: tone(1, 220, 0.2) };
const cache = { get: async (id: string) => fakeAudioBuffer([pcm[id]!]), delete: () => {} };

/** Float32 samples of a WAV's data chunk. */
function wavFloats(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset < bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') return new Float32Array(bytes.slice(offset + 8, offset + 8 + size).buffer);
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function bextTimeReference(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset < bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'bext') return view.getUint32(offset + 8 + 338, true) + view.getUint32(offset + 8 + 342, true) * 2 ** 32;
    offset += 8 + size + (size % 2);
  }
  return -1;
}

async function unzip(bundle: Blob | Uint8Array): Promise<Record<string, Uint8Array>> {
  const bytes = bundle instanceof Uint8Array ? bundle : new Uint8Array(await bundle.arrayBuffer());
  return unzipSync(bytes);
}

describe('exportStems', () => {
  beforeAll(async () => {
    vi.stubGlobal('OfflineAudioContext', class {
      createBuffer(channels: number, length: number) {
        return fakeAudioBuffer(Array.from({ length: channels }, () => new Float32Array(length)));
      }
    });
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
  });

  const input = {
    clips: [clip('pic', 'video', 2), clip('bed', 'audio', 1)],
    groups: [],
    transitions: [],
    tracks,
    projectName: 'Spot',
    timecode: { start: '01:00:00:00', rate: '25' as const },
    extraFiles: [{ name: 'Spot.otio', data: '{"OTIO_SCHEMA": "Timeline.1"}' }],
  };

  it('writes one BWF per lane plus the master at the timecode start, and the stems sum to the master', async () => {
    const { bundle, report } = await exportStems(input, { format: 'float32', cache, now: new Date(2026, 0, 2, 3, 4, 5) });
    const files = await unzip(bundle);
    expect(Object.keys(files).sort()).toEqual(['01 Master.wav', '02 Picture.wav', '03 Music - Bed.wav', 'Spot.otio', 'manifest.json']);
    expect(report.files.map((f) => [f.name, f.role, f.trackId])).toEqual([
      ['Master', 'master', null],
      ['Picture', 'lane', 'v1'],
      ['Music / Bed', 'lane', 'a1'],
    ]);
    expect(report.timeReference).toBe(3600 * RATE);
    for (const name of ['01 Master.wav', '02 Picture.wav', '03 Music - Bed.wav']) expect(bextTimeReference(files[name]!)).toBe(3600 * RATE);

    const master = wavFloats(files['01 Master.wav']!);
    const picture = wavFloats(files['02 Picture.wav']!);
    const bed = wavFloats(files['03 Music - Bed.wav']!);
    expect(master.length).toBe(2 * RATE * 2);
    let worst = 0;
    for (let i = 0; i < master.length; i++) worst = Math.max(worst, Math.abs(picture[i]! + bed[i]! - master[i]!));
    expect(worst).toBeLessThan(1e-6);
    // The bed starts at 0.5 s on its own stem.
    expect(Math.max(...bed.subarray(0, 0.4 * RATE * 2).map(Math.abs))).toBe(0);

    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!));
    expect(manifest).toMatchObject({ project: 'Spot', timecodeStart: '01:00:00:00', timecodeRate: '25', sampleRate: RATE, format: 'float32' });
    expect(manifest.files[1].integratedLufs).toBeLessThan(0);
  });

  it('normalizes each stem to −23 LUFS on request, leaving the master as mixed', async () => {
    const plain = await exportStems(input, { cache });
    const normalized = await exportStems(input, { cache, normalize: true });
    const lanes = normalized.report.files.filter((f) => f.role === 'lane');
    for (const lane of lanes) expect(lane.integratedLufs).toBeCloseTo(STEM_NORMALIZE_LUFS, 1);
    expect(normalized.report.files[0]!.integratedLufs).toBeCloseTo(plain.report.files[0]!.integratedLufs!, 6);
    expect(normalized.report.normalized).toBe(true);
  });

  it('exports only the chosen lanes and refuses a silent timeline', async () => {
    const { report } = await exportStems(input, { cache, trackIds: ['a1'], includeMaster: false });
    expect(report.files.map((f) => f.trackId)).toEqual(['a1']);
    await expect(exportStems({ ...input, clips: [], tracks: [] }, { cache })).rejects.toBeInstanceOf(StemExportError);
  });
});
