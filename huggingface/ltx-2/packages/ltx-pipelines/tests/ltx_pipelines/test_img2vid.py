from dataclasses import replace
from typing import Callable

import pytest
import torch
from tests.conftest import ASSETS_DIR, CHECKPOINTS_DIR, GEMMA_ROOT

from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
from ltx_core.model.model_ledger import ModelLedger
from ltx_core.pipeline.components.diffusion_steps import EulerDiffusionStep
from ltx_core.pipeline.components.guiders import CFGGuider
from ltx_core.pipeline.components.protocols import AudioLatentShape, VideoLatentShape
from ltx_core.pipeline.conditioning.tools import AudioLatentTools, LatentState, VideoLatentTools
from ltx_pipelines.constants import AUDIO_SAMPLE_RATE, DEFAULT_FRAME_RATE
from ltx_pipelines.media_io import encode_video
from ltx_pipelines.pipeline_utils import (
    PipelineComponents,
    euler_denoising_loop,
    guider_denoising_func,
)
from ltx_pipelines.pipeline_utils import decode_audio as vae_decode_audio
from ltx_pipelines.pipeline_utils import decode_video as vae_decode_video
from ltx_pipelines.utils import get_device

device = get_device()


class Img2VidTestPipeline:
    def __init__(
        self,
        checkpoint_path: str,
        gemma_root: str,
        loras: list[LoraPathStrengthAndSDOps],
        device: torch.device = device,
    ):
        self.model_ledger = ModelLedger(
            dtype=torch.bfloat16,
            device=device,
            checkpoint_path=checkpoint_path,
            gemma_root_path=gemma_root,
            loras=loras,
        )
        self.pipeline_components = PipelineComponents(
            dtype=torch.bfloat16,
            device=device,
        )

        self.device = device

    @torch.inference_mode()
    def __call__(
        self,
        cfg_guidance_scale: float,
    ) -> None:
        v_context_p = torch.load(ASSETS_DIR / "v_context_p.pt").to(self.device)
        v_context_n = torch.load(ASSETS_DIR / "v_context_n.pt").to(self.device)
        a_context_p = torch.load(ASSETS_DIR / "a_context_p.pt").to(self.device)
        a_context_n = torch.load(ASSETS_DIR / "a_context_n.pt").to(self.device)

        video_clean_state = LatentState(
            latent=torch.load(ASSETS_DIR / "v_latent_image.pt").to(self.device),
            denoise_mask=torch.load(ASSETS_DIR / "v_denoise_mask.pt").to(self.device),
            positions=torch.load(ASSETS_DIR / "video_positions.pt").to(self.device),
            clean_latent=torch.load(ASSETS_DIR / "v_latent_image.pt").to(self.device),
        )
        video_latent_tools = VideoLatentTools(
            patchifier=self.pipeline_components.video_patchifier,
            target_shape=VideoLatentShape.from_torch_shape(video_clean_state.latent.shape),
            fps=25,
        )
        video_clean_state = video_latent_tools.patchify(video_clean_state)

        audio_clean_state = LatentState(
            latent=torch.load(ASSETS_DIR / "a_latent_image.pt").to(self.device),
            denoise_mask=torch.load(ASSETS_DIR / "a_denoise_mask.pt").to(self.device),
            positions=torch.load(ASSETS_DIR / "audio_positions.pt").to(self.device),
            clean_latent=torch.load(ASSETS_DIR / "a_latent_image.pt").to(self.device),
        )
        audio_latent_tools = AudioLatentTools(
            patchifier=self.pipeline_components.audio_patchifier,
            target_shape=AudioLatentShape.from_torch_shape(audio_clean_state.latent.shape),
        )
        audio_clean_state = audio_latent_tools.patchify(audio_clean_state)

        video_state = replace(
            video_clean_state,
            latent=self.pipeline_components.video_patchifier.patchify(torch.load(ASSETS_DIR / "v_noised_latent.pt")).to(
                self.device
            ),
        )
        audio_state = replace(
            audio_clean_state,
            latent=self.pipeline_components.audio_patchifier.patchify(torch.load(ASSETS_DIR / "a_noised_latent.pt")).to(
                self.device
            ),
        )

        sigmas = torch.load(ASSETS_DIR / "sigmas.pt").to(self.device)
        stepper = EulerDiffusionStep()
        cfg_guider = CFGGuider(cfg_guidance_scale)

        video_state, audio_state = euler_denoising_loop(
            sigmas,
            video_state,
            audio_state,
            stepper,
            guider_denoising_func(
                cfg_guider, v_context_p, v_context_n, a_context_p, a_context_n, self.model_ledger.transformer()
            ),
        )

        video_state = video_latent_tools.clear_conditioning(video_state)
        video_state = video_latent_tools.unpatchify(video_state)
        audio_state = audio_latent_tools.clear_conditioning(audio_state)
        audio_state = audio_latent_tools.unpatchify(audio_state)
        decoded_video = vae_decode_video(video_state, self.model_ledger.video_decoder())
        waveform = vae_decode_audio(audio_state, self.model_ledger.audio_decoder(), self.model_ledger.vocoder())

        encode_video(
            video=decoded_video,
            fps=DEFAULT_FRAME_RATE,
            audio=waveform,
            audio_sample_rate=AUDIO_SAMPLE_RATE,
            output_path=ASSETS_DIR / "test_comfy.mp4",
        )


@pytest.mark.e2e
def test_comfy_inputs(
    psnr: Callable[[torch.Tensor, torch.Tensor, float, float], float],
    decode_video_from_file: Callable[[str], tuple[torch.Tensor, torch.Tensor | None]],
) -> None:
    pipeline = Img2VidTestPipeline(
        checkpoint_path=(CHECKPOINTS_DIR / "ltx-av-step-1932500-interleaved-new-vae.safetensors").resolve().as_posix(),
        gemma_root=GEMMA_ROOT.resolve().as_posix(),
        loras=[],
    )

    pipeline(cfg_guidance_scale=3.0)

    decoded_video, waveform = decode_video_from_file(path=ASSETS_DIR / "test_comfy.mp4", device=pipeline.device)
    expected_video, expected_waveform = decode_video_from_file(
        path=ASSETS_DIR / "expected_comfy.mp4", device=pipeline.device
    )

    assert psnr(decoded_video, expected_video, 255.0, 1e-8).item() > 35.0
    assert psnr(waveform[: expected_waveform.shape[0]], expected_waveform[: waveform.shape[0]], 1.0, 1e-8).item() > 20.0
