# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Andrew Kvochko

import pytest
import torch

from ltx_core.model.transformer.model import LTXModelType
from ltx_core.model.transformer.model_configurator import LTXModelConfigurator, LTXVideoOnlyModelConfigurator

VIDEO_ONLY_CONFIG = {
    "transformer": {
        "dropout": 0.0,
        "norm_num_groups": 32,
        "attention_bias": True,
        "num_vector_embeds": None,
        "activation_fn": "gelu-approximate",
        "num_embeds_ada_norm": 1000,
        "use_linear_projection": False,
        "only_cross_attention": False,
        "cross_attention_norm": True,
        "double_self_attention": False,
        "upcast_attention": False,
        "standardization_norm": "rms_norm",
        "norm_elementwise_affine": False,
        "qk_norm": "rms_norm",
        "positional_embedding_type": "rope",
        "causal_temporal_positioning": True,
        "use_middle_indices_grid": True,
    }
}

AUDIO_VIDEO_TRANSFORMER_CONFIG_DELTA = {
    "use_audio_video_cross_attention": True,
    "share_ff": False,
    "av_cross_ada_norm": True,
    "audio_num_attention_heads": 32,
    "audio_attention_head_dim": 64,
    "audio_in_channels": 128,
    "audio_out_channels": 128,
    "audio_cross_attention_dim": 2048,
    "audio_positional_embedding_max_pos": [20],
    "av_ca_timestep_scale_multiplier": 1,
}


def test_audio_video_model() -> None:
    transformer_config = VIDEO_ONLY_CONFIG.copy()
    transformer_config["transformer"].update(AUDIO_VIDEO_TRANSFORMER_CONFIG_DELTA)
    with torch.device("meta"):
        with pytest.raises(ValueError, match="Config value"):
            LTXModelConfigurator.from_config({})
        model = LTXModelConfigurator.from_config(transformer_config)
    assert model is not None
    assert model.model_type == LTXModelType.AudioVideo


def test_video_only_model() -> None:
    with torch.device("meta"):
        with pytest.raises(ValueError, match="Config value"):
            LTXVideoOnlyModelConfigurator.from_config({})
        model = LTXVideoOnlyModelConfigurator.from_config(VIDEO_ONLY_CONFIG)
    assert model is not None
    assert model.model_type == LTXModelType.VideoOnly
