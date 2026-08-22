# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Andrew Kvochko

import pytest
import torch

from ltx_core.model.transformer.attention import AttentionFunction

FIXTURE = torch.Tensor(
    [
        [
            [
                2.5469,
                -0.7148,
                -0.4941,
                0.1270,
                0.1016,
                -0.4043,
                0.9023,
                0.8086,
                -0.6875,
                0.1377,
                1.0391,
                0.0928,
                -0.3750,
                -0.0908,
                2.0625,
                -1.8125,
                -0.2715,
                0.2812,
                -1.0391,
                0.7773,
                0.8828,
                0.0444,
                -1.4844,
                1.1328,
                1.3281,
                -1.2578,
                0.9492,
                -0.6562,
                0.9102,
                -0.6289,
                -0.6602,
                2.0781,
            ]
        ]
    ]
)


def _xformers_available() -> bool:
    """Check if xformers can be imported."""
    try:
        from xformers.ops import memory_efficient_attention  # noqa: F401, PLC0415

        return True
    except ImportError:
        return False


def test_attention_function_pytorch() -> None:
    attention_function = AttentionFunction.PYTORCH
    assert attention_function(
        torch.tensor([[[1, 2, 3]]], dtype=torch.float32),
        torch.tensor([[[4, 5, 6]]], dtype=torch.float32),
        torch.tensor([[[7, 8, 9]]], dtype=torch.float32),
        1,
    ).tolist() == [[[7, 8, 9]]]


@pytest.mark.skipif(not torch.cuda.is_available(), reason="XFormersAttention requires CUDA")
def test_xformers_attention() -> None:
    try:
        from xformers.ops import memory_efficient_attention  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("XFormersAttention requires xformers to be installed")
    attention_function = AttentionFunction.XFORMERS
    shape = FIXTURE.shape
    torch.manual_seed(0)
    q = torch.randn(shape, dtype=torch.bfloat16, device=torch.device("cuda"))
    k = torch.randn(shape, dtype=torch.bfloat16, device=torch.device("cuda"))
    v = torch.randn(shape, dtype=torch.bfloat16, device=torch.device("cuda"))
    fixture = FIXTURE.to(device=torch.device("cuda"), dtype=torch.bfloat16)
    result = attention_function(q, k, v, 1)
    assert torch.allclose(result, fixture, atol=1e-4, rtol=1e-4)


@pytest.mark.skipif(
    not torch.cuda.is_available() or _xformers_available(),
    reason="FlashAttention3 requires CUDA and should only run if xformers is not available",
)
def test_flash_attention_3() -> None:
    try:
        import flash_attn_interface  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("FlashAttention3 requires FlashAttention3 to be installed")
    attention_function = AttentionFunction.FLASH_ATTENTION_3
    shape = FIXTURE.shape
    torch.manual_seed(0)
    q = torch.randn(shape, dtype=torch.bfloat16, device=torch.device("cuda"))
    k = torch.randn(shape, dtype=torch.bfloat16, device=torch.device("cuda"))
    v = torch.randn(shape, dtype=torch.bfloat16, device=torch.device("cuda"))
    fixture = FIXTURE.to(device=torch.device("cuda"), dtype=torch.bfloat16)
    result = attention_function(q, k, v, 1)
    assert torch.allclose(result, fixture, atol=1e-4, rtol=1e-4)
