import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferSource, EncodedPacketSink, Input, MP4 } from 'mediabunny';
import { Mp4Writer } from '../../export/container';
import { zeroMp4Times } from './mp4Digest';
import { parseAvcDecoderConfig, withInBandParameterSets } from '../../export/renderCache/smartRender';

const SPS = [0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0xc0, 0xf1, 0x83, 0x19, 0x60];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
const AVCC = new Uint8Array([1, SPS[1]!, SPS[2]!, SPS[3]!, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS]);

async function write(codec = 'avc1.64001f', inBand = false): Promise<Uint8Array> {
  const writer = new Mp4Writer({ video: { codec: 'avc', width: 640, height: 360 } });
  const avc = parseAvcDecoderConfig(AVCC)!;
  for (let i = 0; i < 4; i++) {
    const key = i % 2 === 0;
    const data = new Uint8Array([0, 0, 0, 3, key ? 0x65 : 0x41, 0x88, i]);
    writer.addVideoPacket(
      { data: inBand && key ? withInBandParameterSets(data, avc) : data, type: key ? 'key' : 'delta', timestamp: i * 33_333, duration: 33_333 },
      i === 0 ? { decoderConfig: { codec, codedWidth: 640, codedHeight: 360, description: AVCC } } : undefined,
    );
  }
  return new Uint8Array(await writer.finalize());
}

afterEach(() => {
  vi.useRealTimers();
});

describe('zeroMp4Times', () => {
  it('makes two writes of the same packets at different times identical', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = await write();
    vi.setSystemTime(new Date('2027-06-01T12:00:00Z'));
    const second = await write();
    expect(first).not.toEqual(second);
    expect(zeroMp4Times(first)).toEqual(zeroMp4Times(second));
    expect(zeroMp4Times(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('avc3 tracks with in-band parameter sets', () => {
  it('are written as avc3 and read back with every key frame intact', async () => {
    const file = await write('avc3.64001f', true);
    const input = new Input({ formats: [MP4], source: new BufferSource(file.buffer as ArrayBuffer) });
    const track = (await input.getPrimaryVideoTrack())!;
    expect((await track.getDecoderConfig())?.codec).toMatch(/^avc3\./);
    const keys: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { verifyKeyPackets: true })) {
      if (packet.type === 'key') keys.push(Math.round(packet.timestamp * 30));
    }
    expect(keys).toEqual([0, 2]);
  });
});
