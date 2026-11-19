"""End-to-end checks of IPAdapterXL.generate's conditioning, with the heavy
parts (CLIP encoder, UNet, SDXL pipeline) replaced by stubs.

What matters here is the shape and magnitude of what reaches the pipeline, and
that concat mode leaves `num_tokens` the way it found it. Run from the Space
root:  python -m pytest tests/ -q
"""

import os
import sys
import types

import pytest
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ip_adapter.attention_processor import IPAttnProcessor2_0 as IPAttnProcessor  # noqa: E402
from ip_adapter.ip_adapter import IPAdapterXL, ImageProjModel  # noqa: E402

NUM_TOKENS = 4
CROSS_DIM = 32
CLIP_DIM = 16
TEXT_TOKENS = 7


class FakePipe:
    """Captures what generate() hands the pipeline."""

    def __init__(self, processors):
        self._processors = processors
        self.unet = types.SimpleNamespace(attn_processors=processors)
        self.last_call = None
        self.raises = None

    def encode_prompt(self, prompt, num_images_per_prompt, do_classifier_free_guidance,
                      negative_prompt):
        batch = len(prompt) * num_images_per_prompt
        return (torch.ones(batch, TEXT_TOKENS, CROSS_DIM),
                torch.zeros(batch, TEXT_TOKENS, CROSS_DIM),
                torch.ones(batch, CROSS_DIM),
                torch.zeros(batch, CROSS_DIM))

    def __call__(self, **kwargs):
        if self.raises is not None:
            raise self.raises
        self.last_call = kwargs
        # Snapshot num_tokens *during* the call — restoring it afterwards is
        # only correct if it was actually widened while the UNet ran.
        self.num_tokens_during_call = {
            name: p.num_tokens for name, p in self._processors.items()}
        return types.SimpleNamespace(images=["image"])


def make_adapter():
    processors = {
        "down_blocks.0.attn2.processor": IPAttnProcessor(
            hidden_size=CROSS_DIM, cross_attention_dim=CROSS_DIM, num_tokens=NUM_TOKENS),
        "mid_block.attn2.processor": IPAttnProcessor(
            hidden_size=CROSS_DIM, cross_attention_dim=CROSS_DIM, num_tokens=NUM_TOKENS),
    }
    adapter = IPAdapterXL.__new__(IPAdapterXL)
    adapter.device = "cpu"
    adapter.num_tokens = NUM_TOKENS
    adapter.pipe = FakePipe(processors)
    adapter.image_proj_model = ImageProjModel(
        cross_attention_dim=CROSS_DIM, clip_embeddings_dim=CLIP_DIM,
        clip_extra_context_tokens=NUM_TOKENS).to(torch.float32)

    # Deterministic stand-in for CLIP: each image gets its own constant vector.
    embeds = {}

    def get_clip_image_embeds(pil_image):
        if pil_image not in embeds:
            torch.manual_seed(len(embeds))
            embeds[pil_image] = torch.randn(1, CLIP_DIM)
        return embeds[pil_image]

    adapter.get_clip_image_embeds = get_clip_image_embeds
    return adapter, processors


def ip_tokens(pipe):
    """The image-conditioning block of the last prompt_embeds handed to the pipe."""
    prompt_embeds = pipe.last_call["prompt_embeds"]
    return prompt_embeds[:, TEXT_TOKENS:, :]


def uncond_ip_tokens(pipe):
    negative = pipe.last_call["negative_prompt_embeds"]
    return negative[:, TEXT_TOKENS:, :]


def test_single_image_produces_num_tokens():
    adapter, _ = make_adapter()
    adapter.generate("a", prompt="p", negative_prompt="n", seed=0)
    assert ip_tokens(adapter.pipe).shape == (1, NUM_TOKENS, CROSS_DIM)


def test_mean_mode_token_count_is_independent_of_image_count():
    """Phase A: blending happens pre-projection, so the token block never grows."""
    adapter, _ = make_adapter()
    for images in (("a",), ("a", "b"), ("a", "b", "c", "d", "e")):
        adapter.generate(*images, prompt="p", negative_prompt="n", seed=0)
        assert ip_tokens(adapter.pipe).shape == (1, NUM_TOKENS, CROSS_DIM)


def test_mean_mode_does_not_wash_out_with_more_images():
    """The bug: averaging post-LayerNorm shrank the signal ~1/sqrt(N)."""
    adapter, _ = make_adapter()
    adapter.generate("a", prompt="p", negative_prompt="n", seed=0)
    one_image = ip_tokens(adapter.pipe).norm().item()

    adapter.generate("a", "b", "c", "d", "e", prompt="p", negative_prompt="n", seed=0)
    five_images = ip_tokens(adapter.pipe).norm().item()

    # Post-LayerNorm the five-image norm would land near one_image/sqrt(5).
    assert five_images > one_image * 0.8


def test_mean_mode_scales_do_not_change_total_strength():
    """Fix 2: moving one slider changes balance, not total IP strength."""
    adapter, _ = make_adapter()
    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0,
                     scale_1=1.0, scale_2=1.0)
    balanced = ip_tokens(adapter.pipe).norm().item()

    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0,
                     scale_1=4.0, scale_2=4.0)
    both_up = ip_tokens(adapter.pipe).norm().item()

    # Scaling both sliders equally is a no-op — that knob is set_scale().
    assert both_up == pytest.approx(balanced, rel=1e-5)


def test_mean_mode_scale_shifts_balance():
    adapter, _ = make_adapter()
    adapter.generate("a", prompt="p", negative_prompt="n", seed=0)
    only_a = ip_tokens(adapter.pipe).clone()

    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0,
                     scale_1=1.0, scale_2=0.0)
    a_weighted_fully = ip_tokens(adapter.pipe)

    assert torch.allclose(only_a, a_weighted_fully, atol=1e-5)


def test_uncond_matches_cond_shape_and_is_unscaled():
    """Fix 3: CFG needs the two branches shaped alike and comparably scaled."""
    adapter, _ = make_adapter()
    adapter.generate("a", "b", "c", prompt="p", negative_prompt="n", seed=0,
                     scale_1=5.0, scale_2=0.1, scale_3=1.0)
    assert uncond_ip_tokens(adapter.pipe).shape == ip_tokens(adapter.pipe).shape

    # uncond is image_proj_model(zeros), identical regardless of the sliders.
    first = uncond_ip_tokens(adapter.pipe).clone()
    adapter.generate("a", "b", "c", prompt="p", negative_prompt="n", seed=0,
                     scale_1=1.0, scale_2=1.0, scale_3=1.0)
    assert torch.allclose(first, uncond_ip_tokens(adapter.pipe), atol=1e-6)


def test_concat_mode_widens_token_block():
    """Phase B: one token set per image, so attention can select between them."""
    adapter, _ = make_adapter()
    adapter.generate("a", "b", "c", prompt="p", negative_prompt="n", seed=0,
                     combine_mode="concat")
    assert ip_tokens(adapter.pipe).shape == (1, 3 * NUM_TOKENS, CROSS_DIM)
    assert uncond_ip_tokens(adapter.pipe).shape == (1, 3 * NUM_TOKENS, CROSS_DIM)


def test_concat_mode_sets_num_tokens_during_the_call():
    adapter, _ = make_adapter()
    adapter.generate("a", "b", "c", prompt="p", negative_prompt="n", seed=0,
                     combine_mode="concat")
    assert set(adapter.pipe.num_tokens_during_call.values()) == {3 * NUM_TOKENS}


def test_concat_mode_restores_num_tokens_afterwards():
    adapter, processors = make_adapter()
    adapter.generate("a", "b", "c", prompt="p", negative_prompt="n", seed=0,
                     combine_mode="concat")
    assert all(p.num_tokens == NUM_TOKENS for p in processors.values())


def test_num_tokens_restored_even_when_the_pipeline_raises():
    adapter, processors = make_adapter()
    adapter.pipe.raises = RuntimeError("OOM")
    with pytest.raises(RuntimeError):
        adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0,
                         combine_mode="concat")
    assert all(p.num_tokens == NUM_TOKENS for p in processors.values())


def test_mean_mode_after_concat_mode_is_unaffected():
    """The restore has to actually hold for the next call."""
    adapter, _ = make_adapter()
    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0)
    before = ip_tokens(adapter.pipe).clone()

    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0,
                     combine_mode="concat")
    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0)

    assert torch.allclose(before, ip_tokens(adapter.pipe), atol=1e-6)
    assert set(adapter.pipe.num_tokens_during_call.values()) == {NUM_TOKENS}


def test_concat_mode_with_one_image_matches_mean_mode():
    adapter, _ = make_adapter()
    adapter.generate("a", prompt="p", negative_prompt="n", seed=0)
    mean = ip_tokens(adapter.pipe).clone()
    adapter.generate("a", prompt="p", negative_prompt="n", seed=0, combine_mode="concat")
    assert torch.allclose(mean, ip_tokens(adapter.pipe), atol=1e-6)


def test_num_samples_expands_batch_not_tokens():
    adapter, _ = make_adapter()
    adapter.generate("a", "b", prompt="p", negative_prompt="n", seed=0, num_samples=3,
                     combine_mode="concat")
    assert ip_tokens(adapter.pipe).shape == (3, 2 * NUM_TOKENS, CROSS_DIM)


def test_rejects_unknown_combine_mode():
    adapter, _ = make_adapter()
    with pytest.raises(ValueError, match="combine_mode"):
        adapter.generate("a", prompt="p", negative_prompt="n", seed=0, combine_mode="blend")


def test_projection_runs_once_per_conditional_in_mean_mode():
    """Acceptance criterion: exactly one image_proj_model call for the cond branch."""
    adapter, _ = make_adapter()
    calls = []
    inner = adapter.image_proj_model

    def counting_proj(embeds):
        calls.append(embeds)
        return inner(embeds)

    adapter.image_proj_model = counting_proj
    adapter.generate("a", "b", "c", "d", "e", prompt="p", negative_prompt="n", seed=0)
    # One for the blended conditional, one for the shared unconditional.
    assert len(calls) == 2
