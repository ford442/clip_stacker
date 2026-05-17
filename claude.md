# Claude Development Guide for clip_stacker

## Project Overview

**clip_stacker** is a React + TypeScript + Vite web app for uploading, trimming, reordering, fading, and merging video/audio clips into a single MP4 file. All processing happens in the browser using FFmpeg WebAssembly.

**Live Demo:** https://ford442.github.io/clip_stacker/

## Tech Stack

- React 18 + TypeScript
- Vite 5 (bundler, dev server)
- `@ffmpeg/ffmpeg` 0.12.x (WebAssembly FFmpeg)
- `@ffmpeg/util` 0.12.x (fetchFile, toBlobURL)

## Browser Requirements

- Chrome/Firefox/Edge with SharedArrayBuffer support
- HTTPS or localhost (required for SharedArrayBuffer)
- The server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers

## Project Structure

```
clip_stacker/
├── index.html             # Vite/React entry point
├── vite.config.ts         # Vite config — CORS headers, optimizeDeps exclusions
├── tsconfig.json          # TypeScript config
├── package.json           # Scripts: dev, build, preview, deploy
├── deploy.py              # SFTP deployment to 1ink.us
├── git.sh                 # Git helper
├── src/
│   ├── main.tsx           # React bootstrap (createRoot)
│   ├── App.tsx            # Root component — all app state lives here
│   ├── index.css          # Global dark-theme styles
│   ├── types/
│   │   └── index.ts       # Clip, SerializedClip, Project interfaces
│   ├── ffmpeg/
│   │   └── ffmpegService.ts  # FFmpeg singleton, filter building, two-pass merge
│   ├── utils/
│   │   ├── media.ts       # loadMediaInfo, getMediaInfo, createClipId
│   │   └── project.ts     # serializeProject, applyProjectData, ContaboStorageManagerClient
│   └── components/
│       ├── Toolbar.tsx    # File inputs, merge/save/load buttons, status text
│       ├── StorageRow.tsx # Remote endpoint, auth token, project name inputs
│       ├── ClipLibrary.tsx # Clip list with selection
│       ├── Inspector.tsx  # Controlled inputs for trim and fade values
│       ├── Preview.tsx    # video/audio preview; shows download link after render
│       └── Timeline.tsx   # Ordered clip list with ↑/↓ reorder buttons
└── dist/                  # Built output
```

## Local Development

```bash
npm install
npm run dev
```

Navigate to `http://localhost:5173`. The dev server injects the required COOP/COEP headers.

## Key Architecture Notes

### State Management
All app state (`clips`, `selectedClipId`, `status`, `outputUrl`) lives in `App.tsx` via `useState`. Components receive state as props and call handler callbacks — no external state library.

### FFmpeg Service (`src/ffmpeg/ffmpegService.ts`)
- Singleton FFmpeg instance (loaded once, reused across renders)
- Loads FFmpeg core from `https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd` via `toBlobURL`
- Two rendering paths:
  1. **Lossless concat**: all clips are plain video with no fades → uses `concat` demuxer with `-c copy`
  2. **Two-pass encode**: any clip has fades or is audio-only → Pass 1 re-encodes each clip to h264/aac, Pass 2 concatenates intermediates with `-c copy`

### FFmpeg WASM + Vite Setup
- `@ffmpeg/ffmpeg` and `@ffmpeg/util` are excluded from Vite's `optimizeDeps`
- COOP/COEP headers are set in `vite.config.ts` for both `server` and `preview`
- FFmpeg core files are fetched from CDN using `toBlobURL` (avoids copying WASM to public/)

### Inspector Component
Uses controlled local state (`useState`) that syncs with the selected clip via `useEffect`. Changes propagate up to `App.tsx` via the `onChange` callback, which updates the clip and calls `sanitizeClipAdjustments`.

## Common Tasks

### Adding a new clip property
1. Add field to `Clip` and `SerializedClip` in `src/types/index.ts`
2. Initialize the field in `App.tsx` → `handleAddClips`
3. Add serialization in `serializeProject()` and deserialization in `applyProjectData()` in `src/utils/project.ts`
4. Add UI controls in `Inspector.tsx`

### Changing the FFmpeg core version
Update the `baseURL` in `src/ffmpeg/ffmpegService.ts`:
```typescript
const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
```
Match the `@ffmpeg/ffmpeg` package version requirements.

### Modifying the merge pipeline
Edit `src/ffmpeg/ffmpegService.ts`. The main entry point is `mergeClips()`.

## Build & Deploy

```bash
npm run build       # outputs to dist/
npm run preview     # preview production build at localhost:4173
npm run deploy      # build + SFTP upload to 1ink.us
```

## Remote Storage Integration

The app includes a `ContaboStorageManagerClient` (`src/utils/project.ts`) for saving and loading project metadata to a remote endpoint.

### Protocol

- **Save:** `POST <endpoint>` with body `{ "name": "...", "payload": { ...project... } }`
- **Load:** `GET <endpoint>?name=...` expects response `{ "payload": { ...project... } }`

### Authentication

Optional `Authorization: Bearer <token>` header. The client automatically prefixes raw tokens with `Bearer`.

### Canonical Endpoint

The backend (`ford442/contabo_storage_manager`) implements `/webhook/clip-stacker`.

Full URL example: `https://storage.example.com/webhook/clip-stacker`

### Error Handling

- Non-2xx responses throw: `Remote save failed (status)` or `Remote load failed (status)`
- Errors propagate to `App.tsx` handlers which display them in `status` state
- See `handleSaveRemote` and `handleLoadRemote` in `App.tsx` for implementation
