# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Andrew Kvochko

import pytest
import torch

from ltx_core.pipeline.components.patchifiers import AudioPatchifier, VideoLatentPatchifier
from ltx_core.pipeline.components.protocols import AudioLatentShape, VideoLatentShape, VideoPixelShape
from ltx_core.pipeline.conditioning.item import LatentState
from ltx_core.pipeline.conditioning.tools import AudioLatentTools, VideoLatentTools
from ltx_core.pipeline.conditioning.types.keyframe_cond import VideoConditionByKeyframeIndex
from ltx_core.pipeline.conditioning.types.latent_cond import VideoConditionByLatentIndex


def test_video_conditioning_tools_initialization() -> None:
    """Test VideoLatentTools initialization with valid parameters."""
    patchifier = VideoLatentPatchifier(patch_size=4)

    tools = VideoLatentTools(
        patchifier=patchifier,
        target_shape=VideoLatentShape.from_pixel_shape(
            shape=VideoPixelShape(batch=2, frames=9, height=128, width=128, fps=30.0)
        ),
        fps=30.0,
    )

    assert tools.fps == 30.0
    assert tools.target_shape.batch == 2
    assert tools.target_shape.channels == 128
    assert tools.target_shape.height == 128 // 32
    assert tools.target_shape.width == 128 // 32
    assert tools.target_shape.frames == (9 - 1) // 8 + 1


def test_video_conditioning_builder_initialization_non_causal() -> None:
    """Test VideoLatentBuilder initialization with causal_fix=False."""
    patchifier = VideoLatentPatchifier(patch_size=4)

    tools = VideoLatentTools(
        patchifier=patchifier,
        target_shape=VideoLatentShape.from_pixel_shape(
            shape=VideoPixelShape(batch=1, frames=16, height=64, width=64, fps=24.0)
        ),
        fps=24.0,
        causal_fix=False,
    )
    assert tools.causal_fix is False
    assert tools.target_shape.frames == 16 // 8


def test_video_conditioning_tools_build_empty_state() -> None:
    """Test VideoLatentTools.build_empty_state() method."""
    patchifier = VideoLatentPatchifier(patch_size=1)
    tools = VideoLatentTools(
        patchifier=patchifier,
        target_shape=VideoLatentShape.from_pixel_shape(
            shape=VideoPixelShape(batch=2, frames=9, height=128, width=128, fps=30.0)
        ),
        fps=30.0,
    )
    latent_state = tools.create_initial_state(device=torch.device("cpu"), dtype=torch.float32)

    assert latent_state.latent.shape == (2, 32, 128)
    assert latent_state.denoise_mask.shape == (2, 32, 1)
    assert latent_state.positions.shape == (2, 3, 32, 2)
    assert latent_state.positions.dtype == torch.float32


def test_video_conditioning_tools_build_with_latent_conditioning() -> None:
    """Test VideoLatentTools.build_empty_state() method with LatentConditionByFrame."""
    patchifier = VideoLatentPatchifier(patch_size=1)
    batch = 2
    in_channels = 128
    latent_height = 4
    latent_width = 4

    # Create a conditioning latent (single frame image)
    conditioning = VideoConditionByLatentIndex(
        latent=torch.randn(batch, in_channels, 1, latent_height, latent_width),
        strength=0.5,
        latent_idx=0,
    )

    tools = VideoLatentTools(
        patchifier=patchifier,
        target_shape=VideoLatentShape.from_pixel_shape(
            shape=VideoPixelShape(batch=batch, frames=9, height=128, width=128, fps=30.0)
        ),
        fps=30.0,
    )
    empty_state = tools.create_initial_state(device=torch.device("cpu"), dtype=torch.float32)
    latent_state = conditioning.apply_to(latent_state=empty_state, latent_tools=tools)

    # Verify latent state structure
    assert isinstance(latent_state, LatentState)
    assert latent_state.latent.shape[0] == batch
    assert empty_state.latent.shape == latent_state.latent.shape


def test_video_conditioning_builder_apply_to() -> None:
    """Test VideoLatentBuilder.apply_to() method."""
    patchifier = VideoLatentPatchifier(patch_size=4)
    batch = 1
    in_channels = 128
    latent_height = 4
    latent_width = 4

    # Create conditioning latents
    conditioning1 = VideoConditionByLatentIndex(
        latent=torch.randn(batch, in_channels, 1, latent_height, latent_width),
        strength=0.5,
        latent_idx=0,
    )
    conditioning2 = VideoConditionByLatentIndex(
        latent=torch.randn(batch, in_channels, 1, latent_height, latent_width),
        strength=0.7,
        latent_idx=1,
    )

    tools = VideoLatentTools(
        patchifier=patchifier,
        target_shape=VideoLatentShape.from_pixel_shape(
            shape=VideoPixelShape(batch=batch, frames=9, height=128, width=128, fps=30.0)
        ),
        fps=30.0,
    )

    device = torch.device("cpu")
    dtype = torch.float32

    # Build to create conditioning items
    built_state = tools.create_initial_state(device=device, dtype=dtype)

    # Create a new state and apply conditioning manually
    test_latent = torch.randn_like(built_state.latent)
    test_denoise_mask = torch.ones_like(built_state.denoise_mask)
    test_positions = built_state.positions.clone()
    test_state = LatentState(
        latent=test_latent,
        denoise_mask=test_denoise_mask,
        positions=test_positions,
        clean_latent=test_latent.clone(),
    )

    result = conditioning1.apply_to(latent_state=test_state, latent_tools=tools)
    result = conditioning2.apply_to(latent_state=result, latent_tools=tools)

    # Verify result is different from input (conditioning was applied)
    assert not torch.allclose(result.latent, test_latent)
    assert not torch.allclose(result.denoise_mask, test_denoise_mask)


def test_video_conditioning_builder_roundtrip() -> None:
    """Test VideoLatentBuilder build -> revert roundtrip."""
    patchifier = VideoLatentPatchifier(patch_size=1)
    batch = 1
    in_channels = 128
    latent_height = 4
    latent_width = 4

    conditioning = VideoConditionByKeyframeIndex(
        keyframes=torch.randn(batch, in_channels, 1, latent_height, latent_width),
        frame_idx=0,
        strength=0.5,
    )

    tools = VideoLatentTools(
        patchifier=patchifier,
        target_shape=VideoLatentShape.from_pixel_shape(
            shape=VideoPixelShape(batch=batch, frames=9, height=128, width=128, fps=30.0)
        ),
        fps=30.0,
    )

    device = torch.device("cpu")
    dtype = torch.float32

    empty_state = tools.create_initial_state(device=device, dtype=dtype)
    latent_state = conditioning.apply_to(latent_state=empty_state, latent_tools=tools)
    unconditioned_state = tools.clear_conditioning(latent_state)
    assert torch.allclose(unconditioned_state.latent, empty_state.latent)


def test_audio_conditioning_builder_initialization() -> None:
    """Test AudioLatentBuilder initialization with valid parameters."""
    patchifier = AudioPatchifier(
        patch_size=16,
        sample_rate=16000,
        hop_length=160,
        audio_latent_downsample_factor=4,
    )

    tools = AudioLatentTools(
        patchifier=patchifier,
        target_shape=AudioLatentShape.from_duration(batch=2, duration=2.0, channels=8, mel_bins=16),
    )

    assert tools.target_shape.batch == 2
    assert tools.target_shape.channels == 8
    assert tools.target_shape.mel_bins == 16
    assert tools.target_shape.frames == int(2.0 * 16000.0 / 160.0 / 4.0)


def test_audio_conditioning_builder_build() -> None:
    """Test AudioLatentBuilder.build() method."""
    patchifier = AudioPatchifier(
        patch_size=16,
        sample_rate=16000,
        hop_length=160,
        audio_latent_downsample_factor=4,
    )

    tools = AudioLatentTools(
        patchifier=patchifier,
        target_shape=AudioLatentShape.from_duration(batch=2, duration=1.0, channels=8, mel_bins=16),
    )

    device = torch.device("cpu")
    dtype = torch.float32

    latent_state = tools.create_initial_state(device=device, dtype=dtype)

    # Verify latent state structure
    assert isinstance(latent_state, LatentState)
    assert latent_state.latent.shape[0] == 2  # batch
    assert latent_state.denoise_mask.shape[0] == 2  # batch
    assert latent_state.positions.shape[0] == 2  # batch

    # Verify positions shape for audio (1D time dimension)
    assert latent_state.positions.shape[1] == 1  # time dimension only
    assert latent_state.positions.dtype == torch.float32


def test_audio_conditioning_builder_roundtrip() -> None:
    """Test AudioLatentBuilder build -> clear conditioning roundtrip."""
    patchifier = AudioPatchifier(
        patch_size=16,
        sample_rate=16000,
        hop_length=160,
        audio_latent_downsample_factor=4,
    )

    tools = AudioLatentTools(
        patchifier=patchifier,
        target_shape=AudioLatentShape.from_duration(batch=1, duration=1.0, channels=8, mel_bins=16),
    )

    device = torch.device("cpu")
    dtype = torch.float32

    # Build to get patchified state
    built_state = tools.create_initial_state(device=device, dtype=dtype)

    # Revert
    reverted_state = tools.clear_conditioning(built_state)

    # Verify result has unpatchified shape
    assert reverted_state.latent.shape[0] == 1  # batch
    assert reverted_state.latent.shape[2] == 128  # channels * mel_bins


if __name__ == "__main__":
    pytest.main()
