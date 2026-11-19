# Render cache, smart render and the RAM preview

Every GPU export used to decode, composite and encode every frame, and the
preview composed every frame on demand. Three pieces make that incremental.
They all work on the composition plan (`buildPreviewCompositionPlan`), which
is already a pure description of a frame.

| Piece | Where | Code |
| --- | --- | --- |
| Content key per frame and segment | export + preview | `src/export/renderKey.ts`, `src/utils/xxhash64.ts` |
| Render cache (encoded segments in OPFS) | export | `src/export/renderCache/` |
| Smart render (copy untouched source GOPs) | export | `src/export/renderCache/smartRender.ts` |
| RAM preview (composed frames on the GPU) | preview worker | `src/webgpu/previewFrameCache.ts`, `previewWorkerCache.ts` |
| Settings, UI | main | `src/store/renderCacheStore.ts`, `previewCacheStore.ts`, `components/inspector/RenderCacheFields.tsx`, `PreviewCacheBar.tsx`, `PreviewRenderControls.tsx`, `hooks/usePreviewCacheControls.ts` |

## Keys

`frameKey(plan, ctx)` is XXH64 over a canonical (key-sorted) JSON of:

- every drawn layer of the plan, with clip ids, timeline indices and the
  transition's absolute start removed (a split or a ripple renames and
  renumbers placements without changing a pixel);
- for each clip layer, the media it decodes — `fingerprintMedia` of the file
  (the proxy's when the preview reads one) — plus the clip fields that pick
  the decoded frame: kind, still, reverse, trim window, colour-space override;
- for titles and captions, their content and their clock (titles animate on
  it); a title or caption at opacity 0 draws nothing and is left out, so a
  title keyframed visible over 2 s only touches those frames;
- the frame-wide settings (`renderSettingsHash`): finishing, colour
  management, output size and `BUILD_ID` — a content hash of `src/`,
  `public/wasm/` and `public/fonts/` set by `vite.config.ts`, so frames cached
  by another build of the renderer are never reused;
- the grain seed, only when grain is on (grain is seeded by the frame index).

Before keying, `quantizePlan` snaps source times to microseconds (the
decoders' grid) and rounds every other per-layer number to float32 (what the
uniforms carry). The same frame reached along two edit histories lands a few
ulps apart otherwise — and at an exact frame boundary would even pick another
decoded frame. A segmented export renders the quantized plan it keyed, so
equal keys mean equal inputs.

`segmentFrames` groups frames into segments: a new one starts where what is on
screen changes (another clip, a title appearing) or cacheability changes, and
every 60 frames counted from that run's start. A clip moved along the
timeline therefore keeps its segment keys. A segment key hashes its frame keys
in order.

The hash is XXH64 in TypeScript (`utils/xxhash64.ts`), byte-for-byte the
reference algorithm (pinned against vectors from the C implementation). It
runs synchronously in every realm; moving it into the media engine later
changes no key.

## The segmented export

`encodeTimelineComposite` (`src/export/webcodecsTimelineExport.ts`) runs
`runSegmentedExport` (`renderCache/segmentedExport.ts`) whenever the render
cache or smart render is on (the default) — which also means every timeline
takes the GPU compositor when WebGPU is there. Each segment is:

1. **copied** from its source (smart render, below);
2. **reused** — a cache hit: its packets are read back and rebased onto the
   segment's output time;
3. **rendered** — composited and encoded by a *fresh* `VideoEncoder` that
   starts on a key frame, then stored. No rate-control or reference state
   carries in from earlier segments, so a cached segment is exactly what a
   fresh render of it produces: cached and uncached exports of a project are
   bit-identical (`e2e/renderCache.spec.ts` compares digests with the MP4
   header times zeroed). Temporal noise reduction is reset at every rendered
   segment's start for the same reason.

One track has one sample entry. When every piece shares its SPS / PPS the
file is plain `avc1`. When they differ (two cameras, or a copied span next to
re-encoded frames), an H.264 export is written `avc3` with each span's
parameter sets in band before every key frame (`withInBandParameterSets`);
the encoder's parameter sets are learnt up front from a one-frame probe. A
non-H.264 hit from another encoder configuration is re-rendered. If a
rendered segment still comes out with parameter sets the file did not plan
for, the export throws `SegmentConfigMismatchError` and runs again as one
continuous encode.

`RenderPlan.renderCache` reports segments, hits, misses (and uncacheable
ones), copies, frames encoded / reused / copied, bytes reused / stored and
whether the parameter sets went in band; `encoderReasons` says why each
clip was or was not copied. Copy Debug shows both plus the cache's settings
and usage.

### What cannot be cached

A RIFE morph segment (its own blob), an offline clip's slate and media
without a fingerprint render every time (`FrameKey.uncacheable`).

## Render cache storage

`render-cache/<settingsKey>/<segmentKey>.chunk` in OPFS
(`cacheBackend.ts`; memory when the browser has no writable OPFS files).
`settingsKey` hashes the encoder config (codec, size, bitrate, mode, latency,
acceleration rung, colour), the text route, the frame rate, the GOP and the
render settings hash. A chunk (`segmentRecord.ts`) is `CSRC`, a version, a
JSON header (decoder config with its description, per-packet type /
timestamp / duration / length) and the packet bytes; it always starts on a
key frame.

`RenderCache` (`renderCache.ts`) keeps entries least-recently-used under the
budget (default 2 GiB, 512 MB … 8 GB in the Export tab). `index.json` keeps
sizes and last use across reloads and is reconciled with the files on open
(stray files adopted, missing ones dropped, unreadable ones removed). The
segments an export plans to reuse are pinned until it ends, so a planned hit
cannot be evicted halfway through. A full disk makes a write fail quietly —
a miss next time, never a failed export. #279 moves working media onto OPFS
too; the render cache has its own directory and does not depend on it.

## Smart render

`passthroughFrame` accepts a frame whose plan is one full-frame base layer at
opacity 1 with nothing on it (no transition, warp, key, Ken Burns, title or
caption at non-zero opacity), on an H.264 clip that is not reversed, offline,
RIFE-processed or colour-overridden. The whole export must apply no finishing
and no colour management, be H.264, and not have Force re-encode on
(`smartRenderBlockers`). `sourceCopyBlocker` checks the source: H.264 at the
output size, square pixels, 4-byte NAL lengths, untagged or Rec.709 limited.

A run of such frames on one clip (source time advancing one export frame per
frame) is matched against the source's packets (`readVideoPackets`, from the
key frame before the run):

- the source must run at the export's 30 fps;
- the copy starts at the run's first source key frame — frames before it
  (a cut inside a GOP) are rendered and encoded;
- it ends at the last *closed* decode-order prefix: the packets copied so far
  are exactly a run of frames in presentation order, so no copied B-frame
  references a dropped one; an open-GOP leading picture ends the copy;
- copied packets keep their bytes and get output timestamps on the export grid.

**Routing.** A cut-only timeline still goes to FFmpeg's lossless concat (it
copies the audio too), except when a clip is trimmed at the start: FFmpeg's
concat re-encodes such a clip whole, smart render copies it from its next key
frame on (`smartRenderPrefersGpu` in `encoderPath.ts`; WebGPU must be
confirmed).

Copied spans keep the source's quality and bitrate. The `avc3` in-band form
plays in Chromium, VLC and FFmpeg; some players (QuickTime / Safari among
them) only accept `avc1` — turn smart render off (or Force re-encode on) when
the file is for one of those.

## RAM preview

With **Preview cache** on (default), the preview worker snaps playback and
scrubs to the 30 fps grid, keys each frame (`previewFrameKey`: the video
layers and finishing — titles and captions are drawn by main over the
composite, so they are not in the key), and keeps composed frames as
`GPUTexture` copies of the swapchain under a budget from the device's
`maxBufferSize` (192 MiB … 1 GiB, at least 60 frames). A hit draws the
texture back with a `textureLoad` blit (`shaders/frameBlit.wgsl`), so the
presented pixels are exactly the stored ones. A recovered device starts
empty. Frames whose layers came from main's `<video>` fallback are not
stored, and temporal noise reduction turns caching off.

- **Ruler bar.** `cache-status` re-keys each cached frame against the
  timeline as it is now; `usePreviewCacheControls` polls it once a second and
  the ruler draws the frames that still match in green
  (`PreviewCacheBar`), with the In → Out range shaded.
- **Render In→Out** (Shift+I / Shift+O mark, Shift+X clears, Shift+Enter or
  **⏺ Render In→Out**) renders every frame of the range through the preview,
  so playback of the range presents cached frames. **⏹** stops it.
- **Background render while idle** (opt-in) fills up to 10 s after a paused
  playhead once composing costs more than a frame (`previewMetrics`'s frame
  time — a light stack plays in real time anyway). It uses `prerender`: the
  worker draws and stores the frame, then presents the cached frame at the
  playhead again in the same task, so nothing flickers; it stops on any
  playhead move, playback or edit.
- `previewMetrics` counts `cacheHits` / `cacheMisses` and, per play,
  `droppedFrames` (30 fps slots that passed without a frame) and
  `playedFrames`.

Not built yet: playback of a range by decoding its cached chunks from the
export render cache (the RAM ring covers the in-to-out case at preview
resolution), a red "needs render" band, and GPU-timestamp cost estimates
(the background fill uses the measured frame time).
