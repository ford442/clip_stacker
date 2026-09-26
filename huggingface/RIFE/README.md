---
title: RIFE
emoji: 🐨
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

These `api_name` routes are the client's contract. Changing a signature
breaks `src/utils/huggingface.ts`:

| `api_name`          | Inputs                                                  | Output |
|---------------------|---------------------------------------------------------|--------|
| `interpolate_video` | video, multiplier (`"2"`/`"4"`/`"8"`), boomerang (bool), output fps (`"30"`/`"60"`/`"native"`, default `"30"` for old callers) | MP4    |
| `stitch`            | videos or still images, resolution, audio, audio mode, overlay volume | MP4    |
| `morph`             | 2-frame video, frame count, output fps                    | MP4    |
| `batch_interpolate` | videos (multiple), multiplier (`"2"`/`"4"`/`"8"`), output fps (`"30"`/`"60"`/`"native"`, default `"30"`) | MP4 files (one per input, in order — no stitching, no boomerang) |

`interpolate_video`/`batch_interpolate` always generate `source_fps × multiplier`
frames via RIFE; `output_fps` only controls how those frames are resampled on
the way out. `"60"` is the point of the default 4x multiplier on a 24fps
source (24 × 4 = 96 generated frames → true 60fps CFR); `"30"` matches the
Space's old behaviour (most generated frames dropped back to 30); `"native"`
skips resampling and tags the clip at however many frames RIFE produced. The
`src/utils/huggingface.ts` client requests `"60"`. `stitch`'s concat path
stays fixed at 30fps (`STITCH_FPS`) regardless.

`batch_interpolate` (the "3. Batch RIFE" tab's "▶ Process All" button) is
**not** `@spaces.GPU`-decorated itself. It chunks the upload into groups of
`BATCH_GPU_CHUNK_SIZE` (3) clips and calls `_interpolate_batch_chunk()` — which
is GPU-decorated — once per chunk, so one lease covers up to 3 clips and the
loop simply re-acquires a fresh lease for the next chunk rather than either
holding one lease for the whole batch or acquiring one per clip. This is
tuned to HuggingFace's ZeroGPU quota, which is sensitive to how many GPU
functions run, not just how long each one takes. The single-clip
`interpolate_video` endpoint (used by `src/utils/huggingface.ts` and the "1.
Smooth Video + Boomerang" tab) is unaffected — it still acquires one lease
per call.

The batch button is wired with `preprocess=False` so its callback receives
each upload's raw FileData (including `orig_name`, the filename exactly as
the browser sent it) instead of the bare, already-sanitized on-disk path
Gradio's default File preprocessing would hand it — HuggingFace's own
`/upload` route strips characters like parentheses from that on-disk
filename before app.py ever runs. Batch outputs are named from `orig_name`
(see `_resolve_batch_upload_entry` / `name_like_source`) so parentheses and
other stripped characters survive in the downloaded result.

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
