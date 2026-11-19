import json
import os
from pathlib import Path
from typing import Generator

import pytest
import torch
from PIL import Image as PILImage

from ltx_core.loader.single_gpu_model_builder import SingleGPUModelBuilder as Builder
from ltx_core.model.clip.gemma.encoders.av_encoder import (
    AV_GEMMA_TEXT_ENCODER_KEY_OPS,
    AVGemmaTextEncoderModel,
    AVGemmaTextEncoderModelConfigurator,
)
from ltx_core.model.clip.gemma.encoders.base_encoder import module_ops_from_gemma_root

MODELS_PATH = Path(os.getenv("MODELS_PATH", "/models"))
GEMMA_ROOT_PATH = MODELS_PATH / "comfyui_models" / "text_encoders" / "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj"
CHECKPOINT_PATH = MODELS_PATH / "comfyui_models" / "checkpoints" / "ltx-av-step-1933500-split-new-vae.safetensors"
TEXT_PROMPT = "A knight with a red cape faces fire breathing dragon."
with open("packages/ltx-core/tests/ltx_core/model/clip/assets/enhanced_prompts.json", "r") as f:
    ENHANCED_PROMPTS = json.load(f)
I2V_ENHANCED_TEXT_PROMPT = ENHANCED_PROMPTS["I2V_ENHANCED_TEXT_PROMPT"]
T2V_ENHANCED_TEXT_PROMPT = ENHANCED_PROMPTS["T2V_ENHANCED_TEXT_PROMPT"]
IMG = PILImage.open("packages/ltx-core/tests/ltx_core/model/clip/assets/dragon_1.png").convert("RGB")


@pytest.fixture(scope="session")
def text_encoder() -> Generator[AVGemmaTextEncoderModel, None, None]:
    if not torch.cuda.is_available():
        pytest.skip("This test runs too slow on CPU")
    if not CHECKPOINT_PATH.exists() or not GEMMA_ROOT_PATH.exists():
        pytest.skip("Checkpoints inaccessible")

    model = Builder(
        model_path=CHECKPOINT_PATH,
        model_class_configurator=AVGemmaTextEncoderModelConfigurator,
        model_sd_ops=AV_GEMMA_TEXT_ENCODER_KEY_OPS,
        module_ops=module_ops_from_gemma_root(GEMMA_ROOT_PATH),
    ).build(device=torch.device("cuda"))
    yield model

    # optional cleanup
    del model
    torch.cuda.empty_cache()


def test_model_loading_with_img_processor(text_encoder: AVGemmaTextEncoderModel) -> None:
    assert text_encoder is not None


def test_enhance_i2v(text_encoder: AVGemmaTextEncoderModel) -> None:
    enhanced_text_prompt = text_encoder.enhance_i2v(TEXT_PROMPT, IMG)
    assert enhanced_text_prompt is not None
    assert enhanced_text_prompt[:64] == I2V_ENHANCED_TEXT_PROMPT[:64]


def test_enhance_t2v(text_encoder: AVGemmaTextEncoderModel) -> None:
    enhanced_text_prompt = text_encoder.enhance_t2v(TEXT_PROMPT)
    assert enhanced_text_prompt is not None
    assert enhanced_text_prompt[:128] == T2V_ENHANCED_TEXT_PROMPT[:128]
