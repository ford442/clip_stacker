# Timeline interchange, offline clips and stems

Clip Stacker reads and writes three timeline formats, so a cut can move to
Resolve, Premiere, Final Cut Pro, Avid or a DAW and come back:

| Format | Direction | Notes |
|---|---|---|
| **OpenTimelineIO** (`.otio`, JSON: `Timeline.1`, `Stack.1`, `Track.1`, `Clip.2`, `Gap.1`, `Transition.1`, `ExternalReference.1`, `Marker.2`, `RationalTime.1`) | import + export | Reads `Clip.1` / `Marker.1` too, and times written at other rates. |
| **FCPXML 1.11** (`resources` → `format` / `asset` / `effect` / `media`; `library` → `event` → `project` → `sequence` → `spine`) | import + export | Reads 1.8–1.11. Parsed and written with `fast-xml-parser` (works in Node too), imported only by `src/interchange/xml.ts`. |
| **CMX 3600 EDL** (cuts, `D` dissolves, `M2` speed, `* FROM CLIP NAME`, drop / non-drop) | import + export | One video track and two audio tracks; no metadata. |

UI: toolbar **File** menu — *Import timeline…*, *Export timeline ▸ OTIO /
FCPXML / EDL*, *Export stems…*, *Relink media…*. Scripted:
`window.clipStacker.project.importTimeline / exportTimeline` and `cs import /
export` (see `docs/project-api.md`).

## How it is built

`src/interchange/` is a pure domain module (no React, no store):

- `model.ts` — the neutral timeline every format reads and writes: tracks of
  clips, nested stacks, gaps, transitions and titles, in **integer frames** at
  the sequence rate; markers, captions; a `clip_stacker` metadata bag.
- `mapping.ts` — the table below, plus the metadata helpers. `toInterchange.ts`
  (project → neutral) and `fromInterchange.ts` (neutral → project) implement
  it; `otio.ts`, `fcpxml.ts` / `fcpxmlRead.ts` and `edl.ts` only spell the
  neutral model in their syntax, so the formats cannot drift.
- `rational.ts` (exact frame ↔ `1001/30000s` / `RationalTime`) and
  `timecode.ts` (SMPTE, drop frame included).
- `relink.ts` — media matching (below).

Both directions work on the saved project JSON (`Project`), so the app, a
test and a headless caller export the same bytes. Main-lane positions come
from the compositor's own segment maths, not from stored start times.

### Mapping

<!-- mapping:start (generated from INTERCHANGE_MAPPING; UPDATE_INTERCHANGE_DOC=1 npx vitest --run src/interchange/mapping.test.ts) -->
| Clip Stacker | OTIO | FCPXML | CMX 3600 EDL | Notes |
|---|---|---|---|---|
| Main video lane | first video Track | primary spine | V events | role `base`; its record positions come from transition-aware segment maths |
| Overlay video lanes | further video Tracks (bottom to top) | connected clips, lane 1…n | not written (one video track) | role `overlay`; overlapping items spill into extra tracks tagged with the same lane id |
| Audio lanes | audio Tracks | connected clips, lane −1…−n | A / A2 events for audio clips on the first two audio lanes | role `audio` |
| Titles lanes / text overlays | video Track of Clips with a `GeneratorReference` (`clip_stacker.title`) | `title` (Basic Title) connected above the overlays | not written | role `titles`; titles are not time-gated, so each spans the programme; its lane placement rides in metadata |
| Lane mute | Track `enabled: false` | `enabled="0"` on the lane's clips | muted lanes are skipped | lane `muted` |
| Clip trim | `source_range` (media time at the sequence rate) | `start` / `duration` | source in / out | `sourceIn` + `duration`; exact seconds ride in metadata while they agree to a frame |
| Constant speed | `LinearTimeWarp.time_scalar` | `timeMap` (two points) | `M2` (reel, fps, source in) | `speed`; reversed clips have a negative speed |
| Speed curve (`automation.playbackRate`) | sampled points in metadata (`LinearTimeWarp` carries the average) | `timeMap` with a point at each end and at every rate keyframe | `M2` at the average speed | `timeMap` |
| Base-lane transition | `Transition` with `in_offset` = `out_offset` = half the duration | `transition` centred on the edit | `D` dissolve starting at the edit, length in frames | the transition id survives in metadata; an unknown id imports as `dissolve` |
| Volume / pan automation | metadata only (OTIO has no audio-effect schema) | `adjust-volume` + `keyframeAnimation` (dB) | not written | `volume`; pan rides in metadata |
| Captions | timeline `Marker`s, colour `PURPLE`, `clip_stacker.caption` | `caption` (ITT) on its own lane | not written | `captions` |
| Markers (master-track markers) | timeline `Marker`s | `marker` on the spine element under it | `* LOC:` comments | `markers` |
| Nested sequence | `Stack` with a `source_range` | `media` compound clip + `ref-clip` | flattened to one event named after the sequence | role-preserving: the stack's tracks are the sequence's lanes |
| Media | `ExternalReference.target_url` + `available_range` | `asset` + `media-rep` | `* FROM CLIP NAME:` / `* SOURCE FILE:` comments, reel = name | relinked by file name, then content hash, then Drive id; otherwise an offline clip |
| Everything else (finishing, bus FX, keys, picture transform, stabilize, proxies, ids) | `metadata.clip_stacker` | `metadata` / `md key="com.clipstacker.*"` (JSON) | not written | so export → import → export is byte-identical |
| Timecode start / rate | `global_start_time` (`RationalTime` at the sequence rate) | sequence `tcStart` / `tcFormat`, format `frameDuration` | record timecodes, `FCM: DROP FRAME` / `NON-DROP FRAME` | `Project.timecodeStart` / `timecodeRate` (default 01:00:00:00 at 30) |
<!-- mapping:end -->

### Round trips

Everything without a home in a format (finishing, bus FX, keys, picture
transform, stabilization, proxies, A/B groups, ids, exact seconds) rides in
the `clip_stacker` namespace: OTIO `metadata.clip_stacker`, FCPXML
`<metadata><md key="com.clipstacker.*" value="{json}"/>` (on clips, titles and
compound clips; per lane, transition and caption in the sequence's metadata).
The importer trusts it **only while it agrees with the file** — to a frame for
positions, lengths and speed. A clip a foreign tool moved, trimmed or retimed
is rebuilt from the file's own values (constant speed, no loops) and keeps
the rest of its settings; a transition whose type changed takes the file's.

So `export → import → export` is byte-identical: `src/interchange/otio.test.ts`
and `fcpxml.test.ts` check it (and that the imported project equals the
original) for every `e2e/fixtures.ts` project, and `e2e/interchange.spec.ts`
does the same through the real app's import. EDL round-trips cuts, dissolves
and speed to the frame (`edl.test.ts`).

Details worth knowing:

- **Titles** are not time-gated in Clip Stacker (they show for the whole
  programme), so each title is a full-length item on its own track; its lane
  placement rides in metadata.
- **Transitions** are centred on the edit (`in_offset` = `out_offset`, using
  the clips' handles), which is how Clip Stacker's overlap maths plays them.
  An EDL `D` event starts at its record-in, so the EDL writer starts it
  `in_offset` frames before the cut. Unknown transition ids import as
  `dissolve`; the WGSL id survives in metadata.
- **Overlapping items** on one lane (possible on overlay / audio lanes) spill
  into extra tracks tagged with the same lane id and merge back on import.
- **Linked audio**: NLEs write a clip's sound as a separate audio item under
  the video; an audio item with the same media, start and length as a video
  item (and no Clip Stacker metadata) is not imported twice.
- **Nested sequences** are OTIO `Stack`s with a `source_range` and FCPXML
  compound clips (`media` + `ref-clip`); the EDL flattens one to an event
  named after the sequence.
- **Rates**: the sequence rate is the project's `timecodeRate` (default `30`,
  the export grid). FCPXML derives it from `frameDuration` + `tcFormat`, OTIO
  from `global_start_time` (or the first clip), the EDL from `FCM` and a
  `* FRAME RATE:` comment (or the caller's `rate`).
- **FCPXML connected clips** are anchored to the spine element under their
  start, at the parent's local time (`start` + record distance), and a trailing
  `gap` extends the spine under items past its end. Media `src` is the file
  name (or the caller's media root), so FCP / Resolve ask to relink.

## Media relinking and offline clips

Import (and `project.loadProject`) find each clip's media in this order:

1. **File name** in the library (the open project's clips), then in files the
   user picked, then under a media root URL (`cs` serves `--media`);
2. the same name **ignoring case**;
3. **`fingerprintMedia` hash** (computed for candidates only when an
   unmatched reference carries one);
4. **Drive** file id or a Drive library item of that name (downloaded on
   demand from *Relink media…*, since Drive access is interactive).

Anything not found becomes an **offline clip** (`Clip.offline`): it keeps its
id, place, trims and settings; preview and export draw a *MEDIA OFFLINE* slate
(`media/offlineSlate.ts`); it plays no audio; proxies, stabilization and
analysis skip it; the timeline draws it striped with an OFFLINE badge;
**Render refuses** while one sits on an unmuted lane (`project/offlineClips.ts`);
and it saves its offline record, so it survives save / load / autosave and
comes back offline until its media is found. Loading a project or recovering
an autosave whose media is missing now loads those clips offline instead of
dropping them — the defined behaviour for an evicted blob (#279).

*Relink media…* lists every offline clip with a library pick, a file pick and
a Drive download per row, plus *Relink all from folder…* (name, then hash).
A relink is one undo step and clamps a trim that runs past the new file.

## Stems (audio post handoff)

*File → Export stems…* (or `project.exportStems`, `cs stems`) writes one
Broadcast WAV per audio-carrying lane plus the master, 48 kHz, 24-bit PCM or
32-bit float, zipped with the timeline (OTIO) and `manifest.json` (loudness,
true peak and sample peak per stem, timecode, format).

- The stems come from **the same mix as the master**, in the same pass: the
  media engine's bus graph taps each lane after its chain, delay compensation
  and sidechain duck, before the sum (`MIX_BUS_TAP`), so the stems sum to the
  master's input (to 1 ulp in the host tests and `mediaEngine.taps.test.ts`)
  and a duck still keys from the real key lane. There is no OfflineAudioContext
  fallback: stems need the media engine and say so.
- Every file carries a BWF `bext` chunk whose **`TimeReference`** is the
  project timecode start (01:00:00:00 → 172 800 000 samples at 48 kHz), a
  version 2 loudness block measured while writing, and an `iXML` chunk with the
  lane name and frame rate — Cubase, Pro Tools, Resolve and Reaper place a BWF
  at its `TimeReference`.
- The project's loudness target applies to the master stem only. *Normalize*
  gains each lane stem to −23 LUFS (EBU R 128; a measuring pass first).

## Manual checks still to record

These need the real applications and are not covered by CI. Record the
result (version, date, what was seen) here when done:

| Check | Status |
|---|---|
| Resolve 19 opens an exported FCPXML with the right cuts, dissolves and titles | not yet run |
| Final Cut Pro opens an exported FCPXML with the right cuts, dissolves and titles | not yet run |
| Stems from the lane-bus fixture import into Cubase at the right position (`TimeReference`) | not yet run |
| Stems import into Reaper at the right position | not yet run |
| `cs mcp` lists its tools and renders through Claude Code (a recorded session) | tools and calls verified with the MCP SDK client; Claude Code session not yet recorded |

## Not built

AAF / OMF, Premiere's legacy XMEML, multi-channel (> stereo) stems, RF64 /
ZIP64 for files past 4 GiB, and per-clip FCPXML retime curves beyond a sampled
time map.
