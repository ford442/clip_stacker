# clip_stacker

A lightweight web app for stacking clips into one merged MP4.

## Features

- Upload and keep multiple clips in project state (MP4 video, WAV/MP3 audio)
- Auto-select the newest uploaded clip while retaining older clips
- Trim each clip with start/end offsets
- Reorder clips in a timeline editor
- Apply per-clip fade in/out controls for video and audio
- Merge timeline into one MP4 via FFmpeg (WebAssembly in-browser)
- Save/load project metadata locally as JSON
- Save/load project metadata remotely via a `ford442/contabo_storage_manager`-compatible HTTP endpoint

## Run locally

Use any static web server from repository root. Example:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

## Notes on project persistence

Remote save/load expects an endpoint compatible with:

- `POST /contabo_storage_manager/projects` with body `{ "name": "...", "payload": { ...project... } }`
- `GET /contabo_storage_manager/projects?name=...` returning `{ "payload": { ...project... } }`

If your `contabo_storage_manager` deployment uses a different route shape, enter the correct endpoint URL in the app before saving/loading.
