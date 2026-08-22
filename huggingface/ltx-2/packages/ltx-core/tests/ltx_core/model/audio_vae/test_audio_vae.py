import pytest
import torch
from tests.ltx_core.utils import resolve_model_path

from ltx_core.loader.single_gpu_model_builder import SingleGPUModelBuilder as Builder
from ltx_core.model.audio_vae.model_configurator import (
    AUDIO_VAE_DECODER_COMFY_KEYS_FILTER,
    AUDIO_VAE_ENCODER_COMFY_KEYS_FILTER,
    VOCODER_COMFY_KEYS_FILTER,
    VAEDecoderConfigurator,
    VAEEncoderConfigurator,
    VocoderConfigurator,
)
from ltx_core.model.audio_vae.ops import AudioProcessor


@pytest.fixture(scope="module")
def model_path() -> str:
    return resolve_model_path()


@pytest.fixture(scope="module")
def encoder_builder(model_path: str) -> Builder:
    return Builder(
        model_path=model_path,
        model_class_configurator=VAEEncoderConfigurator,
        model_sd_ops=AUDIO_VAE_ENCODER_COMFY_KEYS_FILTER,
    )


@pytest.fixture(scope="module")
def decoder_builder(model_path: str) -> Builder:
    return Builder(
        model_path=model_path,
        model_class_configurator=VAEDecoderConfigurator,
        model_sd_ops=AUDIO_VAE_DECODER_COMFY_KEYS_FILTER,
    )


@pytest.fixture(scope="module")
def vocoder_builder(model_path: str) -> Builder:
    return Builder(
        model_path=model_path,
        model_class_configurator=VocoderConfigurator,
        model_sd_ops=VOCODER_COMFY_KEYS_FILTER,
    )


def test_audio_vae_decoder_instantiation(decoder_builder: Builder) -> None:
    vae_decoder = decoder_builder.build()
    assert vae_decoder is not None
    assert not any(param.device.type == "meta" for param in vae_decoder.parameters())


def generate_test_waveform(
    duration_seconds: float,
    sample_rate: int,
    num_channels: int = 2,
    frequency: float = 440.0,
) -> torch.Tensor:
    """Generate a multi-channel sine wave test signal."""
    num_samples = int(duration_seconds * sample_rate)
    t = torch.linspace(0, duration_seconds, num_samples)

    # Generate slightly different frequencies for left/right channels
    waveform = torch.stack(
        [torch.sin(2 * torch.pi * (frequency + i * 10) * t) for i in range(num_channels)],
        dim=0,
    )
    # Add batch dimension: (channels, time) -> (batch, channels, time)
    return waveform.unsqueeze(0) * 0.5  # Scale to avoid clipping


def test_spectrogram_reconstruction_quality(encoder_builder: Builder, decoder_builder: Builder) -> None:
    """Test that input and output spectrograms are similar after VAE encode/decode."""
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Load encoder and decoder
    encoder = encoder_builder.build()
    decoder = decoder_builder.build()

    encoder = encoder.to(device).eval()
    decoder = decoder.to(device).eval()

    # Pipeline parameters
    sample_rate = encoder.sample_rate
    n_mels = encoder.mel_bins
    hop_length = encoder.mel_hop_length
    n_fft = encoder.n_fft

    # Generate test waveform
    input_waveform = generate_test_waveform(
        duration_seconds=1.0,
        sample_rate=sample_rate,
        num_channels=2,
        frequency=440.0,
    ).to(device)

    # Get model dtype for input conversion
    model_dtype = next(encoder.parameters()).dtype

    with torch.no_grad():
        # Convert to spectrogram
        audio_processor = AudioProcessor(
            sample_rate=sample_rate,
            mel_bins=n_mels,
            mel_hop_length=hop_length,
            n_fft=n_fft,
        ).to(device)

        input_spectrogram = audio_processor.waveform_to_mel(
            input_waveform,
            waveform_sample_rate=sample_rate,
        ).to(dtype=model_dtype)

        # Encode and decode
        latent = encoder(input_spectrogram)
        reconstructed_spectrogram = decoder(latent)

    # Compare spectrograms (allow for some reconstruction loss)
    # Align shapes for comparison (decoder may have slightly different output shape)
    min_time = min(input_spectrogram.shape[2], reconstructed_spectrogram.shape[2])
    min_freq = min(input_spectrogram.shape[3], reconstructed_spectrogram.shape[3])

    input_cropped = input_spectrogram[:, :, :min_time, :min_freq]
    reconstructed_cropped = reconstructed_spectrogram[:, :, :min_time, :min_freq]

    # Calculate reconstruction error
    mse = torch.nn.functional.mse_loss(input_cropped, reconstructed_cropped)
    correlation = torch.corrcoef(torch.stack([input_cropped.flatten(), reconstructed_cropped.flatten()]))[0, 1]

    # Assert reasonable reconstruction quality
    # These thresholds may need adjustment based on model quality
    assert mse < 10.0, f"Spectrogram MSE too high: {mse.item():.4f}"
    assert correlation > 0.5, f"Spectrogram correlation too low: {correlation.item():.4f}"


def test_waveform_roundtrip_similarity(
    encoder_builder: Builder, decoder_builder: Builder, vocoder_builder: Builder
) -> None:
    """
    Test full waveform roundtrip: waveform -> spectrogram -> VAE encode/decode -> vocoder -> waveform.

    Compares input and output waveforms, as well as their spectrograms.
    """
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Load models
    encoder = encoder_builder.build()
    decoder = decoder_builder.build()
    vocoder = vocoder_builder.build()

    encoder = encoder.to(device).eval()
    decoder = decoder.to(device).eval()
    vocoder = vocoder.to(device).eval()

    # Pipeline parameters
    input_sample_rate = encoder.sample_rate  # 16kHz
    output_sample_rate = vocoder.output_sample_rate  # 24kHz
    n_mels = encoder.mel_bins
    hop_length = encoder.mel_hop_length
    n_fft = encoder.n_fft

    # Generate test waveform (stereo, 1 second)
    duration = 1.0
    input_waveform = generate_test_waveform(
        duration_seconds=duration,
        sample_rate=input_sample_rate,
        num_channels=2,
        frequency=440.0,
    ).to(device)

    # Get model dtype for input conversion
    model_dtype = next(encoder.parameters()).dtype

    with torch.no_grad():
        audio_processor = AudioProcessor(
            sample_rate=input_sample_rate,
            mel_bins=n_mels,
            mel_hop_length=hop_length,
            n_fft=n_fft,
        ).to(device)

        input_spectrogram = audio_processor.waveform_to_mel(
            input_waveform,
            waveform_sample_rate=input_sample_rate,
        ).to(dtype=model_dtype)

        latent = encoder(input_spectrogram)
        reconstructed_spectrogram = decoder(latent)

        output_waveform = vocoder(reconstructed_spectrogram)

        output_waveform_resampled = audio_processor.resample_waveform(
            output_waveform,
            source_rate=output_sample_rate,
            target_rate=input_sample_rate,
        )

        output_spectrogram = audio_processor.waveform_to_mel(
            output_waveform_resampled,
            waveform_sample_rate=input_sample_rate,
        )

    # Waveform comparison
    # Align waveform lengths for comparison
    min_samples = min(input_waveform.shape[2], output_waveform_resampled.shape[2])
    input_waveform_aligned = input_waveform[:, :, :min_samples]
    output_waveform_aligned = output_waveform_resampled[:, :, :min_samples]

    # Calculate waveform correlation (more meaningful than MSE for audio)
    waveform_correlation = torch.corrcoef(
        torch.stack([input_waveform_aligned.flatten(), output_waveform_aligned.flatten()])
    )[0, 1]

    # Spectrogram comparison
    # Align spectrogram shapes for comparison
    min_time = min(input_spectrogram.shape[2], output_spectrogram.shape[2])
    min_freq = min(input_spectrogram.shape[3], output_spectrogram.shape[3])

    input_spec_aligned = input_spectrogram[:, :, :min_time, :min_freq]
    output_spec_aligned = output_spectrogram[:, :, :min_time, :min_freq]

    spectrogram_mse = torch.nn.functional.mse_loss(input_spec_aligned, output_spec_aligned)
    spectrogram_correlation = torch.corrcoef(
        torch.stack([input_spec_aligned.flatten(), output_spec_aligned.flatten()])
    )[0, 1]

    # Assertions
    # Waveform correlation can be low since VAE+vocoder don't preserve phase.
    # A low but positive correlation is acceptable.
    assert waveform_correlation > 0.0, (
        f"Waveform correlation is negative: {waveform_correlation.item():.4f}. "
        "Input and output waveforms should have at least positive correlation."
    )

    # Spectrograms should be well correlated
    assert spectrogram_correlation > 0.5, (
        f"Spectrogram correlation too low: {spectrogram_correlation.item():.4f}. "
        "Input and output spectrograms are not similar enough."
    )

    # Spectrogram MSE should be reasonable
    assert spectrogram_mse < 10.0, (
        f"Spectrogram MSE too high: {spectrogram_mse.item():.4f}. Reconstruction quality is poor."
    )

    # Output waveform should be in valid range
    assert output_waveform_resampled.min() >= -1.0, f"Output waveform min {output_waveform_resampled.min()} below -1.0"
    assert output_waveform_resampled.max() <= 1.0, f"Output waveform max {output_waveform_resampled.max()} above 1.0"
