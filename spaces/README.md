# Parked HuggingFace Spaces

These Gradio Spaces were kept under `huggingface/` but the app does not call
any of them. They live here so they stay in history and can be revived, and so
nothing treats them as part of the app:

- ESLint ignores `spaces/`, knip and Vitest never look at it, and CI runs no
  job over it.
- `deploy.py` uploads `dist/` only, so nothing here is ever deployed.

| Space | What it is |
|---|---|
| `ltx-2/` | LTX-2 video generation |
| `ltx-0.9.8-distilled/` | LTX Video Fast (0.9.8 distilled) |
| `RealVis_v5.0_BF16_IP/` | RealVis V5.0 BF16 with IP-Adapter |
| `StableDiffusion-3.5-Large-IP/` | Stable Diffusion 3.5 Large with IP-Adapter |
| `sd3.5-large-lora/` | Stable Diffusion 3.5 Large with LoRA |
| `MiniMax-Music3-workflow/` | MiniMax Music 3 workflow |

`huggingface/` now holds only `RIFE/`, the one Space the app uses (frame
interpolation; `npm run deploy:rife-space` pushes it). To bring one of these
back as a backend, move it next to `RIFE/` and give it a deploy script of its
own the way `scripts/deploy-rife-space.sh` does for RIFE.
