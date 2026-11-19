# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Amit Pintz.

from dataclasses import dataclass

import torch

from ltx_core.pipeline.components.protocols import GuiderProtocol


@dataclass(frozen=True)
class CFGGuider(GuiderProtocol):
    scale: float

    def delta(self, cond: torch.Tensor, uncond: torch.Tensor) -> torch.Tensor:
        return (self.scale - 1) * (cond - uncond)

    def enabled(self) -> bool:
        return self.scale != 1.0


@dataclass(frozen=True)
class CFGStarRescalingGuider(GuiderProtocol):
    """
    Calculates the CFG delta between conditioned and unconditioned samples.

    To minimize offset in the denoising direction and move mostly along the
    conditioning axis within the distribution, the unconditioned sample is
    rescaled in accordance with the norm of the conditioned sample.

    Attributes:
        scale (float):
            Global guidance strength. A value of 1.0 corresponds to no extra
            guidance beyond the base model prediction. Values > 1.0 increase
            the influence of the conditioned sample relative to the
            unconditioned one.
    """

    scale: float

    def delta(self, cond: torch.Tensor, uncond: torch.Tensor) -> torch.Tensor:
        # LT_INTERNAL_BEGIN
        # https://github.com/LightricksResearch/ComfyUI-LTXVideo-Internal/blob/96de7501458e6d83ec849e9feb62dd0cb33a6d14/stg.py#L375-L385
        # LT_INTERNAL_END
        rescaled_neg = projection_coef(cond, uncond) * uncond
        return (self.scale - 1) * (cond - rescaled_neg)

    def enabled(self) -> bool:
        return self.scale != 1.0


@dataclass(frozen=True)
class STGGuider(GuiderProtocol):
    """
    Calculates the STG delta between conditioned and perturbed denoised samples.

    Perturbed samples are the result of the denoising process with perturbations,
    e.g. attentions acting as passthrough for certain layers and modalities.

    Attributes:
        scale (float):
            Global strength of the STG guidance. A value of 0.0 disables the
            guidance. Larger values increase the correction applied in the
            direction of (pos_denoised - perturbed_denoised).
    """

    scale: float

    def delta(self, pos_denoised: torch.Tensor, perturbed_denoised: torch.Tensor) -> torch.Tensor:
        return self.scale * (pos_denoised - perturbed_denoised)

    def enabled(self) -> bool:
        return self.scale != 0.0


@dataclass(frozen=True)
class LtxAPGGuider(GuiderProtocol):
    """
    Calculates the APG (adaptive projected guidance) delta between conditioned
    and unconditioned samples.

    To minimize offset in the denoising direction and move mostly along the
    conditioning axis within the distribution, the (cond - uncond) delta is
    decomposed into components parallel and orthogonal to the conditioned
    sample. The `eta` parameter weights the parallel component, while `scale`
    is applied to the orthogonal component. Optionally, a norm threshold can
    be used to suppress guidance when the magnitude of the correction is small.

    Attributes:
        scale (float):
            Strength applied to the component of the guidance that is orthogonal
            to the conditioned sample. Controls how aggressively we move in
            directions that change semantics but stay consistent with the
            conditioning manifold.

        eta (float):
            Weight of the component of the guidance that is parallel to the
            conditioned sample. A value of 1.0 keeps the full parallel
            component; values in [0, 1] attenuate it, and values > 1.0 amplify
            motion along the conditioning direction.

        norm_threshold (float):
            Minimum L2 norm of the guidance delta below which the guidance
            can be reduced or ignored (depending on implementation).
            This is useful for avoiding noisy or unstable updates when the
            guidance signal is very small.
    """

    scale: float
    eta: float = 1.0
    norm_threshold: float = 0.0

    def delta(self, cond: torch.Tensor, uncond: torch.Tensor) -> torch.Tensor:
        """
        LT_INTERNAL_BEGIN
        according to
        https://github.com/LightricksResearch/ComfyUI-LTXVideo-Internal/blob/e214b4dff8fc0647d45f629ddd50f75ac7beb6d4/stg.py#L55-L71
        LT_INTERNAL_END
        """
        guidance = cond - uncond
        if self.norm_threshold > 0:
            ones = torch.ones_like(guidance)
            guidance_norm = guidance.norm(p=2, dim=[-1, -2, -3], keepdim=True)
            scale_factor = torch.minimum(ones, self.norm_threshold / guidance_norm)
            guidance = guidance * scale_factor
        proj_coeff = projection_coef(guidance, cond)
        g_parallel = proj_coeff * cond
        g_orth = guidance - g_parallel
        g_apg = g_parallel * self.eta + g_orth

        return g_apg * (self.scale - 1)

    def enabled(self) -> bool:
        return self.scale != 1.0


@dataclass(frozen=False)
class LegacyStatefulAPGGuider(GuiderProtocol):
    """
    Calculates the APG (adaptive projected guidance) delta between conditioned
    and unconditioned samples.

    LT_INTERNAL_BEGIN
    according to
    https://github.com/LightricksResearch/ComfyUI/blob/f897754ce318b4184e8e4f3807a7c76293947738/comfy_extras/nodes_apg.py#L13
    in comfy APG replaces CFG by substituting cond with a modified one
    it is users responsibility to use only one of them, not both in the same pipeline
    LT_INTERNAL_END

    To minimize offset in the denoising direction and move mostly along the
    conditioning axis within the distribution, the (cond - uncond) delta is
    decomposed into components parallel and orthogonal to the conditioned
    sample. The `eta` parameter weights the parallel component, while `scale`
    is applied to the orthogonal component. Optionally, a norm threshold can
    be used to suppress guidance when the magnitude of the correction is small.

    Attributes:
        scale (float):
            Strength applied to the component of the guidance that is orthogonal
            to the conditioned sample. Controls how aggressively we move in
            directions that change semantics but stay consistent with the
            conditioning manifold.

        eta (float):
            Weight of the component of the guidance that is parallel to the
            conditioned sample. A value of 1.0 keeps the full parallel
            component; values in [0, 1] attenuate it, and values > 1.0 amplify
            motion along the conditioning direction.

        norm_threshold (float):
            Minimum L2 norm of the guidance delta below which the guidance
            can be reduced or ignored (depending on implementation).
            This is useful for avoiding noisy or unstable updates when the
            guidance signal is very small.

        momentum (float):
            Exponential moving-average coefficient for accumulating guidance
            over time. running_avg = momentum * running_avg + guidance
    """

    scale: float
    eta: float
    norm_threshold: float = 5.0
    momentum: float = 0.0
    # it is user's responsibility not to use same APGGuider for several denoisings or different modalities
    # in order not to share accumulated average across different denoisings or modalities
    running_avg: torch.Tensor | None = None

    def delta(self, cond: torch.Tensor, uncond: torch.Tensor) -> torch.Tensor:
        """
        LT_INTERNAL_BEGIN
        combining https://github.com/LightricksResearch/ComfyUI/blob/f897754ce318b4184e8e4f3807a7c76293947738/comfy_extras/nodes_apg.py#L89
        with https://github.com/LightricksResearch/ComfyUI/blob/f897754ce318b4184e8e4f3807a7c76293947738/comfy/samplers.py#L359
        we get cfg_result = cond + modified_guidance * cond_scale
        our convention is for guiders to return the delta which is to be added to the cond,
        so we return g_apg * self.guidance_scale
        LT_INTERNAL_END
        """
        guidance = cond - uncond
        if self.momentum != 0:
            if self.running_avg is None:
                self.running_avg = guidance.clone()
            else:
                self.running_avg = self.momentum * self.running_avg + guidance
            guidance = self.running_avg

        if self.norm_threshold > 0:
            ones = torch.ones_like(guidance)
            guidance_norm = guidance.norm(p=2, dim=[-1, -2, -3], keepdim=True)
            scale_factor = torch.minimum(ones, self.norm_threshold / guidance_norm)
            guidance = guidance * scale_factor

        proj_coeff = projection_coef(guidance, cond)
        g_parallel = proj_coeff * cond
        g_orth = guidance - g_parallel
        g_apg = g_parallel * self.eta + g_orth

        return g_apg * self.scale

    def enabled(self) -> bool:
        return self.scale != 0.0


def projection_coef(to_project: torch.Tensor, project_onto: torch.Tensor) -> torch.Tensor:
    batch_size = to_project.shape[0]
    positive_flat = to_project.reshape(batch_size, -1)
    negative_flat = project_onto.reshape(batch_size, -1)
    dot_product = torch.sum(positive_flat * negative_flat, dim=1, keepdim=True)
    squared_norm = torch.sum(negative_flat**2, dim=1, keepdim=True) + 1e-8
    return dot_product / squared_norm
