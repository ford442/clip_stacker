---
title: RIFE
emoji: 🤨
colorFrom: purple
colorTo: red
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
---

# RIFE Space — interpolate, boomerang, smart stitch

This directory is the **single source of truth** for the HuggingFace Space:

- Space: <https://huggingface.co/spaces/1inkusFace/RIFE>
- Served at: `https://1inkusface-rife.hf.space`

The browser client (`src/utils/huggingface.ts`) calls it through the raw Gradio
HTTP API. Everything in `app.py` runs on the Space, not in the app bundle.

## Do not make a second copy

There used to be a duplicate at `src/hf_space/`. The two drifted: the live Space
ran an HTML-card reorder UI driven by a JS click bridge, while the repo copy had
been refactored to a `gr.Gallery` with pure Python state, and nothing recorded
which was deployed. Every fix had to be made twice or would regress whichever
copy was live.

That duplicate is gone. The Gallery implementation was kept — it needs no JS
bridge, and it supports first/last/move-to-position on top of up/down. If you
need to change the Space, change it here.

## Public endpoints

These `api_name` routes are the client's contract. Changing existing
positional arguments breaks `src/utils/huggingface.ts`. New trailing
optionals (output fps, folder path) are backward compatible.

| `api_name` | Inputs | Output |
|---|---|---|
| `interpolate_video` | video, multiplier (`"2"`/`"4"`/`"8"`), boomerang (bool), output fps (`"30"`/`"60"`/`"native"`, default `"30"`) | MP4 |
| `stitch` | videos or still images, resolution, audio, audio mode, overlay volume | MP4 |
| `morph` | 2-frame video, frame count, output fps | MP4 |
| `batch_interpolate` | videos (optional), multiplier, output fps (`"30"`/`"60"`/`"native"`), folder path (optional) | MP4 files (one per input, in order — no stitching, no boomerang) |
| `batch_interpolate_folder` | folder path on the Space, multiplier, output fps | MP4 files |

`output_fps` values:

- **30** — previous NLE remux. 4× of 24 fps still lands at 30 (extra frames dropped).
- **60** — true 60 fps CFR. RIFE still emits `input × multiplier` frames (24×4 = 96), then ffmpeg resamples to 60 with duration unchanged.
- **native** — remux at `input × multiplier` (24×4 = 96).

## ZeroGPU / folder batch

`interpolate_video` is the only interpolation entry that holds `@spaces.GPU` (180s lease). `batch_interpolate` and `batch_interpolate_folder` stay on CPU and call that function once per file so ZeroGPU is released between clips.

For a large folder of mp4s, do **not** upload the whole directory through the Gradio File widget — that still ships every byte before work starts. Copy or mount the folder onto the Space (`workspace_temp/`, `/data/`, or `$RIFE_BATCH_ROOT`) and pass the path. A local script can also loop `interpolate_video` itself, one clip per request.

## Deploying

The Space is a git repository on HuggingFace. To push this directory to it:

```bash
npm run deploy:rife-space
```

or directly:

```bash
scripts/deploy-rife-space.sh
```

The script clones the Space repo into a temp directory, copies the files from
this directory (`huggingface/RIFE/`) over it, and pushes. It needs a
HuggingFace token with write access to the Space in `HF_TOKEN` (or an existing
git credential helper).

After deploying, confirm the Space rebuilt cleanly — the first boot runs
`setup_environment()`, which pip-installs dependencies, clones Practical-RIFE
and downloads the RIFEv4.26 weights, so it takes several minutes.

## Tests

`tests/` covers the ffprobe-based stitch fast path and the morph resample math
against real ffmpeg output. It does not exercise RIFE itself, which needs a GPU
and the model weights.

```bash
cd RIFE && python -m pytest tests/ -q
```
