# Project API, `cs` CLI and MCP server

One scripting surface, `window.clipStacker.project`, drives Clip Stacker
from code. The UI's File menu, the `?test_harness` API, the `cs` CLI and the
MCP server all go through it, so a script edits, imports and renders exactly
as a click does.

## `window.clipStacker.project`

Installed at startup (`src/actions/projectApiInstall.ts`) as a stub whose
methods load the implementation (`src/actions/projectApi.ts`) on first call,
so **every method returns a Promise**. `clipStacker.api.version` (and
`project.version`) is the API version, `1`. Same-page only, like
`clipStacker.finishing`: there is no cross-origin `postMessage` listener.

| Method | What it does |
|---|---|
| `getState()` | The open project as its saved JSON (`Project`: clips, tracks, transitions, titles, captions, finishing, buses, timecode). |
| `loadProject(json, { mediaRoot?, files? })` | Open a saved project; media found by name / hash / Drive, the rest offline. Replaces the open project. |
| `apply(ops, { mediaRoot? })` | Apply `ProjectOp`s in order as **one undo step, all or nothing**. Returns `{ ok, errors, refused?, results }`; `results[i]` holds ids op *i* created. |
| `validate(ops)` / `schema()` / `agentBrief()` | Check ops; the JSON Schema (`docs/project-ops.schema.json`); instructions for an agent. |
| `importTimeline(text, { format?, fileName?, mediaRoot?, files?, rate? })` | Replace the project with an OTIO / FCPXML / EDL timeline (`docs/interchange.md`). |
| `exportTimeline('otio' \| 'fcpxml' \| 'edl', { mediaRoot? })` | The open timeline as text. |
| `exportStems({ trackIds?, includeMaster?, format?, normalize? })` | BWF stems + timeline + manifest, zipped; resolves with the report and an object URL. |
| `relink({ files })` | Relink offline clips from files (name, then hash). |
| `render(exportSettings?)` | Run the Render action (`{ outputResolution: '1920x1080' }`, …); resolves with `{ ok, url, status, encoderPath, plan }`. A refusal (an offline clip, nothing to render) is `ok: false` with the reason in `status`. |
| `onProgress(listener)` | Render / stems progress and status; returns an unsubscribe. |
| `undo()` / `redo()` | The editor's undo stack (an `apply` batch is one step). |

```js
const p = window.clipStacker.project;
const { clips, tracks } = await p.getState();
await p.apply([
  { op: 'trim', clipId: clips[0].id, trimStart: 1, trimEnd: 4 },
  { op: 'setTransition', afterClipIndex: 1, type: 'dissolve', duration: 1 },
  { op: 'setFinishing', preset: { apply: 'merge', finishing: { grain: { enabled: true, amount: 0.3 } } } },
  { op: 'setMasterBus', masterBus: { loudness: { targetLufs: -16, truePeakDb: -1 } } },
]);
const fcpxml = await p.exportTimeline('fcpxml');
```

### `ProjectOp`

`{ op: <name>, …fields }`. Times are seconds — `startTime` / `time` on the
output timeline, `trimStart` / `trimEnd` in the clip's source. Lane ids are
`tracks[].id`, clip ids `clips[].id`. Validation is strict and path-specific
(`ops[2].startTime must be ≥ 0`); unknown ops and fields are errors.

`addClip`, `placeClip`, `move`, `trim`, `split`, `duplicate`, `removeClip`,
`setClip`, `setTransition`, `setKeyframes`, `addTrack`, `setTrack`,
`setTrackAudioFx`, `setDuck`, `setMasterBus`, `setFinishing`, `addMarker`,
`setCaptions`, `setTextOverlay`, `setExportSettings`, `setTimecode`.

Each op is the pure edit or store action the UI runs
(`src/actions/projectOps/apply.ts`): drops and moves are `timeline/editModes`
overwrite / insert, `trim` re-lays the main lane through the same segment
maths, `split` is the Split action without beat snapping, `setFinishing` is
the finishing preset path. So a **locked lane refuses** a script the way it
refuses a drag — as `refused: { index, op, message }`, with nothing changed.
`setExportSettings` and `setTimecode` are settings, not undo steps.

The spec, the schema file and the validator come from one declarative table
(`src/actions/projectOps/spec.ts`). After changing an op, regenerate:

```bash
UPDATE_PROJECT_OPS_SCHEMA=1 npx vitest --run src/actions/projectOps
```

## `cs` — headless CLI (`scripts/cs/`)

```bash
npm run build
```

```bash
npm run cs -- render project.json --media ./media --preset 1080p30 --out out.mp4
```

```bash
npm run cs -- import timeline.otio --media ./media --out cut.json
```

```bash
npm run cs -- stems project.json --media ./media --normalize --out stems.zip
```

```bash
npm run cs -- export project.json --media ./media --format fcpxml --out cut.fcpxml
```

`cs` serves `dist/` with Vite's preview server in-process (COOP / COEP and
the CSP as `npm run preview`), opens the app in Chromium through Playwright
with the e2e SwiftShader flags (`--gpu` uses the machine's adapter instead),
serves `--media` same-origin at `/__cs_media/` (the API's `mediaRoot`, so
projects and timelines find files by name) and saves outputs through real
downloads. Progress is JSON lines on stdout; exit code `0` done, `2` refused
(an offline clip, nothing to render), `1` error. `CS_CHROMIUM=/path/to/chrome`
uses that browser instead of Playwright's download; presets are `720p30`,
`1080p30`, `1440p30`, `4k30` or `WIDTHxHEIGHT` (the export grid is 30 fps).
CI runs `cs render` on `e2e/fixtures/cs-smoke.project.json`.

## MCP server

```bash
claude mcp add clip-stacker -- node scripts/cs/mcp.mjs --media /path/to/media
```

`scripts/cs/mcp.mjs` (or `npm run cs -- mcp`) is an MCP server on stdio with
the tools `load_project`, `get_state`, `apply_ops`, `ops_schema`,
`import_timeline`, `export_timeline`, `export_stems`, `render` and `undo`,
each one call into `window.clipStacker.project` through the Playwright page.
The browser session opens on the first tool call. Paths are on the machine
running the server. Localhost only (stdio, no listening socket); the page
never sees credentials, and Drive import stays interactive in the app.
