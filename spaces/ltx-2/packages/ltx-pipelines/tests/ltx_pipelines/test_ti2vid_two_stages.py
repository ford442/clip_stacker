from typing import Callable

import pytest
import torch
from tests.conftest import (
    ASSETS_DIR,
    AV_CHECKPOINT_SPLIT_PATH,
    DEFAULT_NEGATIVE_PROMPT,
    DISTILLED_LORA_PATH,
    GEMMA_ROOT,
    IMG2VID_PROMPT,
    OUTPUT_DIR,
    SPATIAL_UPSAMPLER_PATH,
)

from ltx_core.tiling import TilingConfig
from ltx_pipelines.constants import (
    DEFAULT_CFG_GUIDANCE_SCALE,
    DEFAULT_FRAME_RATE,
    DEFAULT_HEIGHT,
    DEFAULT_NUM_FRAMES,
    DEFAULT_NUM_INFERENCE_STEPS,
    DEFAULT_SEED,
    DEFAULT_WIDTH,
)
from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
from ltx_pipelines.utils import get_device

device = get_device()


@pytest.mark.e2e
def test_img2vid_two_stages(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run img2vid two-stages pipeline and verify output matches expected."""

    output_path = OUTPUT_DIR / "img2vid_two_stages_output.mp4"
    image_path = ASSETS_DIR / "hat.png"

    pipeline = TI2VidTwoStagesPipeline(
        checkpoint_path=AV_CHECKPOINT_SPLIT_PATH.resolve().as_posix(),
        distilled_lora_path=DISTILLED_LORA_PATH.resolve().as_posix(),
        distilled_lora_strength=0.6,
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[],
    )

    pipeline(
        prompt=IMG2VID_PROMPT,
        output_path=output_path.as_posix(),
        negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        seed=DEFAULT_SEED,
        height=DEFAULT_HEIGHT,
        width=DEFAULT_WIDTH,
        num_frames=DEFAULT_NUM_FRAMES,
        frame_rate=DEFAULT_FRAME_RATE,
        num_inference_steps=DEFAULT_NUM_INFERENCE_STEPS,
        cfg_guidance_scale=DEFAULT_CFG_GUIDANCE_SCALE,
        images=[(image_path.as_posix(), 0, 1.0)],
        tiling_config=TilingConfig.default(),
    )

    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_img2vid_two_stages.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()


@pytest.mark.e2e
def test_txt2vid_two_stages(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run txt2vid two-stages pipeline and verify output matches expected."""

    output_path = OUTPUT_DIR / "txt2vid_two_stages_output.mp4"

    pipeline = TI2VidTwoStagesPipeline(
        checkpoint_path=AV_CHECKPOINT_SPLIT_PATH.resolve().as_posix(),
        distilled_lora_path=DISTILLED_LORA_PATH.resolve().as_posix(),
        distilled_lora_strength=0.6,
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[],
    )

    pipeline(
        prompt=IMG2VID_PROMPT,
        output_path=output_path.as_posix(),
        negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        seed=DEFAULT_SEED,
        height=DEFAULT_HEIGHT,
        width=DEFAULT_WIDTH,
        num_frames=DEFAULT_NUM_FRAMES,
        frame_rate=DEFAULT_FRAME_RATE,
        num_inference_steps=DEFAULT_NUM_INFERENCE_STEPS,
        cfg_guidance_scale=DEFAULT_CFG_GUIDANCE_SCALE,
        images=[],
        tiling_config=TilingConfig.default(),
    )

    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_txt2vid_two_stages.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()
