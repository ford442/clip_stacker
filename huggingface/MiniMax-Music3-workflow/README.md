---
title: MiniMax Music 3 Workflow
emoji: 🎵
colorFrom: pink
colorTo: purple
sdk: gradio
sdk_version: 6.24.0
app_file: app.py
pinned: true
suggested_hardware: zero-a10g
hf_oauth: true
---

# MiniMax Music 3 — diffusers demo as a `gr.Workflow`

Generates full songs from tagged lyrics + a structured caption using the `MiniMaxMusic3Pipeline` diffusers
port, presented as a visual, node-based `gr.Workflow` canvas (`workflow.json`):

**Lyrics + Global Metadata + Vocal Details + Arrangement (editable reference nodes, defaults per the official
prompting guide) → `generate_song` (`@spaces.GPU` ZeroGPU worker: AR frames → windowed DiT decode → vocoder →
wav) → Output Song / Seed Used / Stats → `make_video` (CPU ffmpeg visualizer) → Share Video.**

Duration, seed, randomize-seed, flow-matching steps, guidance scale, and video title are also editable
reference nodes. `hf_oauth: true` lets the owner edit the canvas; visitors can run the pipeline. The original Blocks app
(with the live-streaming PCM player) is preserved as `app_blocks.py` — workflow fn nodes are plain callables,
so chunk-by-chunk streaming is replaced by a final audio subject.

- Weights: `MiniMaxAI/MiniMax-Music3`
- AoTI kernels: `diffusers-internal-dev/MiniMax-Music3-aoti` (compiled on RTX Pro 6000, matching ZeroGPU hardware)
- Generation streams chunk by chunk with a configurable playback headroom. The 8B language-model stage runs eager
  on ZeroGPU (its JIT StaticCache ladder needs a persistent process); AoTI-exporting the LM decode step per cache
  bucket is the follow-up that brings the extra ~1.9x.