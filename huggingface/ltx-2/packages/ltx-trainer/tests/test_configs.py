"""Test that all configuration files are valid and can be loaded.

This test automatically discovers all YAML files in the configs/ directory
and validates that they can be deserialized into LtxTrainerConfig objects.
"""

from pathlib import Path

import pytest
import yaml

from ltx_trainer.config import LtxTrainerConfig


def get_config_files() -> list[Path]:
    """Discover all YAML config files in the configs directory.

    Returns:
        List of paths to YAML config files (excluding accelerate configs)
    """
    configs_dir = Path(__file__).parent.parent / "configs"

    # Find all .yaml and .yml files, excluding accelerate subfolder
    config_files = []
    for pattern in ["*.yaml", "*.yml"]:
        config_files.extend(configs_dir.glob(pattern))

    return sorted(config_files)


@pytest.mark.parametrize("config_file", get_config_files(), ids=lambda p: p.name)
def test_config_file_valid(config_file: Path, tmp_path: Path) -> None:
    """Test that a config file can be loaded and validated.

    This test parses the YAML and validates it against LtxTrainerConfig schema.
    Pydantic handles all validation - if deserialization succeeds, the config is valid.

    Note: We create actual dummy files since Pydantic validators check path existence.
    """
    # Load YAML
    with open(config_file) as f:
        config_dict = yaml.safe_load(f)

    # Create dummy files that validators will check for existence
    dummy_model = tmp_path / "dummy_model.safetensors"
    dummy_model.touch()

    dummy_gemma = tmp_path / "dummy_gemma"
    dummy_gemma.mkdir()

    dummy_video = tmp_path / "dummy_video.mp4"
    dummy_video.touch()

    dummy_image = tmp_path / "dummy_image.png"
    dummy_image.touch()

    # Replace file paths with dummy paths that actually exist
    if "model" in config_dict:
        if "model_path" in config_dict["model"]:
            config_dict["model"]["model_path"] = str(dummy_model)
        if "text_encoder_path" in config_dict["model"]:
            config_dict["model"]["text_encoder_path"] = str(dummy_gemma)

    if "data" in config_dict and "preprocessed_data_root" in config_dict["data"]:
        config_dict["data"]["preprocessed_data_root"] = str(tmp_path)

    if "validation" in config_dict:
        # Replace validation paths with dummy paths
        if "images" in config_dict["validation"] and config_dict["validation"]["images"]:
            # Provide dummy image paths (one per prompt)
            num_prompts = len(config_dict["validation"].get("prompts", []))
            config_dict["validation"]["images"] = [str(dummy_image)] * num_prompts

        if "reference_videos" in config_dict["validation"] and config_dict["validation"]["reference_videos"]:
            # Provide dummy video paths (one per prompt)
            num_prompts = len(config_dict["validation"].get("prompts", []))
            config_dict["validation"]["reference_videos"] = [str(dummy_video)] * num_prompts

    # Validate config - Pydantic does all the work!
    # If this doesn't raise ValidationError, the config is valid
    config = LtxTrainerConfig.model_validate(config_dict)

    # Basic sanity check that we got a valid config object
    assert config is not None
