"""Tests for the multi-image blending math.

Run from the Space root:  python -m pytest tests/ -q
"""

import importlib.util
import os

import pytest
import torch

# Loaded by path rather than as `ip_adapter.combine`: the package __init__ pulls
# in diffusers and transformers, and none of this math needs them.
_COMBINE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ip_adapter", "combine.py")
_spec = importlib.util.spec_from_file_location("ip_adapter_combine", _COMBINE_PATH)
combine = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(combine)

group_concat_slots = combine.group_concat_slots
normalize_weights = combine.normalize_weights
plan_concat_slots = combine.plan_concat_slots
weighted_mean = combine.weighted_mean


def test_normalize_weights_averages_one():
    for weights in ([1.0], [1.0, 1.0, 1.0], [0.2, 5.0], [3.0, 1.0, 0.5, 2.0, 0.25]):
        normalized = normalize_weights(weights)
        assert sum(normalized) == pytest.approx(len(weights))


def test_normalize_weights_preserves_ratios():
    assert normalize_weights([1.0, 3.0]) == pytest.approx([0.5, 1.5])
    # Scaling every slider by the same factor is a no-op: balance and total
    # strength are separate knobs.
    assert normalize_weights([2.0, 6.0]) == pytest.approx(normalize_weights([1.0, 3.0]))


def test_normalize_weights_survives_all_zero():
    assert normalize_weights([0.0, 0.0, 0.0]) == [1.0, 1.0, 1.0]


def test_normalize_weights_rejects_empty():
    with pytest.raises(ValueError):
        normalize_weights([])


def test_weighted_mean_keeps_magnitude():
    """The bug this replaces: mean() of N normalized vectors shrinks by ~1/sqrt(N)."""
    torch.manual_seed(0)
    embeds = [torch.randn(1, 1024) for _ in range(5)]
    blended = weighted_mean(embeds, normalize_weights([1.0] * 5))
    naive = torch.stack(embeds, dim=0).mean(dim=0)
    # Same thing at equal weights — the shrinkage came from averaging *after*
    # the projection's LayerNorm, not from the mean itself.
    assert torch.allclose(blended, naive, atol=1e-6)


def test_weighted_mean_of_identical_inputs_is_identity():
    """Whatever the weights, blending copies of one embedding must not scale it."""
    embed = torch.randn(1, 1024)
    for weights in ([1.0, 1.0], [0.25, 4.0], [1.0, 2.0, 3.0][:2]):
        blended = weighted_mean([embed, embed], normalize_weights(weights))
        assert torch.allclose(blended, embed, atol=1e-5)


def test_weighted_mean_single_image_is_unchanged():
    """Single-image generation must be a pass-through, no regression."""
    embed = torch.randn(1, 1024)
    for scale in (0.0, 1.0, 7.5):
        assert torch.allclose(weighted_mean([embed], normalize_weights([scale])), embed)


def test_weighted_mean_respects_balance():
    a, b = torch.zeros(1, 4), torch.ones(1, 4)
    assert torch.allclose(weighted_mean([a, b], normalize_weights([1.0, 1.0])),
                          torch.full((1, 4), 0.5))
    assert torch.allclose(weighted_mean([a, b], normalize_weights([1.0, 3.0])),
                          torch.full((1, 4), 0.75))
    assert torch.allclose(weighted_mean([a, b], normalize_weights([1.0, 0.0])), a)


def test_weighted_mean_rejects_length_mismatch():
    with pytest.raises(ValueError):
        weighted_mean([torch.zeros(1, 4)], [1.0, 1.0])


def test_plan_concat_slots_within_budget():
    for n in range(1, 6):
        assert plan_concat_slots(n, 4, max_tokens=64) == n


def test_plan_concat_slots_caps_at_budget():
    assert plan_concat_slots(100, 4, max_tokens=64) == 16
    assert plan_concat_slots(100, 16, max_tokens=64) == 4
    # Never zero, even when one image alone blows the budget.
    assert plan_concat_slots(3, 128, max_tokens=64) == 1


def test_group_concat_slots_one_group_per_image_within_budget():
    groups, group_weights = group_concat_slots([1.0, 2.0, 1.0], 4)
    assert groups == [[0], [1], [2]]
    assert group_weights == pytest.approx(normalize_weights([1.0, 2.0, 1.0]))


def test_group_concat_slots_merges_lowest_weighted_overflow():
    weights = [1.0, 5.0, 2.0, 3.0]
    groups, group_weights = group_concat_slots(weights, 4, max_tokens=8)
    # Two slots: the strongest image keeps its own, the rest collapse.
    assert groups[0] == [1]
    assert sorted(groups[1]) == [0, 2, 3]
    assert sum(group_weights) == pytest.approx(len(groups))


def test_group_concat_slots_merged_slot_takes_mean_not_sum():
    """A merged slot must not get an out-of-distribution magnitude."""
    weights = [1.0] * 8
    groups, group_weights = group_concat_slots(weights, 4, max_tokens=8)
    assert len(groups) == 2
    assert group_weights == pytest.approx([1.0, 1.0])


def test_group_concat_slots_degenerate_single_slot():
    groups, group_weights = group_concat_slots([1.0, 2.0, 3.0], 64, max_tokens=64)
    assert [sorted(group) for group in groups] == [[0, 1, 2]]
    assert group_weights == pytest.approx([1.0])
