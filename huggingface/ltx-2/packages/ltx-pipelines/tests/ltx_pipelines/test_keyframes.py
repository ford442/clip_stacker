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

from ltx_core.tiling import TilingConfig
from ltx_pipelines.keyframe_interpolation import KeyframeInterpolationPipeline
from ltx_pipelines.utils import DEFAULT_CFG_GUIDANCE_SCALE, DEFAULT_NUM_INFERENCE_STEPS, DEFAULT_SEED, get_device

device = get_device()

LORA_PATH = LORAS_DIR / "Internal" / "ltxv_apps" / "playground" / "depth_control.safetensors"


@pytest.mark.e2e
def test_key_frames(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    """Run keyframes interpolation pipeline and verify output matches expected."""

    output_path = OUTPUT_DIR / "keyframes_output.mp4"
    image1_path = ASSETS_DIR / "dragon_1.png"
    image2_path = ASSETS_DIR / "dragon_2.png"

    pipeline = KeyframeInterpolationPipeline(
        checkpoint_path=AV_CHECKPOINT_SPLIT_PATH.resolve().as_posix(),
        distilled_lora_path=DISTILLED_LORA_PATH.resolve().as_posix(),
        distilled_lora_strength=1.0,
        spatial_upsampler_path=SPATIAL_UPSAMPLER_PATH.resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[],
    )

    pipeline(
        prompt=(
            "A single continuous shot, cinematic epic fantasy battle, 10-12 seconds, 24 fps, 16:9. Start in a "
            "hellish volcanic battlefield: ash-filled air, embers drifting, jagged black rocks and small fires "
            "licking the ground. Camera begins behind a lone armored knight with a tattered crimson cape, sword "
            "in right hand and shield in left, standing in a wide stance facing a colossal horned dragon. The "
            "dragon dominates the frame ahead: charcoal-black scales with glowing orange fissures, massive wings "
            "spread, molten sparks shedding from its body. It rears back and unleashes a torrent of fire—bright, "
            "turbulent flame with heat distortion and swirling smoke—blasting toward the knight. The knight "
            "braces, cape whipping violently in the hot wind, shield raised as the fire washes past, scattering "
            "burning debris and kicking up dust. Camera slowly dollies forward and slightly upward, circling a "
            "little to the knight's left, keeping both knight and dragon in view while the environment shakes "
            "subtly from the force of the roar. The knight surges forward through the smoke and embers, closing "
            "distance with determined, heavy steps. The dragon lunges down, claws scraping rock; the knight ducks "
            "under a sweeping wing, sparks bursting where metal meets scale. The camera continues its smooth move, "
            "drifting closer and tighter, following the knight's advance while maintaining the dragon's looming "
            "head and wings in frame. The fire and sparks fade, the color temperature cools, smoke thins into a "
            "gray overcast. The camera glides to the right and lowers, revealing the dragon's enormous head "
            "collapsed on the rocky ground, eyes dim, blood dark against stone. The knight is now seated in "
            "exhaustion beside the dragon's head, armor battered and smeared, cape pooled around him. His sword is "
            "embedded upright in the dragon's skull/neck area, trembling slightly before settling. The knight's "
            "helmeted head hangs, chest rising slowly; ash drifts like snow in the quiet. End on a lingering "
            "close-medium composition: knight slumped against the dragon, ruined landscape and distant broken "
            "silhouette of a fortress in the background under a heavy gray sky. No cuts, only one continuous camera "
            "move and natural lighting shift from fiery chaos to cold silence."
        ),
        negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        output_path=output_path.as_posix(),
        seed=DEFAULT_SEED,
        height=512,
        width=384,
        num_frames=161,
        frame_rate=12.5,
        num_inference_steps=DEFAULT_NUM_INFERENCE_STEPS,
        cfg_guidance_scale=DEFAULT_CFG_GUIDANCE_SCALE,
        images=[(image1_path.as_posix(), 0, 1.0), (image2_path.as_posix(), 160, 1.0)],
        tiling_config=TilingConfig.default(),
    )

    # Compare to expected output
    decoded_video, waveform = decode_video_from_file(path=output_path, device=device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_keyframes.mp4", device=device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() >= 100.0
    assert psnr(waveform, expected_waveform, 1.0, 1e-8).item() >= 80.0

    output_path.unlink()
