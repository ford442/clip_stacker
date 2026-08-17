"""Tests for InstantX SD3.5 multi-image blending math.

Run from the Space root:  python -m pytest tests/ -q
"""

import os
import sys

import pytest
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ip_combine import (  # noqa: E402
    collect_slots,
    group_concat_slots,
    normalize_weights,
    plan_concat_slots,
    plan_image_embeds,
    weighted_mean,
)


def test_normalize_weights_averages_one():
    for weights in ([1.0], [1.0, 1.0, 1.0], [0.2, 5.0], [3.0, 1.0, 0.5, 2.0, 0.25]):
        normalized = normalize_weights(weights)
        assert sum(normalized) == pytest.approx(len(weights))


def test_normalize_weights_preserves_ratios():
    assert normalize_weights([1.0, 3.0]) == pytest.approx([0.5, 1.5])
    assert normalize_weights([2.0, 6.0]) == pytest.approx(normalize_weights([1.0, 3.0]))


def test_normalize_weights_survives_all_zero():
    assert normalize_weights([0.0, 0.0, 0.0]) == [1.0, 1.0, 1.0]


def test_weighted_mean_of_identical_inputs_is_identity():
    embed = torch.randn(1, 16, 8)
    for weights in ([1.0, 1.0], [0.25, 4.0]):
        blended = weighted_mean([embed, embed], normalize_weights(weights))
        assert torch.allclose(blended, embed, atol=1e-5)


def test_weighted_mean_single_image_is_unchanged():
    embed = torch.randn(1, 16, 8)
    for scale in (0.0, 1.0, 7.5):
        assert torch.allclose(weighted_mean([embed], normalize_weights([scale])), embed)


def test_naive_scaled_mean_is_not_what_we_want():
    """The old pipeline did mean(scale_i * e_i). Three copies at scale 1.0
    happen to work; three copies at scale 2.0 double the magnitude. The new
    path keeps magnitude on ipadapter_scale."""
    embed = torch.ones(1, 4, 4)
    naive = torch.stack([embed * 2.0, embed * 2.0, embed * 2.0], dim=0).mean(dim=0)
    assert torch.allclose(naive, embed * 2.0)
    fixed = weighted_mean([embed, embed, embed], normalize_weights([2.0, 2.0, 2.0]))
    assert torch.allclose(fixed, embed)


def test_collect_slots_drops_nones():
    images, weights = collect_slots([("a", 1.0), (None, 2.0), ("c", 0.5)])
    assert images == ["a", "c"]
    assert weights == [1.0, 0.5]


def test_collect_slots_requires_one_image():
    with pytest.raises(ValueError):
        collect_slots([(None, 1.0), (None, 1.0)])


def test_plan_image_embeds_mean_is_one_slot():
    embeds = [torch.zeros(1, 4, 4), torch.ones(1, 4, 4)]
    slots = plan_image_embeds(embeds, [1.0, 1.0], combine_mode="mean")
    assert len(slots) == 1
    assert slots[0][1] == 1.0
    assert torch.allclose(slots[0][0], torch.full((1, 4, 4), 0.5))


def test_plan_image_embeds_concat_is_one_slot_per_image():
    embeds = [torch.zeros(1, 4, 4), torch.ones(1, 4, 4)]
    slots = plan_image_embeds(embeds, [1.0, 3.0], combine_mode="concat")
    assert len(slots) == 2
    assert torch.allclose(slots[0][0], embeds[0])
    assert torch.allclose(slots[1][0], embeds[1])
    assert [s[1] for s in slots] == pytest.approx(normalize_weights([1.0, 3.0]))


def test_plan_image_embeds_single_image_never_concats():
    embed = torch.randn(1, 4, 4)
    slots = plan_image_embeds([embed], [2.5], combine_mode="concat")
    assert len(slots) == 1
    assert torch.allclose(slots[0][0], embed)


def test_plan_image_embeds_rejects_unknown_mode():
    with pytest.raises(ValueError):
        plan_image_embeds([torch.zeros(1, 2)], [1.0], combine_mode="add")


def test_plan_concat_slots_five_images_fit():
    assert plan_concat_slots(5, 64, max_tokens=320) == 5


def test_group_concat_slots_merges_when_over_budget():
    weights = [1.0, 5.0, 2.0, 3.0]
    groups, group_weights = group_concat_slots(weights, tokens_per_image=64, max_tokens=128)
    assert groups[0] == [1]
    assert sorted(groups[1]) == [0, 2, 3]
    assert sum(group_weights) == pytest.approx(len(groups))
