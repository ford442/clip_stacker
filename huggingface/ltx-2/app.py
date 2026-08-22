import os
import sys
from pathlib import Path

# ZeroGPU sometimes sets ZEROGPU_PROC_SELF_CGROUP_PATH=/etc/host-cgroup but the
# mount is missing; fall back before `spaces` reads Config.
_cgroup_path = os.environ.get('ZEROGPU_PROC_SELF_CGROUP_PATH', '/proc/self/cgroup')
if _cgroup_path == '/etc/host-cgroup' and not Path(_cgroup_path).exists():
    os.environ['ZEROGPU_PROC_SELF_CGROUP_PATH'] = '/proc/self/cgroup'

# Add packages to Python path
current_dir = Path(__file__).parent
sys.path.insert(0, str(current_dir / "packages" / "ltx-pipelines" / "src"))
sys.path.insert(0, str(current_dir / "packages" / "ltx-core" / "src"))
import numpy as np
import random
import spaces
import gradio as gr
from gradio_client import Client, handle_file
import torch
from typing import Any, Optional
from huggingface_hub import hf_hub_download
from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
from ltx_core.tiling import TilingConfig
from ltx_pipelines.constants import (
    DEFAULT_SEED,
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    DEFAULT_NUM_FRAMES,
    DEFAULT_FRAME_RATE,
    DEFAULT_NUM_INFERENCE_STEPS,
    DEFAULT_CFG_GUIDANCE_SCALE,
    DEFAULT_LORA_STRENGTH,
)

MAX_SEED = np.iinfo(np.int32).max
# Custom negative prompt
DEFAULT_NEGATIVE_PROMPT = "shaky, glitchy, low quality, worst quality, deformed, distorted, disfigured, motion smear, motion artifacts, fused fingers, bad anatomy, weird hand, ugly, transition, static"

# Default prompt from docstring example
DEFAULT_PROMPT = "An astronaut hatches from a fragile egg on the surface of the Moon, the shell cracking and peeling apart in gentle low-gravity motion. Fine lunar dust lifts and drifts outward with each movement, floating in slow arcs before settling back onto the ground. The astronaut pushes free in a deliberate, weightless motion, small fragments of the egg tumbling and spinning through the air. In the background, the deep darkness of space subtly shifts as stars glide with the camera's movement, emphasizing vast depth and scale. The camera performs a smooth, cinematic slow push-in, with natural parallax between the foreground dust, the astronaut, and the distant starfield. Ultra-realistic detail, physically accurate low-gravity motion, cinematic lighting, and a breath-taking, movie-like shot."

# HuggingFace Hub defaults
DEFAULT_REPO_ID = "Lightricks/LTX-2"
DEFAULT_CHECKPOINT_FILENAME = "ltx-2-19b-dev-fp8.safetensors"
DEFAULT_DISTILLED_LORA_FILENAME = "ltx-2-19b-distilled-lora-384.safetensors"
DEFAULT_SPATIAL_UPSAMPLER_FILENAME = "ltx-2-spatial-upscaler-x2-1.0.safetensors"

# Text encoder space URL
TEXT_ENCODER_SPACE = "linoyts/gemma-text-encoder"

def get_hub_or_local_checkpoint(repo_id: Optional[str] = None, filename: Optional[str] = None):
    """Download from HuggingFace Hub or use local checkpoint."""
    if repo_id is None and filename is None:
        raise ValueError("Please supply at least one of `repo_id` or `filename`")

    if repo_id is not None:
        if filename is None:
            raise ValueError("If repo_id is specified, filename must also be specified.")
        print(f"Downloading {filename} from {repo_id}...")
        ckpt_path = hf_hub_download(repo_id=repo_id, filename=filename)
        print(f"Downloaded to {ckpt_path}")
    else:
        ckpt_path = filename

    return ckpt_path


# Initialize pipeline at startup
print("=" * 80)
print("Loading LTX-2 2-stage pipeline...")
print("=" * 80)

checkpoint_path = get_hub_or_local_checkpoint(DEFAULT_REPO_ID, DEFAULT_CHECKPOINT_FILENAME)
distilled_lora_path = get_hub_or_local_checkpoint(DEFAULT_REPO_ID, DEFAULT_DISTILLED_LORA_FILENAME)
spatial_upsampler_path = get_hub_or_local_checkpoint(DEFAULT_REPO_ID, DEFAULT_SPATIAL_UPSAMPLER_FILENAME)

print(f"Initializing pipeline with:")
print(f"  checkpoint_path={checkpoint_path}")
print(f"  distilled_lora_path={distilled_lora_path}")
print(f"  spatial_upsampler_path={spatial_upsampler_path}")
print(f"  text_encoder_space={TEXT_ENCODER_SPACE} (connected on first generate)")

# Initialize pipeline WITHOUT text encoder (gemma_root=None)
# Text encoding will be done by external space
pipeline = TI2VidTwoStagesPipeline(
    checkpoint_path=checkpoint_path,
    distilled_lora_path=distilled_lora_path,
    distilled_lora_strength=DEFAULT_LORA_STRENGTH,
    spatial_upsampler_path=spatial_upsampler_path,
    gemma_root=None,
    loras=[],
    fp8transformer=False,
    local_files_only=False
)

def _local_path_from_client_file(value: Any) -> Optional[str]:
    """gradio_client may return a path string, a FileData dict, or None."""
    if value is None:
        return None
    if isinstance(value, (str, Path)):
        return str(value)
    if isinstance(value, dict):
        for key in ("path", "name"):
            candidate = value.get(key)
            if candidate:
                return str(candidate)
    return None


def fetch_prompt_embeddings(
    prompt: str,
    enhance_prompt: bool,
    image_path: Optional[Path],
    seed: int,
    negative_prompt: str,
):
    """Call the Gemma encoder Space on CPU. Recreate the client each time so we
    do not reuse an asyncio loop that Gradio Client already closed at import."""
    print(f"Encoding prompt: {prompt}")
    print(f"Connecting to text encoder space: {TEXT_ENCODER_SPACE}")
    try:
        client = Client(TEXT_ENCODER_SPACE, download_files=True)
    except Exception as e:
        raise RuntimeError(
            f"Could not connect to {TEXT_ENCODER_SPACE}: {e}. "
            "That Space must be Running (ZeroGPU) for LTX-2 to encode prompts."
        ) from e

    image_input = handle_file(str(image_path)) if image_path is not None else None
    result = client.predict(
        prompt=prompt,
        enhance_prompt=enhance_prompt,
        input_image=image_input,
        seed=seed,
        negative_prompt=negative_prompt,
        api_name="/encode_prompt",
    )
    embedding_path = _local_path_from_client_file(result[0] if result else None)
    encoder_status = result[2] if result and len(result) > 2 else None
    print(f"Embeddings received from: {embedding_path}")
    if encoder_status:
        print(f"Text encoder status: {encoder_status}")

    if not embedding_path:
        detail = encoder_status or "text encoder returned no embedding file"
        raise RuntimeError(
            f"Text encoder space did not return embeddings ({detail}). "
            f"Check logs on {TEXT_ENCODER_SPACE}."
        )

    embeddings = torch.load(embedding_path, map_location="cpu", weights_only=False)
    video_context_positive = embeddings["video_context"]
    audio_context_positive = embeddings["audio_context"]
    video_context_negative = embeddings.get("video_context_negative")
    audio_context_negative = embeddings.get("audio_context_negative")
    if video_context_positive is None or audio_context_positive is None:
        raise RuntimeError("Encoder returned incomplete positive embeddings.")
    # Two-stage pipeline falls back to local Gemma if any negative tensor is
    # missing — that path cannot run with gemma_root=None.
    if video_context_negative is None or audio_context_negative is None:
        raise RuntimeError(
            "Encoder did not return negative-prompt embeddings. "
            "Pass a non-empty negative prompt so /encode_prompt includes them."
        )
    print("✓ Embeddings loaded successfully")
    return (
        video_context_positive,
        audio_context_positive,
        video_context_negative,
        audio_context_negative,
    )


@spaces.GPU(duration=300)
def run_pipeline_on_gpu(
    prompt: str,
    negative_prompt: str,
    output_path: str,
    current_seed: int,
    height: int,
    width: int,
    num_frames: int,
    frame_rate: float,
    num_inference_steps: int,
    cfg_guidance_scale: float,
    images: list,
    video_context_positive,
    audio_context_positive,
    video_context_negative,
    audio_context_negative,
):
    pipeline(
        prompt=prompt,
        negative_prompt=negative_prompt,
        output_path=output_path,
        seed=current_seed,
        height=height,
        width=width,
        num_frames=num_frames,
        frame_rate=frame_rate,
        num_inference_steps=num_inference_steps,
        cfg_guidance_scale=cfg_guidance_scale,
        images=images,
        tiling_config=TilingConfig.default(),
        video_context_positive=video_context_positive,
        audio_context_positive=audio_context_positive,
        video_context_negative=video_context_negative,
        audio_context_negative=audio_context_negative,
    )
    return str(output_path)


def generate_video(
    input_image,
    prompt: str,
    duration: float,
    enhance_prompt: bool = True,
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
    seed: int = 42,
    randomize_seed: bool = True,
    num_inference_steps: int = 25,
    cfg_guidance_scale: float = DEFAULT_CFG_GUIDANCE_SCALE,
    height: int = DEFAULT_HEIGHT,
    width: int = DEFAULT_WIDTH,
    progress=gr.Progress(track_tqdm=True),
):
    """Encode on CPU via the Gemma Space, then run LTX-2 on ZeroGPU."""
    current_seed = random.randint(0, MAX_SEED) if randomize_seed else int(seed)
    try:
        frame_rate = 24.0
        num_frames = int(duration * frame_rate) + 1

        output_dir = Path("outputs")
        output_dir.mkdir(exist_ok=True)
        output_path = output_dir / f"video_{current_seed}.mp4"

        images = []
        temp_image_path = None
        if input_image is not None:
            temp_image_path = output_dir / f"temp_input_{current_seed}.jpg"
            if hasattr(input_image, "save"):
                input_image.save(temp_image_path)
            else:
                temp_image_path = Path(input_image)
            images = [(str(temp_image_path), 0, 1.0)]

        (
            video_context_positive,
            audio_context_positive,
            video_context_negative,
            audio_context_negative,
        ) = fetch_prompt_embeddings(
            prompt=prompt,
            enhance_prompt=enhance_prompt,
            image_path=temp_image_path,
            seed=current_seed,
            negative_prompt=negative_prompt,
        )

        run_pipeline_on_gpu(
            prompt,
            negative_prompt,
            str(output_path),
            current_seed,
            height,
            width,
            num_frames,
            frame_rate,
            num_inference_steps,
            cfg_guidance_scale,
            images,
            video_context_positive,
            audio_context_positive,
            video_context_negative,
            audio_context_negative,
        )
        return str(output_path), current_seed

    except Exception as e:
        import traceback

        error_msg = f"Error: {str(e)}\n{traceback.format_exc()}"
        print(error_msg)
        gr.Warning(str(e))
        return None, current_seed


# Create Gradio interface
with gr.Blocks(title="LTX-2 Video 🎥🔈") as demo:
    gr.Markdown("# LTX-2 🎥🔈: The First Open Source Audio-Video Model")
    gr.Markdown("State-of-the-art video & audio generation with Lightricks LTX-2 TI2V. Read more: [[model]](https://huggingface.co/Lightricks/LTX-2), [[code]](https://github.com/Lightricks/LTX-2)")
    with gr.Row():
        with gr.Column():
            input_image = gr.Image(
                label="Input Image (Optional)",
                type="pil",
            )

            prompt = gr.Textbox(
                label="Prompt",
                info="for best results - make it as elaborate as possible",
                value="Make this image come alive with cinematic motion, smooth animation",
                lines=3,
                placeholder="Describe the motion and animation you want..."
            )

            with gr.Row():
                duration = gr.Slider(
                    label="Duration (seconds)",
                    minimum=1.0,
                    maximum=10.0,
                    value=3.0,
                    step=0.1
                )
                enhance_prompt = gr.Checkbox(
                        label="Enhance Prompt",
                        value=True
                    )

            generate_btn = gr.Button("Generate Video", variant="primary")

            with gr.Accordion("Advanced Settings", open=False):
                negative_prompt = gr.Textbox(
                    label="Negative Prompt",
                    value=DEFAULT_NEGATIVE_PROMPT,
                    lines=2
                )

                seed = gr.Slider(
                    label="Seed",
                    minimum=0,
                    maximum=MAX_SEED,
                    value=DEFAULT_SEED,
                    step=1
                )

                randomize_seed = gr.Checkbox(
                    label="Randomize Seed",
                    value=True
                )

                num_inference_steps = gr.Slider(
                    label="Inference Steps",
                    minimum=1,
                    maximum=100,
                    value=25,
                    step=1
                )

                cfg_guidance_scale = gr.Slider(
                    label="CFG Guidance Scale",
                    minimum=1.0,
                    maximum=10.0,
                    value=DEFAULT_CFG_GUIDANCE_SCALE,
                    step=0.1
                )

                with gr.Row():
                    width = gr.Number(
                        label="Width",
                        value=DEFAULT_WIDTH,
                        precision=0
                    )
                    height = gr.Number(
                        label="Height",
                        value=DEFAULT_HEIGHT,
                        precision=0
                    )

        with gr.Column():
            output_video = gr.Video(label="Generated Video", autoplay=True)

    generate_btn.click(
        fn=generate_video,
        inputs=[
            input_image,
            prompt,
            duration,
            enhance_prompt,
            negative_prompt,
            seed,
            randomize_seed,
            num_inference_steps,
            cfg_guidance_scale,
            height,
            width,
        ],
        outputs=[output_video, seed],
        api_name="generate_video",
    )

    # Add example
    gr.Examples(
        examples=[
            [
                "kill_bill.jpeg",
                "A low, subsonic drone pulses as Uma Thurman's character, Beatrix Kiddo, holds her razor-sharp katana blade steady in the cinematic lighting. A faint electrical hum fills the silence. Suddenly, accompanied by a deep metallic groan, the polished steel begins to soften and distort, like heated metal starting to lose its structural integrity. Discordant strings swell as the blade's perfect edge slowly warps and droops, molten steel beginning to flow downward in silvery rivulets while maintaining its metallic sheen—each drip producing a wet, viscous stretching sound. The transformation starts subtly at first—a slight bend in the blade—then accelerates as the metal becomes increasingly fluid, the groaning intensifying. The camera holds steady on her face as her piercing eyes gradually narrow, not with lethal focus, but with confusion and growing alarm as she watches her weapon dissolve before her eyes. She whispers under her breath, voice flat with disbelief: 'Wait, what?' Her heartbeat rises in the mix—thump... thump-thump—as her breathing quickens slightly while she witnesses this impossible transformation. Sharp violin stabs punctuate each breath. The melting intensifies, the katana's perfect form becoming increasingly abstract, dripping like liquid mercury from her grip. Molten droplets fall to the ground with soft, bell-like pings. Unintelligible whispers fade in and out as her expression shifts from calm readiness to bewilderment and concern, her heartbeat now pounding like a war drum, as her legendary instrument of vengeance literally liquefies in her hands, leaving her defenseless and disoriented. All sound cuts to silence—then a single devastating bass drop as the final droplet falls, leaving only her unsteady breathing in the dark.",
                5.0,
            ],
            [
                "wednesday.png",
                "A cinematic close-up of Wednesday Addams frozen mid-dance on a dark, blue-lit ballroom floor as students move indistinctly behind her, their footsteps and muffled music reduced to a distant, underwater thrum; the audio foregrounds her steady breathing and the faint rustle of fabric as she slowly raises one arm, never breaking eye contact with the camera, then after a deliberately long silence she speaks in a flat, dry, perfectly controlled voice, “I don’t dance… I vibe code,” each word crisp and unemotional, followed by an abrupt cutoff of her voice as the background sound swells slightly, reinforcing the deadpan humor, with precise lip sync, minimal facial movement, stark gothic lighting, and cinematic realism.",
                5.0,
            ],
            [
                "astronaut.jpg",
                "An astronaut hatches from a fragile egg on the surface of the Moon, the shell cracking and peeling apart in gentle low-gravity motion. Fine lunar dust lifts and drifts outward with each movement, floating in slow arcs before settling back onto the ground. The astronaut pushes free in a deliberate, weightless motion, small fragments of the egg tumbling and spinning through the air. In the background, the deep darkness of space subtly shifts as stars glide with the camera's movement, emphasizing vast depth and scale. The camera performs a smooth, cinematic slow push-in, with natural parallax between the foreground dust, the astronaut, and the distant starfield. Ultra-realistic detail, physically accurate low-gravity motion, cinematic lighting, and a breath-taking, movie-like shot.",
                3.0,
            ]
        ],
        fn=generate_video,
        inputs=[input_image, prompt, duration],
        outputs=[output_video, seed],
        label="Example",
        cache_examples=False,
    )

css = '''
.gradio-container .contain{max-width: 1200px !important; margin: 0 auto !important}
'''
if __name__ == "__main__":
    # Gradio 6 enables experimental SSR by default; Hugging Face and old
    # clients still POST /api/predict, which SSR rejects with HTTP 405
    # ("No form actions exist for this page").
    demo.queue().launch(ssr_mode=False, theme=gr.themes.Citrus())