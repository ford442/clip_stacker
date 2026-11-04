// The Mediabunny surface Mp4Writer uses. Named re-exports, so the lazily
// loaded chunk is tree-shaken to the MP4 muxer instead of the whole library.
export {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
