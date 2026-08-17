"""Blending math for combining several image prompts into one conditioning.

Kept separate from `ip_adapter.py` so it can be exercised without loading
diffusers, transformers or a checkpoint.
"""

import torch

# Token budget for 'concat' combine mode. Every image contributes `num_tokens`
# extra tokens to every cross-attention call, so this bounds attention cost when
# a caller throws a lot of images at the adapter.
MAX_IP_TOKENS = 64

COMBINE_MODES = ("mean", "concat")


def normalize_weights(weights, eps=1e-6):
    """Rescale per-image weights so they average 1.0.

    Balance between images and overall IP strength are separate knobs: the
    caller controls strength with `set_scale`, and these weights only decide how
    the images divide that strength between them. Averaging to 1.0 means moving
    one slider changes the balance without changing the total.

    A degenerate all-zero (or negative-cancelling) set falls back to uniform
    weights rather than dividing by ~0.
    """
    weights = [float(w) for w in weights]
    n = len(weights)
    if n == 0:
        raise ValueError("normalize_weights() needs at least one weight")
    total = sum(weights)
    if abs(total) < eps:
        return [1.0] * n
    return [w * n / total for w in weights]


def weighted_mean(embeds_list, weights):
    """Weighted mean of a list of tensors, with weights that average 1.0.

    Equivalent to sum(w_i * e_i) / sum(w_i) for the pre-normalized weights, so
    the result keeps the magnitude of a single embedding instead of shrinking
    like a plain mean of normalized vectors would.
    """
    if len(embeds_list) != len(weights):
        raise ValueError("embeds_list and weights must be the same length")
    stacked = torch.stack(embeds_list, dim=0)
    w = torch.tensor(weights, dtype=stacked.dtype, device=stacked.device)
    w = w.view(-1, *([1] * (stacked.dim() - 1)))
    return (stacked * w).sum(dim=0) / len(weights)


def plan_concat_slots(num_images, tokens_per_image, max_tokens=MAX_IP_TOKENS):
    """How many token slots 'concat' mode may use for `num_images` images.

    Returns at least 1. When the images do not fit in the budget the caller is
    expected to keep the highest-weighted images in their own slots and blend
    the remainder into the last one, so the mode degrades to a partial mean
    instead of an unbounded attention cost.
    """
    return max(1, min(num_images, max_tokens // max(1, tokens_per_image)))


def group_concat_slots(weights, tokens_per_image, max_tokens=MAX_IP_TOKENS):
    """Assign image indices to concat token slots, and weight each slot.

    Under budget every image gets its own slot. Over budget the highest-weighted
    images keep theirs and the rest collapse into the final slot.

    A merged slot carries one blended embedding, so it takes its members' mean
    weight rather than their sum — summing would hand it a magnitude the adapter
    never saw in training. Slot weights are re-normalized to average 1.0 like
    the per-image ones.

    Returns (groups, group_weights).
    """
    num_slots = plan_concat_slots(len(weights), tokens_per_image, max_tokens)
    if num_slots < len(weights):
        order = sorted(range(len(weights)), key=lambda i: weights[i], reverse=True)
        groups = [[i] for i in order[:num_slots - 1]] + [order[num_slots - 1:]]
    else:
        groups = [[i] for i in range(len(weights))]
    group_weights = normalize_weights(
        [sum(weights[i] for i in group) / len(group) for group in groups])
    return groups, group_weights
