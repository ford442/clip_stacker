// The Mediabunny surface the demux facade (`demux.ts`) uses. Named
// re-exports, so the lazily loaded chunk is tree-shaken to the MP4 / MOV /
// WebM / MKV readers instead of the whole library.
export {
  BlobSource,
  EncodedPacketSink,
  Input,
  MATROSKA,
  MP4,
  QTFF,
  VideoSampleSink,
  WEBM,
} from 'mediabunny';
