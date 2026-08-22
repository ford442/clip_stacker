# LTX-Core Model API Guide

This guide explains the core concepts and APIs used in the LTX-2 Audio-Video diffusion model. Understanding these concepts is essential for training, fine-tuning, and running inference with LTX models.

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
   - [Modality](#modality---the-input-container)
   - [Patchifiers](#patchifiers---format-conversion)
   - [Latent Tools](#latent-tools---preparing-inputs)
   - [Conditioning Items](#conditioning-items---adding-constraints)
   - [Perturbations](#perturbations---fine-grained-control)
3. [Model Architecture](#model-architecture)
4. [Usage Patterns](#usage-patterns)
   - [Text-to-Video Generation](#text-to-video-generation)
   - [Image-to-Video Generation](#image-to-video-generation)
   - [Video-to-Video (IC-LoRA)](#video-to-video-ic-lora)
   - [Audio-Video Generation](#audio-video-generation)
5. [Common Pitfalls](#common-pitfalls)

---

## Overview

The LTX-2 model is a **joint Audio-Video diffusion transformer**. Unlike traditional models that handle one modality at a time, LTX-2 processes **video and audio simultaneously** in a unified architecture, enabling cross-modal attention between them.

Key characteristics:
- **Dual-stream architecture**: Separate processing paths for video and audio that interact via cross-attention
- **Per-token timesteps**: Different tokens can have different noise levels (enables advanced conditioning)
- **Flexible conditioning**: Supports text, image, and video conditioning

---

## Core Concepts

### Modality - The Input Container

The `Modality` dataclass wraps all information needed to process either video or audio:

```python
from ltx_core.model.transformer.modality import Modality

@dataclass
class Modality:
    enabled: bool           # Whether this modality should be processed
    latent: torch.Tensor    # Shape: (B, seq_len, D) - patchified tokens
    timesteps: torch.Tensor # Shape: (B, seq_len) - noise level per token
    positions: torch.Tensor # Shape: (B, dims, seq_len, 2) - spatial/temporal coordinates
    context: torch.Tensor   # Text embeddings
    context_mask: torch.Tensor | None
```

**Field descriptions:**

| Field | Description |
|-------|-------------|
| `enabled` | Set to `False` to skip processing this modality |
| `latent` | Sequence of tokens in patchified format (not spatial `[B,C,F,H,W]`) |
| `timesteps` | Per-token noise levels (sigma values). Enables token-level conditioning |
| `positions` | Coordinates for RoPE (Rotary Position Embeddings). Video: `[B, 3, seq, 2]`, Audio: `[B, 1, seq, 2]` |
| `context` | Text prompt embeddings from the Gemma encoder |
| `context_mask` | Optional attention mask for the context |

### Patchifiers - Format Conversion

Patchifiers convert between spatial format and sequence format:

```python
from ltx_core.pipeline.components.patchifiers import (
    VideoLatentPatchifier,
    AudioPatchifier,
    VideoLatentShape,
    AudioLatentShape,
)

# Video patchification
video_patchifier = VideoLatentPatchifier(patch_size=1)

# Spatial to sequence: [B, C, F, H, W] → [B, F*H*W, C]
patchified = video_patchifier.patchify(video_latent)

# Sequence to spatial: [B, seq_len, C] → [B, C, F, H, W]
spatial = video_patchifier.unpatchify(
    patchified,
    output_shape=VideoLatentShape(
        batch=1, channels=128, frames=7, height=16, width=24
    )
)

# Audio patchification
audio_patchifier = AudioPatchifier(patch_size=1)

# [B, C, T, mel_bins] → [B, T, C*mel_bins]
patchified_audio = audio_patchifier.patchify(audio_latent)
```

### Latent Tools - Preparing Inputs

Latent tools handle the setup of initial latents, masks, and positions. Combined with conditioning items, they provide flexible input preparation:

```python
from ltx_core.pipeline.conditioning.tools import (
    VideoLatentTools,
    AudioLatentTools,
    LatentState,
)
from ltx_core.pipeline.components.patchifiers import VideoLatentShape, AudioLatentShape
from ltx_core.pipeline.components.protocols import VideoPixelShape

# Create video latent tools
pixel_shape = VideoPixelShape(
    batch=1,
    frames=49,   # Must be k*8 + 1 (e.g., 49, 97, 121)
    height=512,
    width=768,
    fps=25.0,
)
video_tools = VideoLatentTools(
    patchifier=video_patchifier,
    target_shape=VideoLatentShape.from_pixel_shape(shape=pixel_shape),
    fps=25.0,
)

# Create an empty latent state (zeros with positions computed)
video_state = video_tools.create_initial_state(device=device, dtype=torch.bfloat16)
# video_state.latent: [B, seq_len, 128] - zeros (will be replaced with noise)
# video_state.denoise_mask: [B, seq_len, 1] - ones (all tokens to denoise)
# video_state.positions: [B, 3, seq_len, 2] - pixel coordinates for RoPE

# Audio latent tools (similar pattern)
audio_tools = AudioLatentTools(
    patchifier=audio_patchifier,
    target_shape=AudioLatentShape.from_duration(
        batch=1,
        duration=2.0,  # seconds
        channels=8,
        mel_bins=16,
    ),
)
audio_state = audio_tools.create_initial_state(device, dtype)
```

### Conditioning Items - Adding Constraints

Conditioning items modify latent states to add constraints like first-frame conditioning:

```python
from ltx_core.pipeline.conditioning.types.latent_cond import VideoConditionByLatentIndex
from ltx_core.pipeline.conditioning.types.keyframe_cond import VideoConditionByKeyframeIndex

# Option 1: Condition by latent index (replaces tokens in-place)
first_frame_cond = VideoConditionByLatentIndex(
    latent=encoded_image,  # VAE-encoded image [B, C, 1, H, W]
    strength=1.0,          # 1.0 = fully conditioned, 0.0 = fully denoised
    latent_idx=0,          # Which latent frame to condition
)
video_state = first_frame_cond.apply_to(video_state, video_tools)

# Option 2: Condition by keyframe (appends conditioning tokens)
keyframe_cond = VideoConditionByKeyframeIndex(
    keyframes=encoded_image,  # VAE-encoded keyframe(s)
    frame_idx=0,              # Target frame index
    strength=1.0,
)
video_state = keyframe_cond.apply_to(video_state, video_tools)
```

**Key concepts:**
- `LatentState` is a frozen dataclass containing `latent`, `denoise_mask`, and `positions`
- `denoise_mask` values: `1.0` = denoise this token, `0.0` = keep this token fixed
- Conditioning items return a new `LatentState` (immutable pattern)

### Perturbations - Fine-Grained Control

Perturbations allow you to selectively skip operations at the per-sample, per-block level:

```python
from ltx_core.guidance.perturbations import (
    Perturbation,
    PerturbationType,
    PerturbationConfig,
    BatchedPerturbationConfig,
)

# Available perturbation types
PerturbationType.SKIP_A2V_CROSS_ATTN  # Skip audio→video cross attention
PerturbationType.SKIP_V2A_CROSS_ATTN  # Skip video→audio cross attention
PerturbationType.SKIP_VIDEO_SELF_ATTN # Skip video self attention
PerturbationType.SKIP_AUDIO_SELF_ATTN # Skip audio self attention

# Example: Skip audio→video attention in specific blocks
perturbation = Perturbation(
    type=PerturbationType.SKIP_A2V_CROSS_ATTN,
    blocks=[0, 1, 2, 3],  # Skip in blocks 0-3, or None for all blocks
)
config = PerturbationConfig(perturbations=[perturbation])

# For batched inputs
batched_config = BatchedPerturbationConfig([config, config])  # batch_size=2

# Or use empty config for normal operation
batched_config = BatchedPerturbationConfig.empty(batch_size=2)
```

**Use cases for perturbations:**
- **STG (Spatio-Temporal Guidance)**: Skip self-attention in block 29 to improve video quality
- Ablation studies (disable specific attention paths)
- Custom guidance strategies
- Debugging model behavior

**STG (Spatio-Temporal Guidance) Example:**

STG uses perturbations to improve video generation quality by running an additional forward pass with self-attention skipped:

```python
from ltx_core.guidance.perturbations import (
    Perturbation, PerturbationType, PerturbationConfig, BatchedPerturbationConfig
)
from ltx_core.pipeline.components.guiders import STGGuider

# Create STG perturbation config (recommended: block 29)
stg_perturbation = Perturbation(
    type=PerturbationType.SKIP_VIDEO_SELF_ATTN,
    blocks=[29],  # Recommended: single block 29
)
stg_config = BatchedPerturbationConfig([PerturbationConfig([stg_perturbation])])

# In your denoising loop:
stg_guider = STGGuider(scale=1.0)  # Recommended scale

# Normal forward pass
pos_video, pos_audio = model(video=video, audio=audio, perturbations=None)

# Perturbed forward pass (for STG)
perturbed_video, perturbed_audio = model(video=video, audio=audio, perturbations=stg_config)

# Apply STG guidance
denoised_video = pos_video + stg_guider.delta(pos_video, perturbed_video)
```

---

## Model Architecture

The LTX-2 transformer consists of 48 blocks, each with the following structure:

```
┌─────────────────────────────────────────────────────────────┐
│  VIDEO STREAM                    AUDIO STREAM               │
│  ───────────                     ────────────               │
│                                                             │
│  1. Video Self-Attention         1. Audio Self-Attention    │
│     (attends to all video)          (attends to all audio)  │
│                                                             │
│  2. Video Cross-Attention        2. Audio Cross-Attention   │
│     (attends to text prompt)        (attends to text prompt)│
│                                                             │
│           ╔═══════════════════════════════════╗             │
│           ║  3. AUDIO-VIDEO CROSS ATTENTION   ║             │
│           ║                                   ║             │
│           ║  • Audio-to-Video (A→V):          ║             │
│           ║    Video queries, Audio keys/vals ║             │
│           ║                                   ║             │
│           ║  • Video-to-Audio (V→A):          ║             │
│           ║    Audio queries, Video keys/vals ║             │
│           ╚═══════════════════════════════════╝             │
│                                                             │
│  4. Video Feed-Forward           4. Audio Feed-Forward      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key insight**: Video and audio "talk" to each other through bidirectional cross-attention in every block, enabling synchronized audio-video generation.

### Forward Pass

```python
from ltx_core.model.transformer.model import LTXModel

# The transformer takes both modalities and returns predictions for both
video_velocity, audio_velocity = model(
    video=video_modality,
    audio=audio_modality,
    perturbations=None,  # or BatchedPerturbationConfig
)
# Returns velocity predictions used in the Euler diffusion step
```

---

## Usage Patterns

### Text-to-Video Generation

Basic text-to-video generation flow:

```python
from dataclasses import replace
from ltx_core.pipeline.components.schedulers import LTX2Scheduler
from ltx_core.pipeline.components.diffusion_steps import EulerDiffusionStep
from ltx_core.pipeline.components.guiders import CFGGuider
from ltx_core.pipeline.conditioning.tools import VideoLatentTools
from ltx_core.pipeline.components.patchifiers import VideoLatentShape

# 1. Encode text prompt
video_context, audio_context, mask = text_encoder(prompt)

# 2. Create video latent tools and initial state
pixel_shape = VideoPixelShape(batch=1, frames=49, height=512, width=768, fps=25.0)
video_tools = VideoLatentTools(
    patchifier=video_patchifier,
    target_shape=VideoLatentShape.from_pixel_shape(shape=pixel_shape),
    fps=25.0,
)
video_state = video_tools.create_initial_state(device, dtype)

# 3. Add noise to the latent
noise = torch.randn_like(video_state.latent)
noised_latent = noise  # Start from pure noise

# 4. Create video modality
video = Modality(
    enabled=True,
    latent=noised_latent,
    timesteps=video_state.denoise_mask,  # Will be updated each step
    positions=video_state.positions,
    context=video_context,
    context_mask=None,
)

# 5. Setup scheduler and diffusion components
scheduler = LTX2Scheduler()
sigmas = scheduler.execute(steps=30).to(device)
stepper = EulerDiffusionStep()

# 6. Denoising loop
for step_idx, sigma in enumerate(sigmas[:-1]):
    # Update timesteps with current sigma (use replace for immutable Modality)
    video = replace(video, timesteps=sigma * video_state.denoise_mask)

    # Forward pass
    video_vel, _ = model(video=video, audio=disabled_audio, perturbations=None)

    # Euler step
    new_latent = stepper.step(video.latent, video_vel, sigmas, step_idx)
    video = replace(video, latent=new_latent)

# 7. Decode to pixels
video_spatial = video_tools.unpatchify(
    replace(video_state, latent=video.latent)
).latent  # [B, C, F, H, W]
video_pixels = vae_decoder(video_spatial)  # [B, 3, F, H, W]
```

### Image-to-Video Generation

Condition the first frame with an image:

```python
from ltx_core.pipeline.conditioning.types.latent_cond import VideoConditionByLatentIndex

# Encode the conditioning image
image_latent = vae_encoder(image)  # [B, C, 1, H, W]

# Create video tools and initial state
pixel_shape = VideoPixelShape(batch=1, frames=49, height=512, width=768, fps=25.0)
video_tools = VideoLatentTools(
    patchifier=video_patchifier,
    target_shape=VideoLatentShape.from_pixel_shape(shape=pixel_shape),
    fps=25.0,
)
video_state = video_tools.create_initial_state(device, dtype)

# Apply first-frame conditioning
first_frame_cond = VideoConditionByLatentIndex(
    latent=image_latent,
    strength=1.0,   # 1.0 = fully conditioned (no denoising on first frame)
    latent_idx=0,   # Condition frame 0
)
video_state = first_frame_cond.apply_to(video_state, video_tools)
# The denoise_mask will be 0.0 for first-frame tokens, 1.0 for the rest

# Proceed with denoising as usual...
```

### Video-to-Video (IC-LoRA)

IC-LoRA enables video-to-video transformation by conditioning on a reference video. The key insight is that reference tokens are included in the sequence but kept at timestep=0 (clean, no denoising).

```python
from dataclasses import replace
from ltx_core.pipeline.conditioning.tools import VideoLatentTools
from ltx_core.pipeline.components.patchifiers import VideoLatentShape
from ltx_core.pipeline.components.protocols import VideoPixelShape

# 1. Create video tools for target
pixel_shape = VideoPixelShape(batch=1, frames=49, height=512, width=768, fps=25.0)
video_tools = VideoLatentTools(
    patchifier=video_patchifier,
    target_shape=VideoLatentShape.from_pixel_shape(shape=pixel_shape),
    fps=25.0,
)

# 2. Encode reference video to latents and patchify
ref_latents = vae_encoder(reference_video)  # [B, C, F, H, W]
patchified_ref = video_patchifier.patchify(ref_latents)  # [B, ref_seq_len, C]
ref_seq_len = patchified_ref.shape[1]

# 3. Create target video state (positions computed automatically)
target_state = video_tools.create_initial_state(device, dtype)

# 4. Compute positions for reference (SAME grid as target!)
# Reference positions are identical to target - this tells the model they correspond
ref_positions = target_state.positions.clone()

# 5. CONCATENATE reference + target
combined_latent = torch.cat([patchified_ref, torch.randn_like(target_state.latent)], dim=1)
combined_positions = torch.cat([ref_positions, target_state.positions], dim=2)

# 6. Create denoise mask: 0 for reference (keep clean), 1 for target (denoise)
ref_denoise_mask = torch.zeros(1, ref_seq_len, 1, device=device)
combined_denoise_mask = torch.cat([ref_denoise_mask, target_state.denoise_mask], dim=1)

# 7. Create modality with combined inputs
video = Modality(
    enabled=True,
    latent=combined_latent,
    timesteps=combined_denoise_mask,  # Will be updated with sigma
    positions=combined_positions,
    context=video_context,
    context_mask=None,
)

# 8. Denoising loop - only update target portion
for step_idx, sigma in enumerate(sigmas[:-1]):
    # Timesteps: 0 for reference, sigma for target
    ref_timesteps = torch.zeros(1, ref_seq_len, 1, device=device)
    target_timesteps = sigma * target_state.denoise_mask
    new_timesteps = torch.cat([ref_timesteps, target_timesteps], dim=1)
    video = replace(video, timesteps=new_timesteps)

    # Forward pass
    video_vel, _ = model(video=video, audio=audio, perturbations=None)

    # Euler step - ONLY update target portion
    target_latent = video.latent[:, ref_seq_len:]
    target_vel = video_vel[:, ref_seq_len:]
    updated_target = stepper.step(target_latent, target_vel, sigmas, step_idx)

    # Reconstruct (reference stays fixed)
    new_latent = torch.cat([patchified_ref, updated_target], dim=1)
    video = replace(video, latent=new_latent)

# 9. Extract and decode only the target portion
final_target = video.latent[:, ref_seq_len:]
target_state_with_output = replace(target_state, latent=final_target)
target_spatial = video_tools.unpatchify(target_state_with_output).latent
video_pixels = vae_decoder(target_spatial)
```

**Why this works:**
- Self-attention sees both reference and target tokens
- Reference tokens have `timestep=0` (clean signal) - model learns to "copy" from them
- Shared positions tell the model "frame N of reference = frame N of target"
- Only target portion is updated during denoising

### Audio-Video Generation

Generate synchronized audio and video:

```python
from dataclasses import replace
from ltx_core.pipeline.conditioning.tools import VideoLatentTools, AudioLatentTools
from ltx_core.pipeline.components.patchifiers import VideoLatentShape, AudioLatentShape
from ltx_core.pipeline.components.protocols import VideoPixelShape

# Create latent tools for both modalities
pixel_shape = VideoPixelShape(batch=1, frames=49, height=512, width=768, fps=25.0)
video_tools = VideoLatentTools(
    patchifier=video_patchifier,
    target_shape=VideoLatentShape.from_pixel_shape(shape=pixel_shape),
    fps=25.0,
)
audio_tools = AudioLatentTools(
    patchifier=audio_patchifier,
    target_shape=AudioLatentShape.from_duration(batch=1, duration=2.0, channels=8, mel_bins=16),
)

# Create initial states
video_state = video_tools.create_initial_state(device, dtype)
audio_state = audio_tools.create_initial_state(device, dtype)

# Encode text (returns separate embeddings for each modality)
video_context, audio_context, mask = text_encoder(prompt)

# Create both modalities with noise
video = Modality(
    enabled=True,
    latent=torch.randn_like(video_state.latent),
    timesteps=video_state.denoise_mask,
    positions=video_state.positions,
    context=video_context,
    context_mask=None,
)
audio = Modality(
    enabled=True,
    latent=torch.randn_like(audio_state.latent),
    timesteps=audio_state.denoise_mask,
    positions=audio_state.positions,
    context=audio_context,
    context_mask=None,
)

# Denoising loop - update both (use replace for immutable Modality)
for step_idx, sigma in enumerate(sigmas[:-1]):
    video = replace(video, timesteps=sigma * video_state.denoise_mask)
    audio = replace(audio, timesteps=sigma * audio_state.denoise_mask)

    # Forward pass returns both predictions
    video_vel, audio_vel = model(video=video, audio=audio, perturbations=None)

    # Update both latents
    video = replace(video, latent=stepper.step(video.latent, video_vel, sigmas, step_idx))
    audio = replace(audio, latent=stepper.step(audio.latent, audio_vel, sigmas, step_idx))

# Decode both
video_spatial = video_tools.unpatchify(replace(video_state, latent=video.latent)).latent
video_pixels = vae_decoder(video_spatial)
audio_spatial = audio_tools.unpatchify(replace(audio_state, latent=audio.latent)).latent
audio_mel = audio_decoder(audio_spatial)
audio_waveform = vocoder(audio_mel)
```

---

## Common Pitfalls

### 1. Frame Count Constraints

Video frame count must satisfy `num_frames % 8 == 1`:
- ✅ Valid: 49, 97, 121, 145
- ❌ Invalid: 48, 50, 100

```python
# The "+1" accounts for causal padding in the VAE
latent_frames = (num_frames - 1) // 8 + 1
```

### 2. Resolution Constraints

Height and width must be divisible by 32:
- ✅ Valid: 512×768, 768×1024
- ❌ Invalid: 500×750

### 3. Position Tensor Shapes

Different modalities have different position tensor shapes:
- Video: `[B, 3, seq_len, 2]` - 3 dimensions for (time, height, width)
- Audio: `[B, 1, seq_len, 2]` - 1 dimension for time only

### 4. Separate Context Embeddings

Video and audio modalities receive **different** context embeddings from the text encoder:

```python
# The text encoder returns separate embeddings
video_context, audio_context, mask = text_encoder(prompt)

# Use the appropriate one for each modality
video = Modality(context=video_context, ...)  # NOT audio_context!
audio = Modality(context=audio_context, ...)  # NOT video_context!
```

### 5. Immutable Modality

The `Modality` dataclass is **frozen** (immutable). Use `dataclasses.replace()` to create modified copies:

```python
from dataclasses import replace

# ❌ Wrong - will raise an error
video.latent = new_latent

# ✅ Correct - create a new Modality with updated field
video = replace(video, latent=new_latent)

# ✅ Update multiple fields at once
video = replace(video, latent=new_latent, timesteps=new_timesteps)
```

---

## Additional Resources

- [Training Guide](./training-guide.md) - How to fine-tune LTX-2 models
- [Configuration Reference](./configuration-reference.md) - All configuration options
- [Training Modes](./training-modes.md) - LoRA, audio-video, and IC-LoRA training
