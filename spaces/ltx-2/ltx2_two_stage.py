"""
python ltx2_two_stage.py \
  --image "astronaut.jpg" 0 1.0 \
  --prompt="An astronaut hatches from a fragile egg on the surface of the Moon, the shell cracking and peeling apart in gentle low-gravity motion. Fine lunar dust lifts and drifts outward with each movement, floating in slow arcs before settling back onto the ground. The astronaut pushes free in a deliberate, weightless motion, small fragments of the egg tumbling and spinning through the air. In the background, the deep darkness of space subtly shifts as stars glide with the camera's movement, emphasizing vast depth and scale. The camera performs a smooth, cinematic slow push-in, with natural parallax between the foreground dust, the astronaut, and the distant starfield. Ultra-realistic detail, physically accurate low-gravity motion, cinematic lighting, and a breath-taking, movie-like shot." \
  --output_path="t2v_2.mp4" \
  --gemma_root="google/gemma-3-12b-it-qat-q4_0-unquantized" \
  --checkpoint_path="rc1/ltx-2-19b-dev-rc1.safetensors" \
  --distilled_lora_path "rc1/ltx-2-19b-distilled-lora-384-rc1.safetensors" \
  --spatial_upsampler_path "rc1/ltx-2-spatial-upscaler-x2-1.0-rc1.safetensors"

"""

from huggingface_hub import hf_hub_download
from typing import Optional
from ltx_pipelines import utils
from ltx_pipelines.constants import DEFAULT_LORA_STRENGTH
from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
from ltx_core.tiling import TilingConfig


def get_hub_or_local_checkpoint(repo_id: Optional[str] = None, filename: Optional[str] = None):
    if repo_id is None and filename is None:
        raise ValueError("Please supply at least one of `repo_id` or `filename`")

    if repo_id is not None:
        if filename is None:
            raise ValueError("If repo_id is specified, filename must also be specified.")
        ckpt_path = hf_hub_download(repo_id=repo_id, filename=filename)
    else:
        ckpt_path = filename

    return ckpt_path


def default_2_stage_arg_parser_mod():
    parser = utils.default_2_stage_arg_parser()
    parser.add_argument("--local_files_only", action="store_true")
    parser.add_argument("--checkpoint_id", type=str, default="diffusers-internal-dev/new-ltx-model")
    return parser


def main() -> None:
    parser = default_2_stage_arg_parser_mod()
    args = parser.parse_args()
    
    checkpoint_path = get_hub_or_local_checkpoint(args.checkpoint_id, args.checkpoint_path)
    distilled_lora_path = get_hub_or_local_checkpoint(args.checkpoint_id, args.distilled_lora_path)
    spatial_upsampler_path = get_hub_or_local_checkpoint(args.checkpoint_id, args.spatial_upsampler_path)

    lora_strengths = (args.lora_strength + [DEFAULT_LORA_STRENGTH] * len(args.lora))[: len(args.lora)]
    loras = [
        LoraPathStrengthAndSDOps(lora, strength, LTXV_LORA_COMFY_RENAMING_MAP)
        for lora, strength in zip(args.lora, lora_strengths, strict=True)
    ]
    pipeline = TI2VidTwoStagesPipeline(
        checkpoint_path=checkpoint_path,
        distilled_lora_path=distilled_lora_path,
        distilled_lora_strength=args.distilled_lora_strength,
        spatial_upsampler_path=spatial_upsampler_path,
        gemma_root=args.gemma_root,
        loras=loras,
        fp8transformer=args.enable_fp8,
        local_files_only=args.local_files_only
    )
    pipeline(
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        output_path=args.output_path,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        num_inference_steps=args.num_inference_steps,
        cfg_guidance_scale=args.cfg_guidance_scale,
        images=args.images,
        tiling_config=TilingConfig.default(),
    )


if __name__ == "__main__":
    main()
