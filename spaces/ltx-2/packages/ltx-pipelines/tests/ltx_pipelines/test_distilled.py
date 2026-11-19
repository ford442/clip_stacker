from typing import Callable

import pytest
import torch
from tests.conftest import (
    ASSETS_DIR,
    DISTILLED_CHECKPOINT_PATH,
    GEMMA_ROOT,
    IMG2VID_PROMPT,
    OUTPUT_DIR,
    SPATIAL_UPSAMPLER_PATH,
)

from ltx_core.tiling import TilingConfig
from ltx_pipelines.constants import DEFAULT_FRAME_RATE, DEFAULT_HEIGHT, DEFAULT_NUM_FRAMES, DEFAULT_SEED, DEFAULT_WIDTH
from ltx_pipelines.distilled import DistilledPipeline
from ltx_pipelines.utils import get_device

device = get_device()


@pytest.mark.e2e
def test_img2vid_distilled(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run img2vid distilled pipeline and verify output matches expected."""

    output_path = OUTPUT_DIR / "img2vid_distilled_output.mp4"
    image_path = ASSETS_DIR / "hat.png"

    pipeline = DistilledPipeline(
        checkpoint_path=DISTILLED_CHECKPOINT_PATH.resolve().as_posix(),
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[],
    )

    pipeline(
        prompt=IMG2VID_PROMPT,
        output_path=output_path.as_posix(),
        seed=DEFAULT_SEED,
        height=DEFAULT_HEIGHT,
        width=DEFAULT_WIDTH,
        num_frames=DEFAULT_NUM_FRAMES,
        frame_rate=DEFAULT_FRAME_RATE,
        images=[(image_path.as_posix(), 0, 1.0)],
        tiling_config=TilingConfig.default(),
    )

    # Compare to expected output
    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_img2vid_distilled.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()


@pytest.mark.e2e
def test_txt2vid_distilled(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run txt2vid distilled pipeline (no image conditioning) and verify output matches expected."""
    output_path = OUTPUT_DIR / "txt2vid_distilled_output.mp4"

    pipeline = DistilledPipeline(
        checkpoint_path=DISTILLED_CHECKPOINT_PATH.resolve().as_posix(),
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[],
    )

    pipeline(
        prompt=IMG2VID_PROMPT,
        output_path=output_path.as_posix(),
        seed=DEFAULT_SEED,
        height=DEFAULT_HEIGHT,
        width=DEFAULT_WIDTH,
        num_frames=DEFAULT_NUM_FRAMES,
        frame_rate=DEFAULT_FRAME_RATE,
        images=[],
        tiling_config=TilingConfig.default(),
    )

    # Compare to expected output
    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_txt2vid_distilled.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()
