from typing import Callable

import pytest
import torch
from tests.conftest import (
    ASSETS_DIR,
    AV_CHECKPOINT_SPLIT_PATH,
    DEFAULT_NEGATIVE_PROMPT,
    DISTILLED_LORA_PATH,
    GEMMA_ROOT,
    LORAS_DIR,
    OUTPUT_DIR,
    SPATIAL_UPSAMPLER_PATH,
)

from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
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
from ltx_pipelines.ic_lora import ICLoraPipeline
from ltx_pipelines.utils import get_device

device = get_device()

LORA_PATH = LORAS_DIR / "Internal" / "ltxv_apps" / "icloras_dev" / "depth_64_2k_split.safetensors"


@pytest.mark.e2e
def test_ic_lora_t2v(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run txt2vid IC-LoRA pipeline and verify output matches expected."""

    output_path = OUTPUT_DIR / "ic_lora_t2v_output.mp4"
    control_path = ASSETS_DIR / "depth_00001.mp4"

    pipeline = ICLoraPipeline(
        checkpoint_path=AV_CHECKPOINT_SPLIT_PATH.resolve().as_posix(),
        distilled_lora_path=DISTILLED_LORA_PATH.resolve().as_posix(),
        distilled_lora_strength=1.0,
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[LoraPathStrengthAndSDOps(LORA_PATH.resolve().as_posix(), 2.0, LTXV_LORA_COMFY_RENAMING_MAP)],
    )

    pipeline(
        prompt=(
            "Two humanoid fish walk upright along the sandy bottom of the ocean, their finned legs moving with a "
            "slow, deliberate rhythm. Their bodies are covered in textured scales that catch the filtered sunlight "
            "drifting down from the surface above. Around them, coral formations, rocks, and swaying sea plants "
            "create a quiet underwater landscape, while small schools of fish pass in the distance. Soft beams of "
            "blue light cut through the water, and tiny particles float in the current, giving the scene a calm, "
            "otherworldly atmosphere."
        ),
        negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        output_path=output_path.as_posix(),
        seed=DEFAULT_SEED,
        height=DEFAULT_HEIGHT,
        width=DEFAULT_WIDTH,
        num_frames=DEFAULT_NUM_FRAMES,
        frame_rate=DEFAULT_FRAME_RATE,
        num_inference_steps=DEFAULT_NUM_INFERENCE_STEPS,
        cfg_guidance_scale=DEFAULT_CFG_GUIDANCE_SCALE,
        images=[],
        video_conditioning=[(control_path.as_posix(), 0.8)],
        tiling_config=TilingConfig.default(),
    )

    # Compare to expected output
    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_ic_lora_t2v.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()


@pytest.mark.e2e
def test_ic_lora_i2v(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run img2vid IC-LoRA pipeline and verify output matches expected."""

    output_path = OUTPUT_DIR / "ic_lora_i2v_output.mp4"
    control_path = ASSETS_DIR / "depth_00001.mp4"
    image_path = ASSETS_DIR / "astronauts.jpeg"

    pipeline = ICLoraPipeline(
        checkpoint_path=AV_CHECKPOINT_SPLIT_PATH.resolve().as_posix(),
        distilled_lora_path=DISTILLED_LORA_PATH.resolve().as_posix(),
        distilled_lora_strength=1.3,
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[LoraPathStrengthAndSDOps(LORA_PATH.resolve().as_posix(), 2.0, LTXV_LORA_COMFY_RENAMING_MAP)],
    )

    pipeline(
        prompt=(
            "Cinematic tracking shot of two astronauts in detailed white NASA-style EVA space suits walking slowly "
            "forward towards the camera through a dense, mysterious alien landscape. The terrain is rugged and "
            "textured, covered in gray lunar dust and patches of frost. Thick, volumetric fog and swirling mist "
            "envelop the scene, partially obscuring the jagged rock formations in the background. The scene is "
            "backlit by a warm, hazy sun low on the horizon, creating dramatic rim lighting and lens flares on their "
            "helmet visors. The atmosphere is ethereal and moody. The movement shows the astronauts stepping heavily "
            "over the uneven ground, with the mist reacting to their motion. Photorealistic, 8k, unreal engine 5 "
            "render style, sci-fi movie aesthetics, high contrast, volumetric lighting."
        ),
        negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        output_path=output_path.as_posix(),
        seed=DEFAULT_SEED,
        height=DEFAULT_HEIGHT,
        width=DEFAULT_WIDTH,
        num_frames=DEFAULT_NUM_FRAMES,
        frame_rate=DEFAULT_FRAME_RATE,
        num_inference_steps=DEFAULT_NUM_INFERENCE_STEPS,
        cfg_guidance_scale=DEFAULT_CFG_GUIDANCE_SCALE,
        video_conditioning=[(control_path.as_posix(), 0.8)],
        images=[(image_path.as_posix(), 0, 1.0)],
        tiling_config=TilingConfig.default(),
    )

    # Compare to expected output
    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_ic_lora_i2v.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()
