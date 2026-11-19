import torch

from ltx_pipelines.media_io import resize_and_center_crop


def test_resize_and_center_crop_centers_content_vertical() -> None:
    """Verify content is actually cropped from center."""
    h, w, c = 100, 201, 3
    image = torch.zeros(h, w, c)

    # Paint left third red, center third green, right third blue
    third = w // 3  # 67 pixels per third
    image[:, :third, 0] = 1.0  # Left: red
    image[:, third : 2 * third, 1] = 1.0  # Center: green
    image[:, 2 * third :, 2] = 1.0  # Right: blue

    # Crop to same height but narrower width - should keep center (green) region
    # Source: 100x201, Target: 100x67 (same height, 1/3 width)
    # Scale factor: max(100/100, 67/201) = max(1.0, 0.33) = 1.0
    # After scale: 100x201, crop width from center: (201-67)//2 = 67 pixels from each side
    result = resize_and_center_crop(image, height=100, width=67)

    # Result shape: (1, C, 1, H, W) -> extract the image
    cropped = result[0, :, 0, :, :]  # Shape: (C, H, W)

    # Center of cropped image should be predominantly green (from center third)
    center_h, center_w = cropped.shape[1] // 2, cropped.shape[2] // 2
    center_pixel = cropped[:, center_h, center_w]

    # Green channel should be highest at center (center was green in original)
    assert center_pixel[1] > center_pixel[0], "Center should have more green than red"
    assert center_pixel[1] > center_pixel[2], "Center should have more green than blue"

    # Verify the left and right edges are NOT red/blue (they were cropped away)
    left_edge = cropped[:, center_h, 0]
    right_edge = cropped[:, center_h, -1]

    # Both edges should still be from the green center region, not red/blue edges
    assert left_edge[1] >= left_edge[0], "Left edge should not be from red region"
    assert right_edge[1] >= right_edge[2], "Right edge should not be from blue region"


def test_resize_and_center_crop_centers_content_horizontal() -> None:
    """Verify content is actually cropped from center vertically (horizontal stripes)."""
    h, w, c = 201, 100, 3
    image = torch.zeros(h, w, c)

    # Paint top third red, center third green, bottom third blue
    third = h // 3  # 67 pixels per third
    image[:third, :, 0] = 1.0  # Top: red
    image[third : 2 * third, :, 1] = 1.0  # Center: green
    image[2 * third :, :, 2] = 1.0  # Bottom: blue

    # Crop to same width but shorter height - should keep center (green) region
    # Source: 201x100, Target: 67x100 (1/3 height, same width)
    # Scale factor: max(67/201, 100/100) = max(0.33, 1.0) = 1.0
    # After scale: 201x100, crop height from center: (201-67)//2 = 67 pixels from top/bottom
    result = resize_and_center_crop(image, height=67, width=100)

    # Result shape: (1, C, 1, H, W) -> extract the image
    cropped = result[0, :, 0, :, :]  # Shape: (C, H, W)

    # Center of cropped image should be predominantly green (from center third)
    center_h, center_w = cropped.shape[1] // 2, cropped.shape[2] // 2
    center_pixel = cropped[:, center_h, center_w]

    # Green channel should be highest at center (center was green in original)
    assert center_pixel[1] > center_pixel[0], "Center should have more green than red"
    assert center_pixel[1] > center_pixel[2], "Center should have more green than blue"

    # Verify the top and bottom edges are NOT red/blue (they were cropped away)
    top_edge = cropped[:, 0, center_w]
    bottom_edge = cropped[:, -1, center_w]

    # Both edges should still be from the green center region, not red/blue edges
    assert top_edge[1] >= top_edge[0], "Top edge should not be from red region"
    assert bottom_edge[1] >= bottom_edge[2], "Bottom edge should not be from blue region"
