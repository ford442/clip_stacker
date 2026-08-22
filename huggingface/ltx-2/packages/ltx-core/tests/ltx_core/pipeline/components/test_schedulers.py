import torch

from ltx_core.pipeline.components.schedulers import BetaScheduler, LinearQuadraticScheduler, LTX2Scheduler


def test_ltx2_scheduler_basic_properties() -> None:
    scheduler = LTX2Scheduler()

    steps = 4
    latent = torch.zeros(1, 4, 8, 8)  # non-None latent to exercise token-based shift

    sigmas = scheduler.execute(steps=steps, latent=latent)

    # We expect `steps + 1` sigma values.
    assert isinstance(sigmas, torch.Tensor)
    assert sigmas.shape == (steps + 1,)

    # All sigmas should be in [0, 1] and non-negative.
    assert torch.all(sigmas >= 0.0)
    assert torch.all(sigmas <= 1.0)


def test_linear_quadratic_scheduler_basic_properties() -> None:
    scheduler = LinearQuadraticScheduler()

    steps = 5
    sigmas = scheduler.execute(steps=steps)
    fixture = torch.Tensor([1.0000, 0.9875, 0.9750, 0.8583, 0.5333, 0.0000])
    assert isinstance(sigmas, torch.Tensor)
    assert sigmas.shape == (steps + 1,)
    assert torch.allclose(sigmas, fixture, atol=1e-4, rtol=1e-5)


def test_beta_scheduler_basic_properties() -> None:
    scheduler = BetaScheduler()

    steps = 5
    sigmas = scheduler.execute(steps=steps, alpha=0.5, beta=0.7)
    fixture = torch.Tensor([1.0000, 0.9758, 0.9144, 0.7701, 0.4146, 0.0000])
    assert isinstance(sigmas, torch.Tensor)
    assert sigmas.shape == (steps + 1,)
    assert torch.allclose(sigmas, fixture, atol=1e-4, rtol=1e-5)
