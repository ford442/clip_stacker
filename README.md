# clip_stacker

A web app for stacking video and audio clips into one merged MP4, powered by FFmpeg WebAssembly.

## Features

- Upload and keep multiple clips in project state (MP4 video, WAV/MP3 audio)
- Auto-select the newest uploaded clip while retaining older clips
- Trim each clip with start/end offsets
- Reorder clips in a timeline editor
- Apply per-clip fade in/out controls for video and audio
- Merge timeline into one MP4 via FFmpeg (WebAssembly, fully in-browser)
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

## Tech Stack

- React 18 + TypeScript
- Vite 5 (bundler and dev server)
- FFmpeg WebAssembly (`@ffmpeg/ffmpeg`)

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

## Deploy

```bash
npm run deploy
```

Runs `npm run build` then uploads `dist/` to `test.1ink.us/clip-stacker` via SFTP using `deploy.py`.

For Apache deployments, `public/.htaccess` is copied into `dist/` during the build so the deployed `/clip-stacker/` directory serves the required COOP/COEP headers for FFmpeg WASM, plus a `Content-Security-Policy` header aligned with the CSP meta tag in `index.html`. nginx deployments still need the equivalent headers configured in the server's location block.

### Content-Security-Policy

The app ships with a CSP that allows:

- `'wasm-unsafe-eval'`, `script-src blob:`, and `worker-src blob:` for FFmpeg WebAssembly (dynamic core imports via blob URLs)
- `blob:` / `data:` / `https:` for media previews, renders, and remote storage downloads
- `https:` / `wss:` for user-configurable storage endpoints, CDN fallbacks, and HuggingFace RIFE

`connect-src` and `media-src` intentionally allow `https:` because storage endpoints and signed media URLs are not known at build time.

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
├── git.sh                 # Git helper script
├── src/
│   ├── main.tsx           # React app bootstrap
│   ├── App.tsx            # Root component, app-level state
│   ├── index.css          # Global styles
│   ├── types/
│   │   └── index.ts       # Shared TypeScript types (Clip, Project, etc.)
│   ├── ffmpeg/
│   │   └── ffmpegService.ts  # All FFmpeg WASM logic
│   ├── utils/
│   │   ├── media.ts       # Media loading helpers (duration, objectURL)
│   │   └── project.ts     # Project serialization and storage client
│   └── components/
│       ├── Toolbar.tsx    # Add clips / render / save / load buttons
│       ├── StorageRow.tsx # Remote storage endpoint controls
│       ├── ClipLibrary.tsx # Clip list panel
│       ├── Inspector.tsx  # Per-clip trim and fade editor
│       ├── Preview.tsx    # Video/audio preview and download link
│       └── Timeline.tsx   # Ordered timeline with reorder controls
└── dist/                  # Built output (generated by npm run build)
```

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
2. In the app, enter the full URL to your deployment's `/webhook/clip-stacker` path
3. (Optional) Provide a Bearer token if your deployment requires authentication
4. Use "Save remote" and "Load remote" buttons to persist projects
