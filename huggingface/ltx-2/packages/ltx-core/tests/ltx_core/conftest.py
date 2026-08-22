import os
from pathlib import Path
from typing import Callable

import av
import pytest
import torch
import torch.nn.functional as F
from torch._prims_common import DeviceLikeType

torch.use_deterministic_algorithms(True)
os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"

MODELS_PATH = Path(os.getenv("MODELS_PATH", "/models"))
CHECKPOINTS_DIR = MODELS_PATH / "comfyui_models" / "checkpoints"
LORAS_DIR = MODELS_PATH / "comfyui_models" / "loras"

GEMMA_ROOT = MODELS_PATH / "comfyui_models" / "text_encoders" / "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj"
DISTILLED_CHECKPOINT_PATH = CHECKPOINTS_DIR / "ltx-av-distilled-teacher-1933500-step-25700-ema.safetensors"
AV_CHECKPOINT_SPLIT_PATH = CHECKPOINTS_DIR / "ltx-av-step-1933500-split-new-vae.safetensors"
SPATIAL_UPSAMPLER_PATH = CHECKPOINTS_DIR / "ltx2-spatial-upscaler-x2-1.0.bf16.safetensors"
DISTILLED_LORA_PATH = (
    LORAS_DIR / "ltxv" / "ltx2" / "ltx-av-distilled-teacher-1933500-step-25700-ema-lora-384_comfy.safetensors"
)
ROOT_DIR = Path(__file__).parent
OUTPUT_DIR = ROOT_DIR / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


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
