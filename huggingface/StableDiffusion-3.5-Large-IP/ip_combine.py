"""Blending math for combining several InstantX SD3.5 IP-Adapter image prompts.

Kept separate from the pipeline so it can be tested without loading diffusers
or the 8B transformer.

The InstantX TimeResampler was trained on a *single* SigLIP embedding. A naive
`mean(scale_i * embed_i)` does two harmful things at once:

- Different images average toward a ghost embedding the resampler never saw.
- Raw scales are not renormalized, so three images at 1.0 each are *not* the
  same total strength as one image at 1.0 — and the UI sliders go up to 16.

`mean` mode still averages, but with weights that average 1.0 so total IP
strength stays on `ipadapter_scale`. `concat` mode projects each image on its
own (in-distribution) and concatenates the 64-token sets so joint attention
can pick features per image — that is what multi-subject composition needs.
"""

import torch

# InstantX uses 64 tokens per image. Five UI slots → 320 tokens. The processor
# concatenates IP keys/values along the sequence dim, so this is only an
# attention-cost cap, not an architectural limit.
MAX_IP_TOKENS = 320
TOKENS_PER_IMAGE = 64

COMBINE_MODES = ("mean", "concat")
SIGLIP_IMAGE_ENCODER = "google/siglip-so400m-patch14-384"


def normalize_weights(weights, eps=1e-6):
    """Rescale per-image weights so they average 1.0.

    Balance between images and overall IP strength are separate knobs: the
    caller controls strength with `ipadapter_scale`, and these weights only
    decide how the images divide that strength. A degenerate all-zero set
    falls back to uniform weights rather than dividing by ~0.
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
    """Weighted mean of a list of tensors, with weights that average 1.0."""
    if len(embeds_list) != len(weights):
        raise ValueError("embeds_list and weights must be the same length")
    stacked = torch.stack(embeds_list, dim=0)
    w = torch.tensor(weights, dtype=stacked.dtype, device=stacked.device)
    w = w.view(-1, *([1] * (stacked.dim() - 1)))
    return (stacked * w).sum(dim=0) / len(weights)


def plan_concat_slots(num_images, tokens_per_image=TOKENS_PER_IMAGE, max_tokens=MAX_IP_TOKENS):
    """How many token slots 'concat' mode may use for `num_images` images."""
    return max(1, min(num_images, max_tokens // max(1, tokens_per_image)))


def group_concat_slots(weights, tokens_per_image=TOKENS_PER_IMAGE, max_tokens=MAX_IP_TOKENS):
    """Assign image indices to concat token slots, and weight each slot.

    Under budget every image gets its own slot. Over budget the highest-weighted
    images keep theirs and the rest collapse into the final slot.
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


def collect_slots(images_and_scales):
    """Drop empty slots. Returns (images, weights)."""
    images = []
    weights = []
    for image, scale in images_and_scales:
        if image is None:
            continue
        images.append(image)
        weights.append(scale)
    if not images:
        raise ValueError("at least one image prompt is required")
    return images, weights


def plan_image_embeds(embeds_list, weights, combine_mode="concat"):
    """Turn per-image CLIP embeds into slots the TimeResampler should see.

    Returns a list of (clip_embeds, slot_weight). `mean` (or a single image)
    yields one slot. `concat` yields one slot per image (or a merged remainder
    when over the token budget).

    The TimeResampler is timestep-dependent and ends in LayerNorm, so the
    caller must project each slot separately *inside* the denoising loop and
    concatenate the 64-token outputs — never average after `norm_out`.
    """
    if combine_mode not in COMBINE_MODES:
        raise ValueError(f"combine_mode must be one of {COMBINE_MODES}, got {combine_mode!r}")
    if len(embeds_list) != len(weights):
        raise ValueError("embeds_list and weights must be the same length")

    weights = normalize_weights(weights)

    if combine_mode == "mean" or len(embeds_list) == 1:
        return [(weighted_mean(embeds_list, weights), 1.0)]

    groups, group_weights = group_concat_slots(weights)
    slots = []
    for group, group_weight in zip(groups, group_weights):
        members = [embeds_list[i] for i in group]
        if len(members) == 1:
            clip_embeds = members[0]
        else:
            clip_embeds = weighted_mean(
                members, normalize_weights([weights[i] for i in group]))
        slots.append((clip_embeds, group_weight))
    return slots
