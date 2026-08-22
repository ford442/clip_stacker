import torch

from ltx_core.pipeline.components.guiders import (
    CFGGuider,
    CFGStarRescalingGuider,
    LegacyStatefulAPGGuider,
    LtxAPGGuider,
    STGGuider,
    projection_coef,
)


def test_cfg_guider_delta_scales_difference() -> None:
    guider = CFGGuider(scale=2.0)
    cond = torch.tensor([2.0, 4.0])
    uncond = torch.tensor([1.0, 1.0])

    # (scale - 1) * (cond - uncond) = 1.0 * [1.0, 3.0]
    delta = guider.delta(cond=cond, uncond=uncond)
    expected = [1.0, 3.0]

    assert delta.tolist() == expected


def test_cfg_star_rescaling_guider_delta() -> None:
    guider = CFGStarRescalingGuider(scale=2.0)
    cond = torch.tensor([[2.0, 4.0]])
    uncond = torch.tensor([[1.0, 1.0]])

    # projection_coef(cond, uncond) = (2*1 + 4*1) / (1^2 + 1^2 + 1e-8) = 6 / 2 = 3.0
    # rescaled_neg = 3.0 * [1.0, 1.0] = [3.0, 3.0]
    # (scale - 1) * (cond - rescaled_neg) = 1.0 * ([2.0, 4.0] - [3.0, 3.0]) = [-1.0, 1.0]
    delta = guider.delta(cond=cond, uncond=uncond)
    expected = [[-1.0, 1.0]]

    assert torch.allclose(delta, torch.tensor(expected))


def test_stg_guider_delta() -> None:
    guider = STGGuider(scale=2.0)
    pos_denoised = torch.tensor([2.0, 4.0])
    perturbed_denoised = torch.tensor([1.0, 1.0])

    # scale * (pos_denoised - perturbed_denoised) = 2.0 * [1.0, 3.0] = [2.0, 6.0]
    delta = guider.delta(pos_denoised=pos_denoised, perturbed_denoised=perturbed_denoised)
    expected = [2.0, 6.0]

    assert delta.tolist() == expected


def test_ltx_apg_guider_delta() -> None:
    guider = LtxAPGGuider(scale=2.0, eta=0.5)
    cond = torch.tensor([[[[2.0, 4.0]]]])
    uncond = torch.tensor([[[[1.0, 1.0]]]])

    # guidance = cond - uncond = [1.0, 3.0]
    # proj_coeff = projection_coef(guidance, cond) = (1*2 + 3*4) / (2^2 + 4^2 + 1e-8) = 14 / 20 = 0.7
    # g_parallel = 0.7 * [2.0, 4.0] = [1.4, 2.8]
    # g_orth = [1.0, 3.0] - [1.4, 2.8] = [-0.4, 0.2]
    # g_apg = [1.4, 2.8] * 0.5 + [-0.4, 0.2] = [0.7, 1.4] + [-0.4, 0.2] = [0.3, 1.6]
    # delta = g_apg * (guidance_scale - 1) = [0.3, 1.6] * 1.0 = [0.3, 1.6]
    delta = guider.delta(cond=cond, uncond=uncond)
    expected = [[0.3, 1.6]]

    assert torch.allclose(delta, torch.tensor(expected))


def test_ltx_apg_guider_delta_with_norm_threshold() -> None:
    guider = LtxAPGGuider(scale=2.0, eta=0.5, norm_threshold=1.0)
    cond = torch.tensor([[[[2.0, 4.0]]]])
    uncond = torch.tensor([[[[1.0, 1.0]]]])

    # guidance = cond - uncond = [1.0, 3.0]
    # guidance_norm = sqrt(1^2 + 3^2) = sqrt(10) ≈ 3.16
    # Since norm_threshold (1.0) < guidance_norm, scale_factor = 1.0 / 3.16 ≈ 0.316
    # guidance = [1.0, 3.0] * 0.316 ≈ [0.316, 0.949]
    # Then proceed with APG calculation
    delta = guider.delta(cond=cond, uncond=uncond)

    # Verify the shape and that it's not all zeros
    assert delta.shape == cond.shape
    assert not torch.allclose(delta, torch.zeros_like(delta))


def test_legacy_stateful_apg_guider_delta() -> None:
    guider = LegacyStatefulAPGGuider(scale=2.0, eta=0.5, momentum=0.0)
    cond = torch.tensor([[[[2.0, 4.0]]]])
    uncond = torch.tensor([[[[1.0, 1.0]]]])

    # guidance = cond - uncond = [1.0, 3.0]
    # Since momentum=0.0, no running average is used
    # Since norm_threshold=5.0 (default) > guidance_norm, no scaling
    # proj_coeff = projection_coef(guidance, cond) = (1*2 + 3*4) / (2^2 + 4^2 + 1e-8) = 14 / 20 = 0.7
    # g_parallel = 0.7 * [2.0, 4.0] = [1.4, 2.8]
    # g_orth = [1.0, 3.0] - [1.4, 2.8] = [-0.4, 0.2]
    # g_apg = [1.4, 2.8] * 0.5 + [-0.4, 0.2] = [0.3, 1.6]
    # delta = g_apg * guidance_scale = [0.3, 1.6] * 2.0 = [0.6, 3.2]
    delta = guider.delta(cond=cond, uncond=uncond)
    expected = [[0.6, 3.2]]

    assert torch.allclose(delta, torch.tensor(expected))


def test_legacy_stateful_apg_guider_delta_with_momentum() -> None:
    guider = LegacyStatefulAPGGuider(scale=2.0, eta=0.5, momentum=0.5, norm_threshold=0.0)
    cond = torch.tensor([[[[2.0, 4.0]]]])
    uncond = torch.tensor([[[[1.0, 1.0]]]])

    # First call: running_avg = guidance = [1.0, 3.0]
    delta1 = guider.delta(cond=cond, uncond=uncond)

    # Second call: running_avg = 0.5 * [1.0, 3.0] + [1.0, 3.0] = [1.5, 4.5]
    # and guidance = [1.5, 4.5]
    delta2 = guider.delta(cond=cond, uncond=uncond)

    # Verify the shape and that deltas are different (momentum affects result)
    assert delta1.shape == cond.shape
    assert delta2.shape == cond.shape
    assert not torch.allclose(delta1, delta2)


def test_projection_coef() -> None:
    to_project = torch.tensor([[2.0, 4.0]])
    project_onto = torch.tensor([[1.0, 1.0]])

    # dot_product = 2*1 + 4*1 = 6
    # squared_norm = 1^2 + 1^2 + 1e-8 = 2 + 1e-8 ≈ 2
    # projection_coef = 6 / 2 = 3.0
    coef = projection_coef(to_project=to_project, project_onto=project_onto)
    expected = [[3.0]]

    assert torch.allclose(coef, torch.tensor(expected))


def test_projection_coef_orthogonal() -> None:
    to_project = torch.tensor([[1.0, 0.0]])
    project_onto = torch.tensor([[0.0, 1.0]])

    # dot_product = 1*0 + 0*1 = 0
    # squared_norm = 0^2 + 1^2 + 1e-8 = 1 + 1e-8
    # projection_coef = 0 / (1 + 1e-8) ≈ 0
    coef = projection_coef(to_project=to_project, project_onto=project_onto)
    expected = [[0.0]]

    assert torch.allclose(coef, torch.tensor(expected), atol=1e-6)


test_ltx_apg_guider_delta()
