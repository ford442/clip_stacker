import logging
from collections.abc import Generator

import torch

from ltx_core.model.video_vae.video_vae import Decoder


def compute_chunk_boundaries(
    chunk_start: int,
    temporal_tile_length: int,
    temporal_overlap: int,
    total_latent_frames: int,
) -> tuple[int, int]:
    """Compute chunk boundaries for temporal tiling.

    Args:
        chunk_start: Starting frame index for the current chunk
        temporal_tile_length: Length of each temporal tile
        temporal_overlap: Number of frames to overlap between chunks
        total_latent_frames: Total number of latent frames

    Returns:
        Tuple of (overlap_start, chunk_end)
    """
    if chunk_start == 0:
        # First chunk: no overlap needed
        chunk_end = min(chunk_start + temporal_tile_length, total_latent_frames)
        overlap_start = chunk_start
    else:
        # Subsequent chunks: include overlap from previous chunk
        # -1 because we need one extra frame to overlap, which is decoded to a single frame
        # never overlap with the first latent frame
        overlap_start = max(1, chunk_start - temporal_overlap - 1)
        extra_frames = chunk_start - overlap_start
        chunk_end = min(
            chunk_start + temporal_tile_length - extra_frames,
            total_latent_frames,
        )

    return overlap_start, chunk_end


def spatial_decode(  # noqa
    decoder: Decoder,
    samples: torch.Tensor,
    horizontal_tiles: int,
    vertical_tiles: int,
    overlap: int,
    last_frame_fix: bool,
    scale_factors: tuple[float, float, float],
    timestep: float,
    generator: torch.Generator,
) -> torch.Tensor:
    if last_frame_fix:
        # Repeat the last frame along dimension 2 (frames)
        # samples shape - [batch, channels, frames, height, width]
        last_frame = samples[:, :, -1:, :, :]
        samples = torch.cat([samples, last_frame], dim=2)

    batch, _, frames, height, width = samples.shape
    time_scale_factor, width_scale_factor, height_scale_factor = scale_factors
    image_frames = 1 + (frames - 1) * time_scale_factor

    # Calculate output image dimensions
    output_height = height * height_scale_factor
    output_width = width * width_scale_factor

    # Calculate tile sizes with overlap
    base_tile_height = (height + (vertical_tiles - 1) * overlap) // vertical_tiles
    base_tile_width = (width + (horizontal_tiles - 1) * overlap) // horizontal_tiles

    # Initialize output tensor and weight tensor
    # VAE decode returns images in format [batch, height, width, channels]
    output = None
    weights = None

    target_device = samples.device
    target_dtype = samples.dtype

    output = torch.zeros(
        (
            batch,
            3,
            image_frames,
            output_height,
            output_width,
        ),
        device=target_device,
        dtype=target_dtype,
    )
    weights = torch.zeros(
        (batch, 1, image_frames, output_height, output_width),
        device=target_device,
        dtype=target_dtype,
    )

    # Process each tile
    for v in range(vertical_tiles):
        for h in range(horizontal_tiles):
            # Calculate tile boundaries
            h_start = h * (base_tile_width - overlap)
            v_start = v * (base_tile_height - overlap)

            # Adjust end positions for edge tiles
            h_end = min(h_start + base_tile_width, width) if h < horizontal_tiles - 1 else width
            v_end = min(v_start + base_tile_height, height) if v < vertical_tiles - 1 else height

            # Calculate actual tile dimensions
            tile_height = v_end - v_start
            tile_width = h_end - h_start

            logging.info(f"Processing VAE decode tile at row {v}, col {h}:")
            logging.info(f"  Position: ({v_start}:{v_end}, {h_start}:{h_end})")
            logging.info(f"  Size: {tile_height}x{tile_width}")

            # Extract tile
            tile = samples[:, :, :, v_start:v_end, h_start:h_end]

            # Decode the tile
            decoded_tile = decoder.decode(tile, timestep, generator)

            # Calculate output tile boundaries
            out_h_start = v_start * height_scale_factor
            out_h_end = v_end * height_scale_factor
            out_w_start = h_start * width_scale_factor
            out_w_end = h_end * width_scale_factor

            # Create weight mask for this tile
            tile_out_height = out_h_end - out_h_start
            tile_out_width = out_w_end - out_w_start
            tile_weights = torch.ones(
                (batch, 1, image_frames, tile_out_height, tile_out_width),
                device=decoded_tile.device,
                dtype=decoded_tile.dtype,
            )

            # Calculate overlap regions in output space
            overlap_out_h = overlap * height_scale_factor
            overlap_out_w = overlap * width_scale_factor

            # Apply horizontal blending weights
            if h > 0:  # Left overlap
                h_blend = torch.linspace(0, 1, overlap_out_w, device=decoded_tile.device)
                tile_weights[:, :, :, :, :overlap_out_w] *= h_blend
            if h < horizontal_tiles - 1:  # Right overlap
                h_blend = torch.linspace(1, 0, overlap_out_w, device=decoded_tile.device)
                tile_weights[:, :, :, :, -overlap_out_w:] *= h_blend

            # Apply vertical blending weights
            if v > 0:  # Top overlap
                v_blend = torch.linspace(0, 1, overlap_out_h, device=decoded_tile.device)
                tile_weights[:, :, :, :overlap_out_h, :] *= v_blend.view(1, 1, 1, -1, 1)
            if v < vertical_tiles - 1:  # Bottom overlap
                v_blend = torch.linspace(1, 0, overlap_out_h, device=decoded_tile.device)
                tile_weights[:, :, :, -overlap_out_h:, :] *= v_blend.view(1, 1, 1, -1, 1)

            # Add weighted tile to output
            output[:, :, :, out_h_start:out_h_end, out_w_start:out_w_end] += (decoded_tile * tile_weights).to(
                target_device, target_dtype
            )

            # Add weights to weight tensor
            weights[:, :, :, out_h_start:out_h_end, out_w_start:out_w_end] += tile_weights.to(
                target_device, target_dtype
            )

    # Normalize by weights
    output /= weights + 1e-8
    # LT_INTERNAL: changed from output[:-time_scale_factor, :, :]!
    if last_frame_fix:
        output = output[:, :, :-time_scale_factor, :, :]

    return output


def decode_spatial_temporal(
    decoder: Decoder,
    samples: torch.ensor,
    timestep: float,
    generator: torch.Generator,
    scale_factors: tuple[float, float, float],
    spatial_tiles: int = 4,
    spatial_overlap: int = 1,
    temporal_tile_length: int = 16,
    temporal_overlap: int = 1,
    last_frame_fix: bool = False,
) -> Generator[torch.Tensor, None, None]:
    if temporal_tile_length < temporal_overlap + 1:
        raise ValueError("Temporal tile length must be greater than temporal overlap + 1")

    _, _, frames, _, _ = samples.shape
    time_scale_factor, _, _ = scale_factors

    # Process temporal chunks similar to reference function
    total_latent_frames = frames
    chunk_start = 0

    previous_tile = None
    while chunk_start < total_latent_frames:
        # Calculate chunk boundaries
        overlap_start, chunk_end = compute_chunk_boundaries(
            chunk_start, temporal_tile_length, temporal_overlap, total_latent_frames
        )

        # units are latent frames
        chunk_frames = chunk_end - overlap_start
        logging.info(f"Processing temporal chunk: {overlap_start}:{chunk_end} ({chunk_frames} latent frames)")

        # Extract tile
        tile = samples[:, :, overlap_start:chunk_end]

        # Decode the tile
        decoded_tile = spatial_decode(
            decoder,
            tile,
            spatial_tiles,
            spatial_tiles,
            spatial_overlap,
            last_frame_fix,
            scale_factors,
            timestep,
            generator,
        )

        if previous_tile is None:
            previous_tile = decoded_tile
        else:
            # Drop first frame if needed (overlap)
            if decoded_tile.shape[2] == 1:
                raise ValueError("Dropping first frame but tile has only 1 frame")
            decoded_tile = decoded_tile[:, :, 1:]  # Drop first frame

            # Create weight mask for this tile
            # -1 is for dropped frame above
            overlap_frames = temporal_overlap * time_scale_factor
            frame_weights = torch.linspace(
                0,
                1,
                overlap_frames + 2,
                device=decoded_tile.device,
                dtype=decoded_tile.dtype,
            )[1:-1]
            tile_weights = frame_weights.view(1, 1, -1, 1, 1)

            previous_tile[:, :, -overlap_frames:] = (
                previous_tile[:, :, -overlap_frames:] * (1 - tile_weights)
                + decoded_tile[:, :, :overlap_frames] * tile_weights
            )
            resulting_tile = previous_tile[:, :, :-overlap_frames]
            decoded_tile[:, :, :overlap_frames] = previous_tile[:, :, -overlap_frames:]
            yield resulting_tile
            previous_tile = decoded_tile

        # Move to next chunk
        chunk_start = chunk_end

    yield decoded_tile
