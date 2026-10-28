import { describe, expect, it } from 'vitest';
import { createFile, MP4BoxBuffer, type Movie } from 'mp4box';
import { Mp4Writer, aacLcAudioSpecificConfig, type Mp4Packet } from './index';

// A real SPS / PPS pair (High, level 3.1) — the muxer never decodes, but mp4box
// parses the avcC we hand it.
const SPS = [
  0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00,
  0x10, 0x00, 0x00, 0x03, 0x03, 0xc0, 0xf1, 0x83, 0x19, 0x60,
];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];

function avcDecoderConfigurationRecord(): Uint8Array {
  return new Uint8Array([
    1, SPS[1]!, SPS[2]!, SPS[3]!, 0xff, 0xe1,
    SPS.length >> 8, SPS.length & 0xff, ...SPS,
    1, PPS.length >> 8, PPS.length & 0xff, ...PPS,
  ]);
}

function videoMeta(description = avcDecoderConfigurationRecord()): EncodedVideoChunkMetadata {
  return {
    decoderConfig: { codec: 'avc1.64001f', codedWidth: 640, codedHeight: 360, description },
  };
}

const FRAME_US = 33_333;
const AAC_FRAME_US = 21_333;

function videoPacket(index: number, startUs = 0, type: 'key' | 'delta' = index === 0 ? 'key' : 'delta'): Mp4Packet {
  return {
    data: new Uint8Array([0, 0, 0, 3, type === 'key' ? 0x65 : 0x41, 0x88, index]),
    type,
    timestamp: startUs + Math.round(index * (1_000_000 / 30)),
    duration: FRAME_US,
  };
}

function audioPacket(index: number): Mp4Packet {
  return {
    data: new Uint8Array([0x21, 0x10, 0x04, index]),
    type: 'key',
    timestamp: Math.round((index * 1024 * 1_000_000) / 48_000),
    duration: AAC_FRAME_US,
  };
}

function topLevelBoxes(buffer: ArrayBuffer): string[] {
  const view = new DataView(buffer);
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4));
    if (size === 1) size = Number(view.getBigUint64(offset + 8));
    if (size === 0) size = buffer.byteLength - offset;
    types.push(type);
    offset += size;
  }
  return types;
}

function parseMp4(buffer: ArrayBuffer) {
  const file = createFile();
  const ready: { info?: Movie } = {};
  file.onReady = (movie) => {
    ready.info = movie;
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer.slice(0), 0));
  file.flush();
  if (!ready.info) throw new Error('mp4box never reached onReady');
  return { file, info: ready.info };
}

describe('Mp4Writer', () => {
  it('writes a fast-start MP4 with one H.264 and one AAC track', async () => {
    const writer = new Mp4Writer({
      video: { codec: 'avc', width: 640, height: 360 },
      audio: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 },
    });
    // Export order: every video packet, then the whole audio track (no meta).
    writer.addVideoPacket(videoPacket(0), videoMeta());
    writer.addVideoPacket(videoPacket(1));
    writer.addVideoPacket(videoPacket(2, 0, 'key'));
    for (let i = 0; i < 3; i++) writer.addAudioPacket(audioPacket(i));

    const buffer = await writer.finalize();
    const boxes = topLevelBoxes(buffer);
    expect(boxes[0]).toBe('ftyp');
    expect(boxes.indexOf('moov')).toBeGreaterThan(0);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));

    const { file, info } = parseMp4(buffer);
    expect(info.isFragmented).toBe(false);
    expect(info.tracks).toHaveLength(2);

    const [video] = info.videoTracks;
    expect(video!.codec).toBe('avc1.64001f');
    expect(video!.video).toEqual({ width: 640, height: 360 });
    expect(video!.timescale).toBe(57_600);
    expect(video!.nb_samples).toBe(3);
    expect(video!.duration).toBe(3 * 1920); // 3 frames of 1/30 s
    expect(file.getTrackSamplesInfo(video!.id).map((s) => s.is_sync)).toEqual([true, false, true]);

    const [audio] = info.audioTracks;
    expect(audio!.codec).toBe('mp4a.40.2');
    expect(audio!.audio?.sample_rate).toBe(48_000);
    expect(audio!.audio?.channel_count).toBe(2);
    expect(audio!.timescale).toBe(48_000);
    expect(audio!.nb_samples).toBe(3);
    expect(audio!.duration).toBe(3 * 1024);
  });

  it('offsets each track so its first packet sits at zero (no edit list)', async () => {
    const writer = new Mp4Writer({ video: { codec: 'avc', width: 640, height: 360 } });
    writer.addVideoPacket(videoPacket(0, 5_000_000), videoMeta());
    writer.addVideoPacket(videoPacket(1, 5_000_000));

    const { file, info } = parseMp4(await writer.finalize());
    const [video] = info.videoTracks;
    expect(video!.edits ?? []).toEqual([]);
    expect(file.getTrackSamplesInfo(video!.id).map((s) => s.cts)).toEqual([0, 1920]);
  });

  it('uses the frame rate as the video timescale', async () => {
    const writer = new Mp4Writer({ video: { codec: 'avc', width: 640, height: 360, frameRate: 30 } });
    writer.addVideoPacket(videoPacket(0), videoMeta());
    writer.addVideoPacket(videoPacket(1));
    writer.addVideoPacket(videoPacket(2));

    const { file, info } = parseMp4(await writer.finalize());
    const [video] = info.videoTracks;
    expect(video!.timescale).toBe(30);
    expect(file.getTrackSamplesInfo(video!.id).map((s) => s.cts)).toEqual([0, 1, 2]);
  });

  it('copies WebCodecs chunks and their decoder config at add time', async () => {
    const writer = new Mp4Writer({ video: { codec: 'avc', width: 640, height: 360 } });
    const description = avcDecoderConfigurationRecord();
    const chunkFrom = (packet: Mp4Packet) =>
      ({
        type: packet.type,
        timestamp: packet.timestamp,
        duration: packet.duration ?? null,
        byteLength: packet.data.byteLength,
        copyTo: (dest: Uint8Array) => dest.set(packet.data),
      }) as unknown as EncodedVideoChunk;

    writer.addVideoChunk(chunkFrom(videoPacket(0)), videoMeta(description));
    writer.addVideoChunk(chunkFrom(videoPacket(1)));
    // The adds run after the callback returns; a reused buffer must not leak in.
    description.fill(0);

    const { info } = parseMp4(await writer.finalize());
    expect(info.videoTracks[0]!.codec).toBe('avc1.64001f');
    expect(info.videoTracks[0]!.nb_samples).toBe(2);
  });

  it('leaves a declared track that got no packets out of the file', async () => {
    const writer = new Mp4Writer({
      video: { codec: 'avc', width: 640, height: 360 },
      audio: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 },
    });
    writer.addVideoPacket(videoPacket(0), videoMeta());

    const { info } = parseMp4(await writer.finalize());
    expect(info.videoTracks).toHaveLength(1);
    expect(info.audioTracks).toHaveLength(0);
  });

  it('holds the first add failure and rethrows it from finalize', async () => {
    const writer = new Mp4Writer({ video: { codec: 'avc', width: 640, height: 360 } });
    writer.addVideoPacket(videoPacket(0, 0, 'delta'), videoMeta());
    writer.addVideoPacket(videoPacket(1));

    await expect(writer.finalize()).rejects.toThrow(/key packet/);
    expect(() => writer.throwIfFailed()).toThrow(/key packet/);
    expect(() => writer.addVideoPacket(videoPacket(2))).toThrow(/after finalize/);
  });

  it('fails the first video packet that has no decoder config', async () => {
    const writer = new Mp4Writer({ video: { codec: 'avc', width: 640, height: 360 } });
    writer.addVideoPacket(videoPacket(0));
    await expect(writer.finalize()).rejects.toThrow(/metadata/i);
  });

  it('rejects packets for a track that was not declared', () => {
    expect(() => new Mp4Writer({})).toThrow(/video or an audio track/);
    const writer = new Mp4Writer({ audio: { codec: 'aac', sampleRate: 44_100, numberOfChannels: 2 } });
    expect(() => writer.addVideoPacket(videoPacket(0), videoMeta())).toThrow(/no video track/);
  });
});

describe('aacLcAudioSpecificConfig', () => {
  it('packs object type, rate index and channels', () => {
    expect([...aacLcAudioSpecificConfig(48_000, 2)]).toEqual([0x11, 0x90]);
    expect([...aacLcAudioSpecificConfig(44_100, 2)]).toEqual([0x12, 0x10]);
    expect([...aacLcAudioSpecificConfig(44_100, 1)]).toEqual([0x12, 0x08]);
  });

  it('writes an explicit 24-bit rate when the rate is not in the table', () => {
    const asc = aacLcAudioSpecificConfig(50_000, 2);
    expect(asc).toHaveLength(5); // 5 + 4 + 24 + 4 bits
    expect(asc[0]! >> 3).toBe(2);
    expect(((asc[0]! & 0x07) << 1) | (asc[1]! >> 7)).toBe(15);
  });
});
