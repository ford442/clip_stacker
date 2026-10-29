# clip_stacker

A web app for stacking video and audio clips into one merged MP4, powered by FFmpeg WebAssembly.

## Features

- Upload and keep multiple clips in project state (MP4/MOV video, WAV/MP3 audio)
- Auto-select the newest uploaded clip while retaining older clips
- Trim each clip with start/end offsets
- Reorder clips in a timeline editor
- Apply per-clip fade in/out controls for video and audio
- **Picture-in-Picture overlays**: select a video clip and hit **Use as overlay (PiP)** in the Inspector to composite it over the base video in any corner; **Use as base layer** puts it back. Size, position and opacity stay editable under *Picture-in-Picture layout (advanced)*
- **Channel logos / bugs**: **Use as channel logo** snaps the clip to a corner at ~10% of the canvas width, locked to the source's own aspect ratio, muted, and keyed on the source alpha — so a non-square mark composites without a black box on both the GPU export and the FFmpeg fallback. Transparency mode is editable under *Picture-in-Picture layout (advanced)*: source alpha (straight or premultiplied), chroma key, luma key, or an opaque rectangle. The mask has to exist in the file: use PNG/WebP for stills and WebM (VP8/VP9 + alpha) for motion — H.264 MP4 carries no alpha, so key those with chroma/luma instead. Chroma and luma keying run in the compositor itself (`src/utils/overlayKey.ts` — one `keyPixel()` shared by the WGSL shader, the Canvas2D path, and the unit tests), so the Inspector's sliders update the live preview and the default WebGPU + WebCodecs export matches it. FFmpeg's `chromakey` / `lumakey` stay as the Force-FFmpeg fallback and are tuned to the same maths, so the two paths look alike rather than merely similar. The render-plan line under the toolbar says which one ran
- **News tickers / lower thirds**: use a scrolling text overlay (`scrolling` + `scrollSpeed`), which matches between preview and FFmpeg `drawtext`. Only bake a designed motion lower third to video (as WebM + alpha, placed as a full-width bottom overlay) when `drawtext` cannot express it
- **Captions / subtitles**: a time-coded caption track with its own timeline lane. Import `.srt` / `.ass`, edit text and timings in the Inspector's *Captions* tab, drag a chip's edges to retime, press <kbd>C</kbd> to add a cue at the playhead, and export burned-in, as a toggle-able soft subtitle track, or as a sidecar `.srt` — see [Captions and subtitles](#captions-and-subtitles)
- **Resizable workspace**: drag the splitters between Library, Preview and Inspector, and the divider above the timeline (or focus one and use the arrow keys; double-click resets it). Collapse the side panels, pick S / M / L control density, fill the window or centre it, and **Reset layout** from the header. The layout is remembered per browser
- Merge timeline to MP4 or edit-friendly ProRes MOV via FFmpeg WebAssembly; MOV supports ProRes LT, 422 and 422 HQ profiles
- **Intercut generator**: pick two or three library clips and bake an accelerating strobe or explicit interval-list cut pattern (for example `2, 1, 1, 2, 3, 2`) via local FFmpeg (frame-accurate cuts; sound can follow picture, or every source can stay a steady audio stream for the whole output) — no cloud GPU / RIFE
- **Intelligent render plan**: Before rendering, see whether the merge will be lossless concat (fast, no quality loss) or re-encoding, with the specific reason
- Save/load projects locally as JSON with embedded source media
- Save/load projects remotely via a contabo_storage_manager-compatible HTTP endpoint with uploaded source media ([ford442/contabo_storage_manager](https://github.com/ford442/contabo_storage_manager))

## Rendering Strategy

When you click "Render", the app automatically decides whether to use **lossless concat** (fast) or **re-encoding** (necessary for effects). The render plan is displayed before and during rendering so you know what to expect:

- **Lossless concat** (fast, no quality loss): All clips are plain video with no fades, transitions, Picture-in-Picture, or text overlays
- **Re-encoding** (when needed for):
  - Fades on any clip (videoFadeIn/Out or audioFadeIn/Out)
  - Audio-only clips (WAV/MP3)
  - Transitions between clips
  - Picture-in-Picture overlays (layerIndex > 0)
  - Text overlays (captions, tickers, titles)

The app shows you the plan and reason before rendering starts, so you understand why a "simple" merge might take longer or look slightly different.

In Inspector → Export → Output, choose MP4 (default) or ProRes MOV. ProRes files
are substantially larger. The same section has independent light denoise/deband
and audio cleanup options (80 Hz high-pass, light noise reduction and loudness
normalization); both run as a final pass and do not depend on RIFE.

## Hugging Face RIFE

Frame interpolation for the app runs on the Space sourced from
[`huggingface/RIFE/`](huggingface/RIFE/)
([1inkusFace/RIFE](https://huggingface.co/spaces/1inkusFace/RIFE)).
In Library, open **Batch process clips…**, select one or more videos, then
choose **HF RIFE interpolation** or **Browser FFmpeg cleanup / conversion**.
RIFE supports MP4 and ProRes MOV output; optional light denoise/deband and
audio cleanup can be enabled independently. Processed clips replace their
library sources and can be downloaded together from the batch panel.
To run that same v4.26 pipeline on a Colab GPU:

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/ford442/clip_stacker/blob/main/huggingface/RIFE/RIFE_Colab.ipynb)

## Google Drive import and segment extract / replace

**Import from Drive** (toolbar, next to *Add clips*) opens the Google Drive Picker and adds the chosen audio/video to the media library as a *reference* — `{ kind: 'drive', fileId, name, size, mimeType }`. Nothing is downloaded. References live in this browser only (`clip_stacker.driveLibrary.v1`); the OAuth token is kept in memory and never written to storage. The scope is `drive.file`, so the app can only read files you pick.

Build-time configuration (Google Cloud OAuth *Web* client; add the app's origin under *Authorized JavaScript origins*, enable the Drive and Picker APIs):

| Variable | |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | OAuth client id (required) |
| `VITE_GOOGLE_API_KEY` | Browser API key for the Picker (required) |
| `VITE_GOOGLE_APP_ID` | Cloud project number; needed for `drive.file` grants to cover picked files |

Without the first two, the button explains what is missing.

**Segment extract / replace** (Inspector → Clip → *Segment extract / replace*, and *Extract segment…* on each Drive file):

- *Extract segment…* cuts `[start, end]` of the clip. Small and local media is cut in the browser (FFmpeg.wasm, stream copy first, exact re-encode if the copy is not the right length). Large Drive files and remote URLs go to a Contabo `extract` job, which downloads straight from Drive; the browser never holds them. A clip over 256 MB is cut on the server only if it is already in the remote library (*Save remote*).
- *Send to processing* picks where the segment is processed: **Browser FFmpeg**, **HF RIFE Space**, **Colab (manual)** (download the cut, process it, import the result) or **Contabo job** (`extract` or `rife`).
- The selected video clip's RIFE controls also send its trimmed range directly to the Space; choose MP4 or ProRes MOV before processing.
- *Replace with result* swaps the processed segment in at the same timeline position as one undo step. A clip is cut into `[before][replaced][after]` for a sub-range; a transition into or out of the clip stays attached.

Every result has to be **exactly as long as the segment** (±0.25 s, trimmed to the exact length on replace), otherwise the cut, import or replace is refused. That keeps later items in place and a later lossless concat possible. For the same reason only RIFE *interpolation* is offered here, not Boomerang. Sub-range replace needs a clip that plays at source speed (no speed change, loop, reverse or speed automation); those clips can be replaced over their whole trimmed range.

The Contabo job API (`POST/GET /webhook/clip-stacker/jobs`, `POST .../jobs/{id}/cancel`) is documented in `contabo_storage_manager`; the code is in `src/utils/segments/` and `ContaboStorageManagerClient`.

## Tech Stack

- React 18 + TypeScript
- Vite 8 (bundler and dev server; Node `^20.19.0 || >=22.12.0`)
- FFmpeg WebAssembly (`@ffmpeg/ffmpeg`)
- WebGPU preview compositor (shared device) + **gpu-chores** for import histogram / library thumbs (CPU/Worker fallback; never a second `GPUDevice`)

## Local Development

```bash
# Install dependencies
npm install

# Start development server (hot reload)
npm run dev
```

Open <http://localhost:5173> in your browser.

> **Note:** The app requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers for FFmpeg WASM (SharedArrayBuffer). These are set automatically by the Vite dev server and preview server.

## Build

```bash
npm run build
```

Output goes to `dist/`. Preview the production build with:

```bash
npm run preview
```

## Type Checking & Tests

```bash
npm run typecheck   # tsc --noEmit, matches the CI gate
npm run lint        # ESLint: 0 errors required, warnings allowed
npm run check:cycles  # madge: 0 import cycles in src/
npm test -- --run   # Vitest suite
```

CI (`.github/workflows/test.yml`) runs `npm ci`, `npm run typecheck`, `npm test -- --run`, and `npm run build` on every push/PR.

## Deploy

```bash
npm run deploy
```

Runs `npm run build` then uploads `dist/` to `test.1ink.us/clip-stacker` via SFTP using `deploy.py`.

For Apache deployments, `public/.htaccess` is copied into `dist/` during the build so the deployed `/clip-stacker/` directory serves the required COOP/COEP headers for FFmpeg WASM, plus a `Content-Security-Policy` header matching `src/utils/csp.ts` (a test fails if they drift). nginx deployments still need the equivalent headers configured in the server's location block.

### Content-Security-Policy

The app ships with a CSP that allows:

- `'wasm-unsafe-eval'`, `script-src blob:`, and `worker-src blob:` for FFmpeg WebAssembly (dynamic core imports via blob URLs)
- `blob:` / `data:` / `https:` for media previews, renders, and remote storage downloads
- `https:` / `wss:` for user-configurable storage endpoints, CDN fallbacks, and HuggingFace RIFE
- Google Drive import only: `accounts.google.com/gsi/client` and `apis.google.com` scripts, `accounts.google.com/gsi/style`, and `accounts.google.com/gsi/`, `docs.google.com`, `content.googleapis.com` frames

`connect-src` and `media-src` intentionally allow `https:` because storage endpoints and signed media URLs are not known at build time.

The policy lives only in `src/utils/csp.ts`: `cspMetaPlugin` writes the `<meta>` tag into `index.html` at build time (do not hand-write one — the build refuses it), and `vite.config.ts` sends the same policy as the dev/preview header.

### Self-hosted FFmpeg cores

Both FFmpeg cores are served from the app itself — `public/ffmpeg-core/` (single-threaded) and `public/ffmpeg-core-mt/` (multi-threaded, used when the page is cross-origin isolated) — with jsDelivr/unpkg only as fallbacks. They are copied verbatim from the `@ffmpeg/core` / `@ffmpeg/core-mt` devDependencies by `npm run sync:ffmpeg-core`; after bumping either package, run it, update `FFMPEG_CORE_VERSION` in `src/ffmpeg/ffmpegCommon.ts`, and commit `public/`. `npm run sync:ffmpeg-core -- --check` fails when they disagree.

### Storage backend hardening

The client can only mitigate token theft so far (session-scoped storage + CSP). For stronger protection, extend `contabo_storage_manager` to:

1. **Session token exchange** — `POST /webhook/clip-stacker/session` accepts a long-lived API key once and returns a short-lived JWT (e.g. 15 minutes) used for subsequent requests.
2. **Presigned media URLs** — return time-limited signed GET/PUT URLs for media uploads and downloads so the Bearer token is not sent on every media fetch.

## Project Structure

```
clip_stacker/
├── index.html             # Vite/React entry point
├── vite.config.ts         # Vite configuration (CORS headers, optimizeDeps)
├── tsconfig.json          # TypeScript configuration
├── package.json           # Dependencies and scripts
├── public/
│   └── .htaccess          # Apache headers for SharedArrayBuffer/FFmpeg WASM
├── deploy.py              # SFTP deployment script
├── src/
│   ├── main.tsx           # React app bootstrap
│   ├── App.tsx            # Root component, app-level state
│   ├── index.css          # Global styles
│   ├── gpu-chores/        # Import histogram / thumbs (adopt preview GPUDevice)
│   ├── types/
│   │   └── index.ts       # Shared TypeScript types (Clip, Project, etc.)
│   ├── ffmpeg/
│   │   └── ffmpegService.ts  # All FFmpeg WASM logic
│   ├── utils/
│   │   ├── media.ts       # Media loading helpers (duration, objectURL)
│   │   └── project.ts     # Project serialization and storage client
│   ├── components/
│   │   ├── Toolbar.tsx    # Add clips / render / save / load buttons
│   │   ├── StorageRow.tsx # Remote storage endpoint controls
│   │   ├── ClipLibrary.tsx # Clip list panel
│   │   ├── Inspector.tsx  # Per-clip trim and fade editor
│   │   ├── Preview.tsx    # Video/audio preview and download link
│   │   └── Timeline.tsx   # Ordered timeline with reorder controls
│   └── wasm/              # emscriptenLoader.ts (load + heap boundary) and module bindings
├── native/                # C++ WASM (CMake + Emscripten)
│   ├── toolchain.cmake    # Shared compile/link flags
│   ├── emsdk-version      # Pinned Emscripten SDK (CI + committed artifacts)
│   ├── common/include/    # cs_status.h, cs_alloc.h, cs_math.h
│   ├── audio_analysis/    # kissfft bands + beat envelope
│   ├── video_stabilize/   # Lucas–Kanade affine matrices
│   ├── media_engine/      # Timeline PCM mix, insert FX, lane buses / loudness, WSOLA time stretch
│   └── whisper/           # Opt-in auto-caption module (whisper.cpp, not committed)
├── public/wasm/           # Committed .js/.wasm artifacts
└── dist/                  # Built output (generated by npm run build)
```

## Native WASM modules

Rebuild with the Emscripten SDK pinned in `native/emsdk-version` (6.0.6, what
CI uses; any SDK >= 3.1.64 builds, but only the pinned one reproduces the
committed bytes):

```bash
npm run build:wasm            # every module via CMake → public/wasm
npm run build:wasm:debug      # -O0 -g, ASSERTIONS → native/build-debug/wasm; load with ?wasm_debug
npm run build:whisper         # opt-in auto-caption module (clones whisper.cpp)
npm run test:native           # host (non-Emscripten) DSP tests via ctest, -Werror + ASan/UBSan
```

The configure also exports `compile_commands.json` for clangd — see
[`native/README.md`](native/README.md#clangd) (`WASM_BUILD_DIR`, `--query-driver`).

CI fails if `public/wasm/` drifts from a clean rebuild, or if any module's gzipped `.wasm` exceeds **200 KB**.

| Module | Role | TS binding |
|--------|------|------------|
| `audio_analysis` | FFT bands + beat envelope | `src/wasm/audioAnalysis.ts` |
| `video_stabilize` | Optical-flow affine | `src/wasm/videoStabilize.ts` |
| `media_engine` | Timeline mix / resample / insert FX / lane buses / loudness | `src/wasm/mediaEngine.ts` |
| `media_engine` | WSOLA rate remap | `src/wasm/timeStretch.ts` |
| `media_engine_fx` | The bus graph alone, glue-free, for the preview AudioWorklet | `src/wasm/audioFx.ts` |

Export premix runs on the media engine when it loads: polyphase resampling, volume/pan automation curves and fades in C++, streamed in chunks straight into the AAC encoder, so long timelines no longer hit the 45-minute `OfflineAudioContext` cap. Disable with `?no_media_engine` to force `OfflineAudioContext` (and, past 45 minutes, FFmpeg audio mux). Do not put mix/EQ DSP in `canvas-renderer` or FFmpeg `filter_complex`.

Each lane is also a bus (the lane header's **FX**): an insert chain (EQ, compressor, gate, de-esser, true-peak limiter) and an optional sidechain duck under another lane; the Master row has master-bus FX and a BS.1770 **LUFS** meter, and Export → **Loudness** normalizes the delivered mix to a target (−14 / −16 / −23 LUFS or custom) in two passes with a true-peak ceiling. Preview runs the same C++ bus graph in an AudioWorklet (`?no_audio_fx` turns it off).

## Notes on project persistence

Remote save/load expects an endpoint compatible with:

- `POST <endpoint>` with body `{ "name": "...", "payload": { ...project... } }`  
  Response: `{ "status": "success", "name": "..." }` on success
- `GET <endpoint>?name=...` returning `{ "payload": { ...project... } }`
- `GET <endpoint>` (no name) returning `{ "projects": [{ "name": "...", "modified": <timestamp> }, ...] }`
- `DELETE <endpoint>?name=...` returning `{ "status": "success" }`
- `POST <endpoint>/media` with `multipart/form-data` (`file`, `name`) returning `{ "url": "..." }`

**Canonical endpoint path:** `/webhook/clip-stacker`

Example full URL: `https://storage.example.com/webhook/clip-stacker`

### Preview proxies

Big camera files (4K, multicam stacks) can get a **preview proxy**: click
**Build proxy** on a library row. One clip builds at a time in the background
(badge: *Original* → *Building n%* → *Proxy*). A proxy is H.264, short side
960 px, the source frame rate capped at 30 (a 24 fps source stays 24), long
GOP, no audio — the preview's audio graph still reads the original's sound.

- Scrub, playback and stabilization analysis read the proxy. **Export, Force
  FFmpeg and every path that writes the deliverable always read the original
  file**, so the output resolution never comes from the proxy.
- *Use proxies for playback* (in the Library, shown once a proxy exists) turns
  them off for the session; preview then decodes originals and looks the same.
- Saved projects keep a small `proxy` record per clip (`profile`, source
  `hash`, `width`, `height`) — never the bytes. The bytes live in the
  working-media store keyed by `(sourceHash, profile)`; deleting the last clip
  that uses a proxy deletes it, and an undo writes it back while it is still
  in memory.
- **Until the persistent media store (#279) lands, that store is in memory**:
  proxies do not survive a reload, and a reloaded project falls back to the
  original (badge *Original*) until the proxy is rebuilt.

### Authentication

Auth is optional and handled via `Authorization: Bearer <token>` header. If your deployment requires authentication, provide an API key or bearer token in the app's optional auth token field. The client automatically prefixes the token with `Bearer` if not already present.

The token is stored in **sessionStorage** (tab-scoped) — not `localStorage` — and is cleared when the browser tab is closed. A one-time migration removes any legacy copy from `localStorage` on first load.

> **Security note:** For production deployments, prefer short-lived session tokens or presigned media URLs on the storage backend so a compromised tab session has limited blast radius. See [Storage backend hardening](#storage-backend-hardening) below.

### Errors & Diagnostics (Never Silent)

Render and "Extract Audio" **never fail silently**. All FFmpeg `exec`/`writeFile`/`readFile` calls are wrapped; the log handler records every line (not just progress); errors are augmented with the last 25 FFmpeg logs and surfaced in the status bar + console. A **📋 Copy Debug** toolbar button exports a full markdown debug report (environment, render plan, clips, last FFmpeg command, filter_complex, and logs). On render failure, a **Render Failure** panel shows the error, expandable command/logs, and quick retry.

### Debug render script

```bash
./scripts/debug-render.sh          # unit tests + production build
./scripts/debug-render.sh --serve    # also start preview for manual R002/R003 tests
```

See `docs/render-test-matrix.md` for manual test cases.

### Shader-filled text overlays

Text overlays can use a procedural shader fill (plasma, gradient, etc.) instead of a solid color. Which export path preserves this:

| Backend | Shader fill preserved? |
|---|---|
| GPU timeline compositor (WebCodecs export, WebGPU preview) | ✅ Yes — same shader renderer as preview |
| FFmpeg (`drawtext`, used for re-encodes, Force FFmpeg, or when the GPU path is unavailable) | ❌ No — falls back to solid `fontcolor` |
| Canvas audio-reactive renderer | ❌ No — text overlays aren't composited on this path |

If a render falls back to FFmpeg, the app warns in the status bar and on the render plan summary. Switch a shader overlay's Fill to Solid in the Text Overlay panel if you need the exact same look on every export path.

### Captions and subtitles

Captions are a separate track from text overlays: one list of time-coded cues
(`CaptionEntry`) that round-trips through subtitle files rather than a pile of
individually timed overlays.

**Editing.** The **CC** lane sits under the timeline ruler. Click a chip to
select it, drag either edge to retime it, or double-click empty lane space to
add a cue there. <kbd>C</kbd> adds a cue at the preview playhead. Text, exact
timings, and the project-wide style live in the Inspector's **Captions** tab.

**Import.** *Import .srt / .ass* replaces the caption track with the cues from
the file (undoable). The SubRip parser is deliberately lenient — CRLF and lone
CR line endings, a UTF-8 BOM, missing sequence numbers, missing blank lines
between cues, `.`-separated milliseconds and trailing SubRip coordinates all
parse. ASS/SSA import reads the `[Events]` section's dialogue rows and strips
inline override tags; styling comes from the project's caption style.

**Export.** Three modes, chosen under *Caption export* in the Captions tab:

| Mode | What you get | Cost |
| --- | --- | --- |
| Off | Captions stay on the timeline only | — |
| Burn into video | Cues drawn into the picture with libass (`ass` filter) | One extra video re-encode; audio is stream-copied |
| Soft subtitle track | A `mov_text` track players can toggle (VLC, QuickTime, Chrome) | Stream copy only |

*Export .srt* downloads the track as a sidecar file with no re-encode at all.

Burn-in is drawn by the compositor when the GPU (WebCodecs) path runs: the
cues land in the same pass as the titles, so there is no second video encode.
Every other case — the soft `mov_text` mux, Force FFmpeg, and no-WebGPU
machines — still goes through the **post-pass over the finished MP4**
(`src/ffmpeg/captions.ts`), which is why that post-pass stays. The soft mux is
a stream copy either way and never burns anything into the picture.

**Style.** One project-wide style with optional per-cue overrides, sharing the
`TextOverlayStyle` fields (font, size, colour, background box, position). Note
the anchor differs from a text overlay: a caption's `x`/`y` place its *bottom
centre*, which is how subtitles are conventionally positioned. Burn-in
generates an ASS document with one `Style:` row per distinct override, so
per-cue styling survives.

**Auto-captioning** transcribes the timeline (or just the selected clip) into
cues. *Auto-caption* in the Captions tab mixes the audio exactly as the export
premix does — trims, mute, volume automation and speed remaps included — hands
it to a `CaptionProvider`, and puts the result on the CC lane as one undo step.
Choose *Merge with existing cues* to keep what is already there; otherwise the
track is replaced. Cancelling leaves the previous track untouched.

Two providers ship, both behind `src/utils/captionProvider.ts` so the caption
feature knows nothing about any model:

| id | Runs | Needs |
|----|------|-------|
| `whisper-wasm` | In the page, in a worker | `public/wasm/whisper.js` (`npm run build:whisper`) + a ggml model (`public/models/ggml-tiny-q5_1.bin` by default, cached in IndexedDB) |
| `whisper-http` | Your own server | An `https://` endpoint typed into the Captions tab; audio is POSTed as a WAV |

Neither is required. Both WASM build and weights are optional downloads and are
not committed, so with nothing deployed the Captions tab shows a one-line reason
instead of the button — the same "missing WASM disables the feature" rule the
audio analysis module follows. Only `tiny`/`base` are realistic in a tab;
`small`+ belongs on a server. No API key is stored in the client: the HTTP
provider expects an endpoint you control. See `native/whisper/README.md`.

Captions are **drawn in the preview** at their CC-lane timings, bottom-centre
anchored with the resolved per-cue style. *Show captions in preview* in the
Inspector's Captions tab turns the overlay off without touching the track.

### Fonts for text overlays

Text overlays support a small set of bundled, license-safe fonts. The same typeface is used for Canvas 2D preview and FFmpeg `drawtext` export so glyph metrics match.

Bundled fonts (under `public/fonts/`):

| id          | Label            | File                | Virtual (FFmpeg) |
|-------------|------------------|---------------------|------------------|
| roboto      | Roboto Regular   | Roboto-Regular.ttf  | roboto.ttf       |
| robotoBold  | Roboto Bold      | Roboto-Bold.ttf     | robotoBold.ttf   |
| serif       | Serif            | DejaVuSerif.ttf     | serif.ttf        |
| mono        | Monospace        | DejaVuSansMono.ttf  | mono.ttf         |

- Default for new and legacy overlays (no `font` field) is `roboto`.
- `TextOverlay.font` stores the id; unknown ids fall back to the default on load.
- Adding a font: drop a `.ttf` into `public/fonts/`, register it in `BUNDLED_FONTS` (src/utils/textOverlay.ts), add a matching `@font-face` in `src/styles/fonts.css`, and (if needed) an entry in `FONT_URL_BY_VIRTUAL` (src/ffmpeg/core.ts).

If a render or extract does nothing / stops with no message:
- Check the browser console (all `[FFmpeg]` lines are now printed).
- Immediately click **📋 Copy Debug** — it includes status, render plan, recent logs, UA, and `crossOriginIsolated`.
- The status text will contain a section "Recent FFmpeg logs (last 25)" with the real error (e.g. missing audio stream, bad filter syntax, OOM during write).

Previous save/load errors:
- Non-2xx responses are caught and displayed in the app status: `Remote save failed (status)` or `Remote load failed (status)`
- Network errors also bubble up as error messages in the status text

## Troubleshooting

### Common failure modes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Render hangs after several merges | FFmpeg VFS memory pressure — temporary files not fully reclaimed | Click **🔄 Reset FFmpeg** then retry. The app automatically cleans VFS after every render (success or failure), but a manual reset is sometimes needed after multiple large renders. |
| "FFmpeg load failed" / FFmpeg won't initialize | Browser network issue downloading core.wasm, or SharedArrayBuffer not available | Check `crossOriginIsolated` in the browser console. Use **⚠️ Retry FFmpeg load** button. Ensure COOP/COEP headers are set (see Deploy section). |
| Output is corrupted or has A/V sync issues | Lossless concat on clips with mismatched parameters | Enable **Force re-encode** in the encoder controls to bypass lossless concat and re-encode everything through libx264. |
| Render fails with "does not contain" or "matches no streams" | Audio-only clip processed through wrong path | Check that WAV/MP3 clips have the correct `kind: 'audio'` detected (visible in Inspector). |
| FFmpeg repeatedly errors after a previous failure | Stale state in the FFmpeg WASM instance | Click **🔄 Reset FFmpeg** to tear down and rebuild the engine on the next render. |
| "Output file does not contain any stream" | Clips have incompatible parameters (different resolution/fps) | Enable **Force re-encode** to normalize all clips to the same output format. |

### Recovery workflow

1. Click **📋 Copy Debug** immediately to snapshot logs, render plan, and browser context.
2. Share the copied text in your bug report or support ticket.
3. If renders are hanging or erroring repeatedly, click **🔄 Reset FFmpeg** to reinitialize the engine (this clears all VFS state and re-allocates the WASM worker on the next render).
4. If FFmpeg failed to load entirely, use the **⚠️ Retry FFmpeg load** button that appears in the toolbar on a load failure.

### RIFE frame interpolation failures

RIFE processing uses the public HuggingFace Space `1inkusFace/RIFE`. If RIFE fails:
- The Space may be cold-starting (usually resolves within 30 seconds — try again).
- Large clips may time out — trim to a shorter segment before applying RIFE.
- The Space may have queued jobs; the status bar shows upload/processing/download progress.

### Setup with contabo_storage_manager

To use this with [ford442/contabo_storage_manager](https://github.com/ford442/contabo_storage_manager):

1. Deploy `contabo_storage_manager` with the `/webhook/clip-stacker` endpoint implemented
2. Include the chunked-upload router from `contabo_storage_manager/python/chunked_media_upload.py` (see that folder's README) and reload nginx from `contabo_storage_manager/config/storage.noahcohn.com.conf`
3. In the app, enter the full URL to your deployment's `/webhook/clip-stacker` path
4. (Optional) Provide a Bearer token if your deployment requires authentication
5. Use "Save remote" and "Load remote" buttons to persist projects

#### Chunked / resumable media uploads

Remote save uploads each clip's source file to `{endpoint}/media`. Behavior:

| File size | Path | Notes |
|-----------|------|-------|
| ≤ 10 MiB | Single `multipart/form-data` POST | Low-latency fast path |
| > 10 MiB | Session-based chunked upload | 5 MiB chunks by default |

Chunked protocol (relative to the media endpoint):

- `POST /upload/init` → `{ uploadId, chunkSize }`
- `PUT /upload/{uploadId}/{chunkIndex}` with `Content-Range` → `{ received }`
- `POST /upload/{uploadId}/complete` → `{ url }` (same response shape as the single-request path)
- `GET /upload/{uploadId}/status` → `{ receivedChunks }` for resume

In-flight `uploadId` + completed chunk indexes are stored in `localStorage` (key `clip_stacker_upload_sessions_v1`) so closing the tab or sleeping the laptop mid-upload resumes from the last confirmed chunk on the next save of the same file. Individual chunks retry up to 3 times before the clip-level retry UI appears. Abandoned server-side staging dirs are garbage-collected after 24 hours. Server max file size defaults to **10 GiB**.
