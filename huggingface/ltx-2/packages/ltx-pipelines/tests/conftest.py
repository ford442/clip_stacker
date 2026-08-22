import gc
import os
from pathlib import Path
from typing import Callable

import av
import pytest
import torch
import torch.nn.functional as F
from torch._prims_common import DeviceLikeType

# =============================================================================
# Model Paths
# =============================================================================

MODELS_PATH = Path(os.getenv("MODELS_PATH", "/models"))
CHECKPOINTS_DIR = MODELS_PATH / "comfyui_models" / "checkpoints"
LORAS_DIR = MODELS_PATH / "comfyui_models" / "loras"

GEMMA_ROOT = MODELS_PATH / "comfyui_models" / "text_encoders" / "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj"
DISTILLED_CHECKPOINT_PATH = CHECKPOINTS_DIR / "ltx-2-19b-distilled.safetensors"
AV_CHECKPOINT_SPLIT_PATH = CHECKPOINTS_DIR / "ltx-2-19b-dev.safetensors"
SPATIAL_UPSAMPLER_PATH = CHECKPOINTS_DIR / "ltx2-spatial-upscaler-x2-1.0.bf16.safetensors"
DISTILLED_LORA_PATH = LORAS_DIR / "ltxv" / "ltx2" / "ltx-av-distilled-from-42500-lora-384_comfy.safetensors"

# =============================================================================
# Prompts
# =============================================================================

IMG2VID_PROMPT = (
    "A medium close-up shot features a Caucasian man with a beard, wearing a green and white baseball cap "
    "without any letters on the front, and a light blue shirt over a white t-shirt. He is positioned in the "
    "center of the frame, looking intently directly at the camera, his eyes focused on camera. His facial "
    "expression is one of deep concentration, with his brow slightly raised. As he looks straight at the "
    "camera, a quick sniff sound is heard, and then he speaks with a deep male voice and a satisfied tone, "
    "saying, 'I think it's so good.' The camera remains static throughout, maintaining a shallow depth of "
    "field, which keeps the man in sharp focus while the background is softly blurred, showing a beige wall "
    "behind him. After a brief pause, another short, audible sniff is heard. The man then continues to speak, "
    "his voice maintaining the same quality, as he states, 'So good. So good.' He elaborates further, "
    "emphasizing his point with a final statement, 'This got to be, it's got to be the best tool I've ever "
    "seen.'"
)

DEFAULT_NEGATIVE_PROMPT = (
    "blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, "
    "grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, "
    "deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, "
    "wrong hand count, artifacts around text, inconsistent perspective, camera shake, incorrect depth of "
    "field, background too sharp, background clutter, distracting reflections, harsh shadows, inconsistent "
    "lighting direction, color banding, cartoonish rendering, 3D CGI look, unrealistic materials, uncanny "
    "valley effect, incorrect ethnicity, wrong gender, exaggerated expressions, wrong gaze direction, "
    "mismatched lip sync, silent or muted audio, distorted voice, robotic voice, echo, background noise, "
    "off-sync audio, incorrect dialogue, added dialogue, repetitive speech, jittery movement, awkward "
    "pauses, incorrect timing, unnatural transitions, inconsistent framing, tilted camera, flat lighting, "
    "inconsistent tone, cinematic oversaturation, stylized filters, or AI artifacts."
)

torch.use_deterministic_algorithms(True)
os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"

ROOT_DIR = Path(__file__).parent
OUTPUT_DIR = ROOT_DIR / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
ASSETS_DIR = ROOT_DIR / "assets"


@pytest.fixture(autouse=True)
def pre_post_test() -> None:
    """Fixture that runs before and after each test."""
    gc.collect()
    torch.cuda.empty_cache()

    yield

    gc.collect()
    torch.cuda.empty_cache()


def _psnr(pred: torch.Tensor, target: torch.Tensor, max_val: float = 1.0, eps: float = 1e-8) -> torch.Tensor:
    """
    Compute Peak Signal-to-Noise Ratio (PSNR) between two images (or batches of images).

    Args:
        pred:   Predicted image tensor, shape (..., H, W) or (..., C, H, W)
        target: Ground truth image tensor, same shape as `pred`
        max_val: Maximum possible pixel value of the images.
                 For images in [0, 1] use 1.0, for [0, 255] use 255.0, etc.
        eps:    Small value to avoid log of zero.

    Returns:
        psnr: PSNR value (in dB).
    """
    # Ensure same shape
    if pred.shape != target.shape:
        raise ValueError(f"Shape mismatch: pred {pred.shape}, target {target.shape}")

    # Convert to float for safety
    pred = pred.float()
    target = target.float()

    # Mean squared error per sample
    # Flatten over all dims
    if pred.dim() > 1:
        mse = F.mse_loss(pred, target, reduction="none")
        # Reduce over spatial (and channel) dims
        dims = list(range(mse.dim()))
        mse = mse.mean(dim=dims)
    else:
        # 1D case
        mse = F.mse_loss(pred, target, reduction="mean")

    # PSNR computation
    psnr_val = 10.0 * torch.log10((max_val**2) / (mse + eps))

    return psnr_val


@pytest.fixture
def psnr() -> Callable[[torch.Tensor, torch.Tensor, float, float], float]:
    """Fixture that returns the PSNR function."""
    return _psnr


def _decode_video_from_file(path: str, device: DeviceLikeType) -> tuple[torch.Tensor, torch.Tensor | None]:
    container = av.open(path)
    try:
        video_stream = next(s for s in container.streams if s.type == "video")
        audio_stream = next((s for s in container.streams if s.type == "audio"), None)

        frames = []
        audio = [] if audio_stream else None

        streams_to_decode = [video_stream]
        if audio_stream:
            streams_to_decode.append(audio_stream)

        for frame in container.decode(*streams_to_decode):
            if isinstance(frame, av.VideoFrame):
                tensor = torch.tensor(frame.to_rgb().to_ndarray(), dtype=torch.uint8, device=device).unsqueeze(0)
                frames.append(tensor)
            elif isinstance(frame, av.AudioFrame):
                audio.append(torch.tensor(frame.to_ndarray(), dtype=torch.float32, device=device).unsqueeze(0))

        if audio:
            audio = torch.cat(audio)
    finally:
        container.close()

    return torch.cat(frames), audio


@pytest.fixture
def decode_video_from_file() -> Callable[[str], tuple[torch.Tensor, torch.Tensor | None]]:
    """Fixture that returns the function to decode a video from a file."""
    return _decode_video_from_file
