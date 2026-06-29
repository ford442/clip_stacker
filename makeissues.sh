#!/usr/bin/env bash
#
# Create the clip_stacker roadmap issues.
# Run from anywhere on a machine where `gh` is authenticated (gh auth status).
#
#   chmod +x create_issues.sh && ./create_issues.sh
#
# Override the repo if needed:  REPO=ford442/clip_stacker ./create_issues.sh
#
set -euo pipefail

REPO="${REPO:-ford442/clip_stacker}"

echo "Creating issues in $REPO ..."

# --- Ensure labels exist (idempotent; ignores "already exists" errors) --------
ensure_label() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" 2>/dev/null || true; }
ensure_label "webgpu"      "5319e7" "WebGPU compositor / shader work"
ensure_label "rife"        "0e8a16" "RIFE / HF space interpolation"
ensure_label "enhancement" "a2eeef" "New feature or request"
ensure_label "audio"       "fbca04" "Audio / music features"
ensure_label "cleanup"     "cfd3d7" "Refactor / bug cleanup"

mk() { # mk "title" "body" "label1,label2"
  gh issue create --repo "$REPO" --title "$1" --body "$2" --label "$3"
}

# =============================================================================
# 1. WebGPU transition library
# =============================================================================
mk "WebGPU transition library (port GL-Transitions to WGSL compositor)" \
"## Background
Transitions currently route through FFmpeg xfade via a closed two-entry union:
\`dissolve\` → \`fade\`, \`motion\` → \`smoothleft\` (see \`XFADE_MAP\` in \`src/utils/transitions.ts\`).
This forces the slow WASM re-encode path and limits us to two looks.

We already own a WebGPU compositor (\`src/webgpu/exportCompositor.ts\`,
\`src/webgpu/previewEngine.ts\`, \`src/webgpu/shaders/preview.wgsl\`), so transitions
should run there instead.

## Goal
Render transitions as WGSL passes in the existing compositor, giving us:
- A large transition catalog (port the GL-Transitions set: glitch, directional warp,
  doom-melt, crosshatch, morph, etc.) instead of two.
- Real-time WYSIWYG preview that matches export exactly (same shader on both paths).
- No xfade re-encode — transitions become a GPU compositing op.

## Approach
- Convert \`TransitionType\` from a union into a **registry** keyed by shader id; each entry
  carries a WGSL fragment + uniform schema (progress, resolution, direction, etc.).
- Add a transition shader pass to \`exportCompositor.ts\` and \`previewEngine.ts\` that samples
  the two clip textures over the overlap window and blends per the active shader.
- Make \`TransitionEditor.tsx\` data-driven from the registry (dropdown + per-transition params).
- Keep the FFmpeg xfade path as a fallback for the no-WebGPU branch (feature-detector already exists).

## Acceptance criteria
- [ ] Transition registry with >= 10 ported GL-Transitions shaders
- [ ] Preview and export produce identical frames for a given transition
- [ ] \`TransitionEditor.tsx\` lists all registry entries dynamically
- [ ] Graceful fallback to xfade when WebGPU is unavailable
- [ ] Tests in the spirit of \`src/utils/transitions.test.ts\` for offset/registry math" \
"webgpu,enhancement"

# =============================================================================
# 2. RIFE-powered morph transitions
# =============================================================================
mk "RIFE-powered morph transitions between clips" \
"## Background
Today transitions are crossfades. RIFE's optical-flow net can generate genuine
in-between frames — a morph cut — which is far more cinematic than a dissolve and
ties clip_stacker to the RIFE space directly.

The HF space (\`src/hf_space/app.py\`) already exposes \`/interpolate_video\`, and the
web app already talks to it (\`src/utils/huggingface.ts\`).

## Goal
Add a 'morph' transition that, instead of blending, splices RIFE-interpolated frames
generated from clip A's last frame and clip B's first frame.

## Approach
- Build a 2-frame clip (A_last, B_first), send to RIFE at a high multiplier to produce N
  interpolated frames spanning the transition duration.
- Add a new \`/morph\` endpoint (or reuse \`/interpolate_video\`) that takes the frame pair +
  desired frame count and returns just the morph segment.
- On the timeline, insert the returned segment between A and B over the overlap window;
  represent it as a \`ClipTransition\` variant so duration math in \`transitions.ts\` still holds.
- Surface progress through the existing upload/processing/download status bar.

## Acceptance criteria
- [ ] \`morph\` selectable in the transition UI
- [ ] Frame-pair extraction + RIFE call wired through \`huggingface.ts\`
- [ ] Returned segment lands on the timeline at the correct offset/duration
- [ ] Falls back cleanly (with a message) if the space is cold/timed out" \
"rife,webgpu,enhancement"

# =============================================================================
# 3. Keyframe animation for PiP / text / Ken Burns
# =============================================================================
mk "Keyframe animation for PiP, text overlays, and Ken Burns stills" \
"## Background
PiP layout (x/y/width/height/opacity in \`Clip\`) and text overlay position (x/y in
\`TextOverlay\`) are static. The WebGPU compositor already does per-frame work, so sampling
an animated transform per frame is nearly free.

## Goal
Add keyframes with easing so:
- PiP overlays can move/scale/fade over time
- Text can slide/animate in and out
- Still images get Ken Burns pan/zoom (same infra, no extra cost)

## Approach
- Add an optional \`keyframes\` array to the animatable props on \`Clip\` and \`TextOverlay\`
  (\`{ t, value, easing }\`), with linear + cubic-bezier easing.
- Add a sampler util (e.g. \`src/utils/keyframes.ts\`) that resolves a prop value at time t.
- Drive the WebGPU compositor's per-frame uniforms from the sampler (export + preview).
- Inspector UI: a minimal keyframe editor (add/remove/drag keys on a mini timeline).
- Extend serialization in \`types/index.ts\` + \`utils/project.ts\` (Serialized* types).

## Acceptance criteria
- [ ] Keyframe sampler with linear + bezier easing + unit tests
- [ ] PiP x/y/scale/opacity animatable; text x/y animatable
- [ ] Ken Burns works on still-image clips
- [ ] Keyframes round-trip through save/load (local + remote)
- [ ] Preview matches export" \
"webgpu,enhancement"

# =============================================================================
# 4. Beat-synced auto-edit
# =============================================================================
mk "Beat-synced auto-edit (snap cuts/transitions to the audio track)" \
"## Background
We already render waveforms (\`src/components/WaveformCanvas.tsx\`, \`src/utils/waveform.ts\`),
so part of the analysis surface exists. Given the music-production use case, auto-cutting to
the beat is a strong creative hook.

## Goal
Detect beats/onsets on the uploaded audio track and offer to:
- snap existing cut points / transitions to the nearest beat, and/or
- quantize clip durations to bars (e.g. 1/2/4-bar segments).

## Approach
- Offline analysis: decode the audio track via Web Audio (OfflineAudioContext), run an
  onset/beat detector (energy-flux FFT or a small ported algorithm) to get a beat grid + BPM.
- New util \`src/utils/beats.ts\` returning beat timestamps + confidence.
- Overlay the beat grid on the timeline; add a 'Snap to beats' action and a
  'Quantize durations to N bars' action.
- Keep it non-destructive (suggested edit the user can accept/undo via existing edit history).

## Acceptance criteria
- [ ] Beat grid + BPM extracted from an uploaded track
- [ ] Beat markers visible on the timeline
- [ ] 'Snap to beats' moves transition/cut points to nearest beat
- [ ] Bar-quantize action for clip durations
- [ ] Integrates with \`useEditHistory\` undo/redo" \
"audio,enhancement"

# =============================================================================
# 5. 3D LUT color-grade pass
# =============================================================================
mk "3D LUT (.cube) color-grade pass in the WebGPU compositor" \
"## Background
A final-stage color grade gives instant 'looks' (teal-orange, film, etc.) for almost no cost
since the WebGPU compositor pipeline already exists.

## Goal
Load a \`.cube\` 3D LUT and apply it as the last shader pass before encode, with a small set
of bundled preset LUTs and a custom-upload slot.

## Approach
- \`.cube\` parser → upload as a 3D texture (\`src/utils/lut.ts\`).
- Final WGSL pass in \`exportCompositor.ts\` / \`previewEngine.ts\` that does trilinear LUT lookup.
- UI: LUT picker (bundled presets + upload) with an intensity/mix slider.
- Serialize selected LUT + intensity in the project.

## Acceptance criteria
- [ ] \`.cube\` parsing + 3D texture upload
- [ ] Trilinear LUT lookup pass applied last, preview == export
- [ ] >= 3 bundled preset LUTs + custom upload
- [ ] Intensity/mix slider
- [ ] LUT choice persists in save/load" \
"webgpu,enhancement"

# =============================================================================
# 6. RIFE space cleanups
# =============================================================================
mk "RIFE space cleanups: boomerang OOM, hard timeout, duplicate stitch_videos" \
"## Background
Issues spotted in \`src/hf_space/app.py\`.

## Tasks
- [ ] **Boomerang OOM** — \`create_boomerang_loop\` does \`skvideo.io.vread\` of the whole clip into
      a NumPy array and concatenates a reversed copy; this OOMs on longer inputs. Replace with a
      streamed FFmpeg path (\`-vf reverse\` + concat) or chunked read so memory is bounded.
- [ ] **Hard 300s timeout** — the \`inference_video.py\` subprocess uses a fixed 300s timeout that
      silently bites long clips. Make it duration-aware or surface a clear timeout message instead
      of a generic failure.
- [ ] **Duplicate \`stitch_videos\`** — the function is defined twice; the second def shadows the
      first and drops the \`apad\` / duration-preserve logic from the replace-audio branch. Collapse
      to a single definition and keep the duration-preserving replace path.

## Acceptance criteria
- [ ] Boomerang works on a multi-minute clip without OOM
- [ ] Long interpolation jobs either complete or report a clear timeout
- [ ] One \`stitch_videos\` definition; replace-audio preserves full video duration" \
"rife,cleanup"

echo ""
echo "Done. View them:  gh issue list --repo $REPO"