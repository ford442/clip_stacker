# Copyright (c) 2025 Lightricks. All rights reserved.
# Created by Amit Pintz.

from typing import NamedTuple, Protocol, Tuple

import torch


class VideoPixelShape(NamedTuple):
    """
    Shape of the tensor representing the video pixel array. Assumes BGR channel format.
    """

    batch: int
    frames: int
    height: int
    width: int
    fps: float


class SpatioTemporalScaleFactors(NamedTuple):
    """
    Describes the spatiotemporal downscaling between decoded video space and
    the corresponding VAE latent grid.
    """

    time: int
    width: int
    height: int


class VideoLatentShape(NamedTuple):
    batch: int
    channels: int
    frames: int
    height: int
    width: int

    def to_torch_shape(self) -> torch.Size:
        return torch.Size([self.batch, self.channels, self.frames, self.height, self.width])

    @staticmethod
    def from_torch_shape(shape: torch.Size) -> "VideoLatentShape":
        return VideoLatentShape(
            batch=shape[0],
            channels=shape[1],
            frames=shape[2],
            height=shape[3],
            width=shape[4],
        )

    def mask_shape(self) -> "VideoLatentShape":
        return self._replace(channels=1)

    @staticmethod
    def from_pixel_shape(
        shape: VideoPixelShape,
        latent_channels: int = 128,
        scale_factors: tuple[int, int, int] = (8, 32, 32),
    ) -> "VideoLatentShape":
        frames = (shape.frames - 1) // scale_factors[0] + 1
        height = shape.height // scale_factors[1]
        width = shape.width // scale_factors[2]

        return VideoLatentShape(
            batch=shape.batch,
            channels=latent_channels,
            frames=frames,
            height=height,
            width=width,
        )

    def upscale(self, scale_factors: SpatioTemporalScaleFactors = (8, 32, 32)) -> "VideoLatentShape":
        return self._replace(
            channels=3,
            frames=(self.frames - 1) * scale_factors.time + 1,
            height=self.height * scale_factors.height,
            width=self.width * scale_factors.width,
        )


class AudioLatentShape(NamedTuple):
    batch: int
    channels: int
    frames: int
    mel_bins: int

    def to_torch_shape(self) -> torch.Size:
        return torch.Size([self.batch, self.channels, self.frames, self.mel_bins])

    def mask_shape(self) -> "AudioLatentShape":
        return self._replace(channels=1, mel_bins=1)

    @staticmethod
    def from_torch_shape(shape: torch.Size) -> "AudioLatentShape":
        return AudioLatentShape(
            batch=shape[0],
            channels=shape[1],
            frames=shape[2],
            mel_bins=shape[3],
        )

    @staticmethod
    def from_duration(
        batch: int,
        duration: float,
        channels: int = 8,
        mel_bins: int = 16,
        sample_rate: int = 16000,
        hop_length: int = 160,
        audio_latent_downsample_factor: int = 4,
    ) -> "AudioLatentShape":
        latents_per_second = float(sample_rate) / float(hop_length) / float(audio_latent_downsample_factor)

        return AudioLatentShape(
            batch=batch,
            channels=channels,
            frames=round(duration * latents_per_second),
            mel_bins=mel_bins,
        )

    @staticmethod
    def from_video_pixel_shape(
        shape: VideoPixelShape,
        channels: int = 8,
        mel_bins: int = 16,
        sample_rate: int = 16000,
        hop_length: int = 160,
        audio_latent_downsample_factor: int = 4,
    ) -> "AudioLatentShape":
        return AudioLatentShape.from_duration(
            batch=shape.batch,
            duration=float(shape.frames) / float(shape.fps),
            channels=channels,
            mel_bins=mel_bins,
            sample_rate=sample_rate,
            hop_length=hop_length,
            audio_latent_downsample_factor=audio_latent_downsample_factor,
        )


class Patchifier(Protocol):
    """
    Protocol for patchifiers that convert latent tensors into patches and assemble them back.
    """

    def patchify(
        self,
        latents: torch.Tensor,
    ) -> torch.Tensor:
        ...
        """
        Convert latent tensors into flattened patch tokens.

        Args:
            latents: Latent tensor to patchify.

        Returns:
            Flattened patch tokens tensor.
        """

    def unpatchify(
        self,
        latents: torch.Tensor,
        output_shape: AudioLatentShape | VideoLatentShape,
    ) -> torch.Tensor:
        """
        Converts latent tensors between spatio-temporal formats and flattened sequence representations.

        Args:
            latents: Patch tokens that must be rearranged back into the latent grid constructed by `patchify`.
            output_shape: Shape of the output tensor. Note that output_shape is either AudioLatentShape or
            VideoLatentShape.

        Returns:
            Dense latent tensor restored from the flattened representation.
        """

    @property
    def patch_size(self) -> Tuple[int, int, int]:
        ...
        """
        Returns the patch size as a tuple of (temporal, height, width) dimensions
        """

    def get_patch_grid_bounds(
        self,
        output_shape: AudioLatentShape | VideoLatentShape,
        device: torch.device | None = None,
    ) -> torch.Tensor:
        ...
        """
        Compute metadata describing where each latent patch resides within the
        grid specified by `output_shape`.

        Args:
            output_shape: Target grid layout for the patches.
            device: Target device for the returned tensor.

        Returns:
            Tensor containing patch coordinate metadata such as spatial or temporal intervals.
        """


class SchedulerProtocol(Protocol):
    """
    Protocol for schedulers that provide a sigmas schedule tensor for a
    given number of steps. Device is cpu.
    """

    def execute(self, steps: int, **kwargs) -> torch.FloatTensor: ...


class GuiderProtocol(Protocol):
    """
    Protocol for guiders that compute a delta tensor given conditioning inputs.
    The returned delta should be added to the conditional output (cond), enabling
    multiple guiders to be chained together by accumulating their deltas.
    """

    scale: float

    def delta(self, cond: torch.Tensor, uncond: torch.Tensor) -> torch.Tensor: ...

    def enabled(self) -> bool:
        """
        Returns whether the corresponding perturbation is enabled. E.g. for CFG, this should return False if the scale
        is 1.0.
        """
        ...


class DiffusionStepProtocol(Protocol):
    """
    Protocol for diffusion steps that provide a next sample tensor for a given current sample tensor,
    current denoised sample tensor, and sigmas tensor.
    """

    def step(
        self, sample: torch.Tensor, denoised_sample: torch.Tensor, sigmas: torch.Tensor, step_index: int
    ) -> torch.Tensor: ...
