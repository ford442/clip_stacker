import spaces
import sys
import os
import subprocess

@spaces.GPU(duration=120)
def install_flashattn():
    subprocess.run(['sh', './flashattn.sh'])
#install_flashattn()

# --- PyTorch Environment Setup ---
os.environ['PYTORCH_NVML_BASED_CUDA_CHECK'] = '1'
os.environ['TORCH_LINALG_PREFER_CUSOLVER'] = '1'

os.environ['PYTORCH_CUDA_ALLOC_CONF'] = (
    'max_split_size_mb:512,'
    'expandable_segments:True,'
    'pinned_use_background_threads:True,'
    'garbage_collection_threshold:0.6'  # ADD: Aggressive GC
)
os.environ["SAFETENSORS_FAST_GPU"] = "1"
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'

import torch
# Set precision settings for reproducibility and performance
#torch.backends.cuda.matmul.allow_tf32 = False
#torch.backends.cudnn.allow_tf32 = False
#torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
#torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
#torch.backends.cudnn.deterministic = False
#torch.backends.cudnn.benchmark = False # Set to True for potential speedup if input sizes are static, False for dynamic
#torch.backends.cuda.preferred_blas_library="cublas"
#torch.backends.cuda.preferred_linalg_library="cusolver"
#torch.set_float32_matmul_precision("highest")


def set_optimal_precision():
    """Balanced precision for quality + speed"""
    torch.backends.cuda.matmul.allow_tf32 = True  # Enable TF32 for matmul
    torch.backends.cudnn.allow_tf32 = True        # Enable TF32 for cuDNN
    torch.backends.cudnn.benchmark = True         # Enable for static input sizes
    torch.backends.cudnn.deterministic = False    # Allow non-deterministic optimizations
    torch.set_float32_matmul_precision("high")    # Use TF32 when safe

    # Disable reduced precision reductions (critical for quality)
    torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False

# Call this at startup and in generate()
set_optimal_precision()


FTP_HOST = os.getenv("FTP_HOST")
FTP_USER = os.getenv("FTP_USER")
FTP_PASS = os.getenv("FTP_PASS")
FTP_DIR = os.getenv("FTP_DIR")

import cv2
import gc

import paramiko
#from image_gen_aux import UpscaleWithModel # REMOVED: UpscaleWithModel import
import numpy as np
import gradio as gr
import random
import yaml
from pathlib import Path
import imageio
import tempfile
from PIL import Image
from huggingface_hub import hf_hub_download
import shutil
from diffusers import AutoencoderKL
from ltx_video.pipelines.pipeline_ltx_video import ConditioningItem, LTXMultiScalePipeline
from ltx_video.utils.skip_layer_strategy import SkipLayerStrategy

from inference import (
    create_ltx_video_pipeline,
    create_latent_upsampler,
    load_image_to_tensor_with_resize_and_crop,
    seed_everething,
    get_device,
    calculate_padding,
    load_media_file
)
from moviepy.editor import VideoFileClip, concatenate_videoclips
from typing import Any, Dict, Optional, Tuple

# Imports for TeaCache
from ltx_video.models.transformers.transformer3d import Transformer3DModel, Transformer3DModelOutput
from diffusers.utils import logging
import re
logger = logging.get_logger(__name__)

# --- Start TeaCache Integration ---
# 1. Store the original, unbound forward method from the class definition
original_transformer_forward = Transformer3DModel.forward

# 2. Define our new, robust wrapper function
def teacache_wrapper_forward(self, hidden_states: torch.Tensor, **kwargs):
    if not hasattr(self, "enable_teacache") or not self.enable_teacache:
        # Call the original method if TeaCache is disabled
        return original_transformer_forward(self, hidden_states=hidden_states, **kwargs)

    # Determine if we should calculate or skip
    should_calc = True
    if self.cnt > 0 and self.cnt < self.num_steps - 1:
        if (hasattr(self, "previous_hidden_states") and
                self.previous_hidden_states is not None and
                self.previous_hidden_states.shape == hidden_states.shape):
            
            rel_l1_dist = ((hidden_states - self.previous_hidden_states).abs().mean() / self.previous_hidden_states.abs().mean()).cpu().item()
            self.accumulated_rel_l1_distance += rel_l1_dist

            if self.accumulated_rel_l1_distance < self.rel_l1_thresh:
                should_calc = False
            else:
                self.accumulated_rel_l1_distance = 0
        else:
            # Force calculation if shapes mismatch or it's the first time in a new pass
            self.accumulated_rel_l1_distance = 0
    
    self.cnt += 1

    if not should_calc and hasattr(self, "previous_residual") and self.previous_residual is not None and self.previous_residual.shape == hidden_states.shape:
        # SKIP: Use the cached result
        # The pipeline expects a Transformer3DModelOutput object.
        return Transformer3DModelOutput(sample=self.previous_residual + hidden_states)
    else:
        # COMPUTE: Call the original, stored method, passing 'self' explicitly
        self.previous_hidden_states = hidden_states.clone()
        output = original_transformer_forward(self, hidden_states=hidden_states, **kwargs)
        
        # Handle both tuple and object return types from the original function
        if isinstance(output, tuple):
            output_tensor = output[0]
        else:
            output_tensor = output.sample
            
        self.previous_residual = output_tensor - hidden_states
        return output

# 3. Apply the patch
Transformer3DModel.forward = teacache_wrapper_forward
print("✅ Transformer3DModel patched with robust TeaCache Wrapper.")
# --- End TeaCache Integration ---

# Add this function and call it at the start of generate()
def reset_teacache_state(transformer):
    """Reset TeaCache state to prevent cross-generation contamination"""
    if hasattr(transformer, "cnt"):
        transformer.cnt = 0
    if hasattr(transformer, "previous_hidden_states"):
        transformer.previous_hidden_states = None
    if hasattr(transformer, "previous_residual"):
        transformer.previous_residual = None
    if hasattr(transformer, "accumulated_rel_l1_distance"):
        transformer.accumulated_rel_l1_distance = 0

MAX_SEED = np.iinfo(np.int32).max

# REMOVED: Upscaler pipeline initialization
#upscaler = UpscaleWithModel.from_pretrained("Kim2091/ClearRealityV1").to(torch.device("cuda:0"))

# REMOVED: SDXL Image-to-Image enhancer pipeline initialization
# print("Loading SDXL Image-to-Image pipeline...")
# enhancer_pipeline = StableDiffusionXLImg2ImgPipeline.from_pretrained(
#     "ford442/stable-diffusion-xl-refiner-1.0-bf16",
#     use_safetensors=True,
#     requires_aesthetics_score=True,
# )
# enhancer_pipeline.vae.set_default_attn_processor()
# enhancer_pipeline.to("cpu")
# print("SDXL Image-to-Image pipeline loaded successfully.")

config_file_path = "configs/ltxv-13b-0.9.8-distilled.yaml"
with open(config_file_path, "r") as file:
    PIPELINE_CONFIG_YAML = yaml.safe_load(file)

LTX_REPO = "Lightricks/LTX-Video"
MAX_IMAGE_SIZE = PIPELINE_CONFIG_YAML.get("max_resolution", 1280)
MAX_NUM_FRAMES = 900
models_dir = "downloaded_models_gradio_cpu_init"
Path(models_dir).mkdir(parents=True, exist_ok=True)
pipeline_instance = None
latent_upsampler_instance = None
temporal_upsampler_instance = None

print("Downloading models (if not present)...")
distilled_model_actual_path = hf_hub_download(repo_id=LTX_REPO, filename=PIPELINE_CONFIG_YAML["checkpoint_path"], local_dir=models_dir, local_dir_use_symlinks=False)
PIPELINE_CONFIG_YAML["checkpoint_path"] = distilled_model_actual_path

SPATIAL_UPSCALER_FILENAME = PIPELINE_CONFIG_YAML["spatial_upscaler_model_path"]
spatial_upscaler_actual_path = hf_hub_download(repo_id=LTX_REPO, filename=SPATIAL_UPSCALER_FILENAME, local_dir=models_dir, local_dir_use_symlinks=False)
PIPELINE_CONFIG_YAML["spatial_upscaler_model_path"] = spatial_upscaler_actual_path

# --- Download Temporal Upscaler (Corrected Location) ---
TEMPORAL_UPSCALER_FILENAME = "ltxv-temporal-upscaler-0.9.8.safetensors"
try:
    print(f"Downloading temporal upscaler model: {TEMPORAL_UPSCALER_FILENAME}")
    temporal_upscaler_actual_path = hf_hub_download(
        repo_id=LTX_REPO, 
        filename=TEMPORAL_UPSCALER_FILENAME, 
        local_dir=models_dir, 
        local_dir_use_symlinks=False
    )
    PIPELINE_CONFIG_YAML["temporal_upscaler_model_path"] = temporal_upscaler_actual_path
except Exception as e:
    print(f"Warning: Could not download temporal upscaler ({TEMPORAL_UPSCALER_FILENAME}). Proceeding without it. Error: {e}")
    PIPELINE_CONFIG_YAML["temporal_upscaler_model_path"] = None

# --- Create Pipeline Instances ---
print("Creating LTX Video pipeline on CPU...")
pipeline_instance = create_ltx_video_pipeline(
    ckpt_path=PIPELINE_CONFIG_YAML["checkpoint_path"],
    precision=PIPELINE_CONFIG_YAML["precision"],
    text_encoder_model_name_or_path=PIPELINE_CONFIG_YAML["text_encoder_model_name_or_path"],
    sampler=PIPELINE_CONFIG_YAML["sampler"],
    device="cpu",
    enhance_prompt=False,
    prompt_enhancer_image_caption_model_name_or_path=PIPELINE_CONFIG_YAML["prompt_enhancer_image_caption_model_name_or_path"],
    prompt_enhancer_llm_model_name_or_path=PIPELINE_CONFIG_YAML["prompt_enhancer_llm_model_name_or_path"]
)

# For LTX Video's CausalVideoAutoencoder
if hasattr(pipeline_instance.vae, 'enable_z_tiling'):
    # Temporal tiling (prevents OOM on long videos)
    pipeline_instance.vae.enable_z_tiling(
        #tile_z_size=8,      # Frames per tile (temporal dimension)
        #z_overlap=1         # Overlap between temporal tiles
    )
    
    # Spatial tiling (for high resolutions)
    if hasattr(pipeline_instance.vae, 'enable_spatial_tiling'):
        pipeline_instance.vae.enable_spatial_tiling(
            tile_sample_min_height=512,
            tile_sample_min_width=512,
            tile_overlap_factor_height=0.25,
            tile_overlap_factor_width=0.25
        )
        
    #elif hasattr(pipeline_instance.vae, 'enable_tiling'):
        # Fallback for standard VAEs (shouldn't trigger for LTXV)
        #pipeline_instance.vae.enable_tiling()
    

if PIPELINE_CONFIG_YAML.get("spatial_upscaler_model_path"):
    print("Creating latent upsampler on CPU...")
    latent_upsampler_instance = create_latent_upsampler(PIPELINE_CONFIG_YAML["spatial_upscaler_model_path"], device="cpu")
    
if PIPELINE_CONFIG_YAML.get("temporal_upscaler_model_path"):
    print("Creating temporal upsampler on CPU...")
    temporal_upsampler_instance = create_latent_upsampler(PIPELINE_CONFIG_YAML["temporal_upscaler_model_path"], device="cpu")

target_inference_device = "cuda"
print(f"Target inference device: {target_inference_device}")
pipeline_instance.to(target_inference_device)

#pipeline_instance.enable_model_cpu_offload()  # For large models
pipeline_instance.enable_attention_slicing(1)  # Slice attention for memory savings
#pipeline_instance.enable_vae_slicing()  # Enable VAE slicing


# After pipeline.to(device)
#if not hasattr(pipeline_instance, '_compiled'):
#    print("Compiling transformer...")
#    pipeline_instance.transformer = torch.compile(
#        pipeline_instance.transformer,
#        mode="reduce-overhead",  # or "max-autotune" for best performance
#        fullgraph=True,
#        dynamic=False  # Set True if shapes vary
#    )
#    pipeline_instance._compiled = True
    

if hasattr(pipeline_instance.transformer, 'set_attn_processor'):
    from diffusers.models.attention_processor import AttnProcessor2_0
    pipeline_instance.transformer.set_attn_processor(AttnProcessor2_0())
    
if latent_upsampler_instance: latent_upsampler_instance.to(target_inference_device)
if temporal_upsampler_instance: temporal_upsampler_instance.to(target_inference_device)
    
dynamic_shapes = {
    "hidden_states": {
        0: torch.export.Dim("batch_size"),
        1: torch.export.Dim("num_frames"),
        # <-- CRUCIAL for video
        2: torch.export.Dim("sequence_length"),
    },
    "encoder_hidden_states": {
        0: torch.export.Dim("batch_size"),
        1: torch.export.Dim("text_sequence_length"),
    },
    # ... add other inputs as needed, just like we did before
}


def get_duration(*args, **kwargs):
    duration_ui = kwargs.get('duration_ui', 5.0)
    if duration_ui > 7.0: return 110
    if duration_ui > 5.0: return 100
    if duration_ui > 4.0: return 90
    if duration_ui > 3.0: return 70
    if duration_ui > 2.0: return 60
    if duration_ui > 1.5: return 50
    if duration_ui > 1.0: return 45
    if duration_ui > 0.5: return 30
    return 90

def upload_to_sftp(local_filepath):
    if not all([FTP_HOST, FTP_USER, FTP_PASS, FTP_DIR]):
        print("SFTP credentials not set. Skipping upload.")
        return

    try:
        transport = paramiko.Transport((FTP_HOST, 22))
        transport.connect(username=FTP_USER, password=FTP_PASS)
        sftp = paramiko.SFTPClient.from_transport(transport)
        
        remote_filename = os.path.basename(local_filepath)
        remote_filepath = os.path.join(FTP_DIR, remote_filename)
        
        print(f"Uploading {local_filepath} to {remote_filepath}...")
        sftp.put(local_filepath, remote_filepath)
        print("Upload successful.")
        
        sftp.close()
        transport.close()
    except Exception as e:
        print(f"SFTP upload failed: {e}")
        gr.Warning(f"SFTP upload failed: {e}")

def calculate_new_dimensions(orig_w, orig_h):
    if orig_w == 0 or orig_h == 0: return int(1024), int(1024)
    if orig_w >= orig_h:
        new_h, new_w = 1024, round((1024 * (orig_w / orig_h)) / 32) * 32
    else:
        new_w, new_h = 1024, round((1024 * (orig_h / orig_w)) / 32) * 32
    return int(max(256, min(new_h, MAX_IMAGE_SIZE))), int(max(256, min(new_w, MAX_IMAGE_SIZE)))

# REMOVED: superres_image function

# REMOVED: enhance_frame function

# MODIFIED: Removed calls to superres_image and enhance_frame
def use_last_frame_as_input(video_filepath):
    if not video_filepath or not os.path.exists(video_filepath):
        gr.Warning("No video clip available.")
        return None, gr.update()
    
    cap = None
    try:
        cap = cv2.VideoCapture(video_filepath)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_count - 1)
        ret, frame = cap.read()
        
        if not ret: raise ValueError("Failed to read frame.")
        
        pil_image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        print("Displaying last frame and switching tab...")
        yield pil_image, gr.update(selected="i2v_tab")

    except Exception as e:
        gr.Error(f"Failed to extract frame: {e}")
        return None, gr.update()
    finally:
        if cap: cap.release()

def stitch_videos(clips_list):
    if not clips_list or len(clips_list) < 2:
        raise gr.Error("You need at least two clips to stitch them together!")
    
    print(f"Stitching {len(clips_list)} clips...")
    try:
        video_clips = [VideoFileClip(clip_path) for clip_path in clips_list]
        final_clip = concatenate_videoclips(video_clips, method="compose")
        
        final_output_path = os.path.join(tempfile.mkdtemp(), f"stitched_video_{random.randint(10000,99999)}.mp4")
        
        high_quality_params = ['-crf', '0', '-preset', 'veryslow']
        
        final_clip.write_videofile(
            final_output_path, 
            codec="libx264", 
            audio=False, 
            threads=4, 
            ffmpeg_params=high_quality_params # <-- USE PARAMS HERE
        )
        
        for clip in video_clips:
            clip.close()
            
        return final_output_path
    except Exception as e:
        raise gr.Error(f"Failed to stitch videos: {e}")

def clear_clips():
    # state, counter, video1, video2, toggle_visible, tensor_state, randomize_seed
    return [], "Clips created: 0", None, None, gr.update(visible=False, value=False), None, gr.update(value=True)


# New function to add before generate()
def add_flow_guidance(media_items, fps=24):
    """Add optical flow for temporal consistency"""
    if media_items is None or media_items.shape[2] < 2:
        return media_items

    import cv2
    frames = media_items[0].permute(1,2,3,0).cpu().numpy()
    flows = []

    for i in range(len(frames)-1):
        prev = cv2.cvtColor(frames[i], cv2.COLOR_RGB2GRAY)
        next = cv2.cvtColor(frames[i+1], cv2.COLOR_RGB2GRAY)
        flow = cv2.calcOpticalFlowFarneback(prev, next, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        flows.append(torch.from_numpy(flow).permute(2,0,1))

    # Store flows in pipeline config for use in generation
    PIPELINE_CONFIG_YAML['optical_flow'] = torch.stack(flows).unsqueeze(0)
    return media_items
    
@spaces.GPU(duration=get_duration)
def generate(prompt, negative_prompt, clips_list, input_image_filepath, input_video_filepath, 
             last_frame_tensor_from_state, 
             height_ui, width_ui, mode, duration_ui, ui_frames_to_use, 
             seed_ui, randomize_seed, ui_guidance_scale, improve_texture_flag, 
             use_temporal_upscaler_flag, use_last_tensor_flag, 
             num_steps, fps,
             enable_teacache, teacache_threshold,
             text_encoder_max_tokens_ui, 
             image_cond_noise_scale_ui, # <--- NEW PARAMETER ADDED HERE
             progress=gr.Progress(track_tqdm=True)):

    # --- FIX: TeaCache + Multi-Scale Incompatibility ---
    # Force disable TeaCache if multi-scale is on, as the state will not be
    # reset between the first and second pass, corrupting the output.
    if improve_texture_flag and enable_teacache:
        gr.Warning("TeaCache is incompatible with Multi-Scale mode. Disabling TeaCache for this run.")
        enable_teacache = False

    # Configure TeaCache state on the transformer instance for this run
    try:
        pipeline_instance.transformer.enable_teacache = enable_teacache
        if enable_teacache:
            print(f"✅ TeaCache is ENABLED with threshold: {teacache_threshold}")
            pipeline_instance.transformer.rel_l1_thresh = teacache_threshold
        else:
            print("❌ TeaCache is DISABLED.")
    except AttributeError:
        print("⚠️ Could not configure TeaCache on transformer.")

    # Set highest precision for the main generation pipeline
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.deterministic = False
    torch.set_float32_matmul_precision("highest")
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    reset_teacache_state(pipeline_instance.transformer)

    if mode not in ["text-to-video", "image-to-video", "video-to-video"]:
        raise gr.Error(f"Invalid mode: {mode}.")
    
    # Input validation
    if (mode == "image-to-video" 
        and not input_image_filepath 
        and not (use_last_tensor_flag and last_frame_tensor_from_state is not None)):
        raise gr.Error("Input image is required for image-to-video mode (or 'Use Last Frame' must be checked).")
    elif mode == "video-to-video" and not input_video_filepath:
        raise gr.Error("input_video_filepath is required for video-to-video mode")
        
    if randomize_seed: seed_ui = random.randint(0, 2**32 - 1)
    seed_everething(int(seed_ui))

    actual_num_frames = max(9, min(MAX_NUM_FRAMES, int(round((max(1, round(duration_ui * fps)) - 1.0) / 8.0) * 8 + 1)))
    actual_height, actual_width = int(height_ui), int(width_ui)
    height_padded, width_padded = ((actual_height - 1) // 32 + 1) * 32, ((actual_width - 1) // 32 + 1) * 32
    padding_values = calculate_padding(actual_height, actual_width, height_padded, width_padded)
    num_frames_padded = max(9, ((actual_num_frames - 2) // 8 + 1) * 8 + 1)
    
    call_kwargs = {
        "prompt": prompt, "negative_prompt": negative_prompt, "height": height_padded, "width": width_padded,
        "num_frames": num_frames_padded, "num_inference_steps": num_steps, "frame_rate": int(fps),
        "generator": torch.Generator(device=target_inference_device).manual_seed(int(seed_ui)),
        "output_type": "pt", "conditioning_items": None, "media_items": None,
        "decode_timestep": PIPELINE_CONFIG_YAML["decode_timestep"],
        "decode_noise_scale": PIPELINE_CONFIG_YAML["decode_noise_scale"],
        "stochastic_sampling": PIPELINE_CONFIG_YAML["stochastic_sampling"],
        "image_cond_noise_scale": image_cond_noise_scale_ui,
        "is_video": True, "vae_per_channel_normalize": True,
        "mixed_precision": (PIPELINE_CONFIG_YAML["precision"] == "mixed_precision"),
        "text_encoder_max_tokens": text_encoder_max_tokens_ui, # <-- PASSED HERE
        "offload_to_cpu": False, "enhance_prompt": False
    }

    stg_mode_str = PIPELINE_CONFIG_YAML.get("stg_mode", "attention_values").lower()
    stg_map = {
        "stg_av": SkipLayerStrategy.AttentionValues, "attention_values": SkipLayerStrategy.AttentionValues,
        "stg_as": SkipLayerStrategy.AttentionSkip, "attention_skip": SkipLayerStrategy.AttentionSkip,
        "stg_r": SkipLayerStrategy.Residual, "residual": SkipLayerStrategy.Residual,
        "stg_t": SkipLayerStrategy.TransformerBlock, "transformer_block": SkipLayerStrategy.TransformerBlock
    }
    call_kwargs["skip_layer_strategy"] = stg_map.get(stg_mode_str, SkipLayerStrategy.AttentionValues)

    # --- INPUT LOGIC: Priority = Direct Tensor > Image File > Video File ---
    if use_last_tensor_flag and last_frame_tensor_from_state is not None:
        print("Using last frame tensor as input (Direct Tensor).")
        
        media_tensor = last_frame_tensor_from_state.to(target_inference_device) 
        b, c, n, h, w = media_tensor.shape
        
        # CRITICAL FIX 2: Better interpolation for Latents
        # Latents are compressed data. 'bilinear' can smear features. 
        # 'nearest-exact' preserves distinct latent features better if resizing is strictly necessary.
        # However, avoiding resizing entirely is best.
        if h != actual_height or w != actual_width:
            media_tensor_4d = media_tensor.view(b * n, c, h, w)
            resized_tensor_4d = torch.nn.functional.interpolate(
                media_tensor_4d, 
                size=(actual_height, actual_width), 
                mode='bilinear', # Changed from bilinear
                align_corners=False,
                antialias=False
            )
            media_tensor_5d = resized_tensor_4d.view(b, c, n, actual_height, actual_width)
        else:
            media_tensor_5d = media_tensor

        # Pad and set
        call_kwargs["conditioning_items"] = [ConditioningItem(
            torch.nn.functional.pad(media_tensor, padding_values).to(target_inference_device), 
            0, 
            1.0
        )]

    elif mode == "image-to-video":
        print("Using image file as input.")
        # Standard noise scale is fine for I2V from file
        call_kwargs["image_cond_noise_scale"] = 0.05 
        media_tensor = load_image_to_tensor_with_resize_and_crop(input_image_filepath, actual_height, actual_width)
        call_kwargs["conditioning_items"] = [ConditioningItem(torch.nn.functional.pad(media_tensor, padding_values).to(target_inference_device), 0, 1.0)]
    
    elif mode == "video-to-video": 
        print("Using video file as input.")
        media_items = add_flow_guidance(call_kwargs.get("media_items"), fps)
        call_kwargs["media_items"] = load_media_file(media_path=input_video_filepath, height=actual_height, width=actual_width, max_frames=int(ui_frames_to_use), padding=padding_values).to(target_inference_device)
    # --- END INPUT LOGIC ---

    if improve_texture_flag and latent_upsampler_instance:
        
        # Force disable TeaCache for multi-scale (safer)
        enable_teacache = False
        pipeline_instance.transformer.enable_teacache = False
        temporal_upsampler_to_use = temporal_upsampler_instance if use_temporal_upscaler_flag else None

        multi_scale_pipeline = LTXMultiScalePipeline(
            pipeline_instance,
            latent_upsampler_instance
        )

        # Reset state before EACH pass
        def reset_and_generate(**kwargs):
            reset_teacache_state(pipeline_instance.transformer)
            return multi_scale_pipeline(**kwargs)

        result_images_tensor = reset_and_generate(
            **call_kwargs,
            downscale_factor=PIPELINE_CONFIG_YAML["downscale_factor"],
            first_pass={**PIPELINE_CONFIG_YAML.get("first_pass", {}), "guidance_scale": float(ui_guidance_scale)},
            second_pass={**PIPELINE_CONFIG_YAML.get("second_pass", {}), "guidance_scale": float(ui_guidance_scale)},
            temporal_upsampler=temporal_upsampler_to_use
        ).images
    else:
        # --- Configure TeaCache for a single pass ---
        pipeline_instance.transformer.num_steps = num_steps
        pipeline_instance.transformer.cnt = 0
        pipeline_instance.transformer.previous_hidden_states = None
        pipeline_instance.transformer.previous_residual = None
        pipeline_instance.transformer.accumulated_rel_l1_distance = 0
        
        single_pass_kwargs = {**call_kwargs, "guidance_scale": float(ui_guidance_scale), **PIPELINE_CONFIG_YAML.get("first_pass", {})}
        result_images_tensor = pipeline_instance(**single_pass_kwargs).images
        
    if result_images_tensor is None: raise gr.Error("Generation failed.")
        
    # Extract if tuple
    if isinstance(result_images_tensor, (tuple, list)):
        result_images_tensor = result_images_tensor[0]
        
    pad_l, pad_r, pad_t, pad_b = padding_values
    result_images_tensor = result_images_tensor[:, :, :actual_num_frames, pad_t:(-pad_b or None), pad_l:(-pad_r or None)]
    
    video_np = (np.clip(result_images_tensor[0].permute(1, 2, 3, 0).cpu().float().numpy(), 0, 1) * 255).astype(np.uint8)
    output_video_path = os.path.join(tempfile.mkdtemp(), f"output_{random.randint(10000,99999)}.mp4")
    
    with imageio.get_writer(output_video_path, format='FFMPEG', fps=call_kwargs["frame_rate"], codec='libx264', quality=10, pixelformat='yuv420p') as video_writer:
        for idx, frame in enumerate(video_np):
            progress(idx / len(video_np), desc="Saving video clip...")
            video_writer.append_data(frame)
    
    #upload_to_sftp(output_video_path)
    
    # --- Extract Last Frame Tensor for Chaining ---
    # Get the last frame tensor, but KEEP the 'N' dimension (shape [b, c, 1, h, w])
    last_frame_tensor_unnormalized = result_images_tensor[:, :, [-1], :, :].clone().cpu()
    # Normalize it to -1 to 1 range, which the conditioning input expects
    last_frame_tensor = (last_frame_tensor_unnormalized * 2.0) - 1.0
    
    updated_clips_list = clips_list + [output_video_path]
    counter_text = f"Clips created: {len(updated_clips_list)}"
    
    # Return updates for new UI elements
    return output_video_path, seed_ui, gr.update(visible=True), updated_clips_list, counter_text, gr.update(visible=True, value=True), last_frame_tensor, gr.update(value=False)

def update_task_image(): 
    return "image-to-video"
def update_task_text(): 
    return "text-to-video"
def update_task_video(): 
    return "video-to-video"

css="""
#col-container{margin:0 auto;max-width:900px;}
"""
with gr.Blocks(css=css) as demo:
    clips_state = gr.State([])
    last_frame_tensor_state = gr.State(value=None) # <-- For Direct Tensor Chaining
    
    gr.Markdown("# LTX Video Clip Stitcher")
    gr.Markdown("Generate short video clips and stitch them together to create a longer animation.")
    
    with gr.Row():
        with gr.Column():
            with gr.Tabs() as tabs:
                with gr.Tab("image-to-video", id="i2v_tab") as image_tab: 
                    video_i_hidden = gr.Textbox(visible=False); 
                    image_i2v = gr.Image(label="Input Image", type="filepath", sources=["upload", "webcam", "clipboard"]); 
                    i2v_prompt = gr.Textbox(label="Prompt", value="The character from the image starts to move.", lines=3); 
                    i2v_button = gr.Button("Generate Image-to-Video Clip", variant="primary")
                
                with gr.Tab("text-to-video", id="t2v_tab") as text_tab:
                    image_n_hidden = gr.Textbox(visible=False); 
                    video_n_hidden = gr.Textbox(visible=False); t2v_prompt = gr.Textbox(label="Prompt", value="A majestic dragon flying over a medieval castle", lines=3); 
                    t2v_button = gr.Button("Generate Text-to-Video Clip", variant="primary")
                
                with gr.Tab("video-to-video", id="v2v_tab") as video_tab:
                    image_v_hidden = gr.Textbox(visible=False); 
                    video_v2v = gr.Video(label="Input Video", sources=["upload", "webcam"]); 
                    frames_to_use = gr.Slider(label="Frames to use from input video", minimum=9, maximum=120, value=9, step=8, info="Must be N*8+1."); 
                    v2v_prompt = gr.Textbox(label="Prompt", value="Change the style to cinematic anime", lines=3); 
                    v2v_button = gr.Button("Generate Video-to-Video Clip", variant="primary")
            
            duration_input = gr.Slider(label="Clip Duration (seconds)", minimum=1.0, maximum=10.0, value=2.0, step=0.1)
            improve_texture = gr.Checkbox(label="Improve Texture (multi-scale)", value=True)
            use_temporal_upscaler = gr.Checkbox(label="Use Temporal Upscaler (for smoothness)", value=True)
            use_last_tensor_toggle = gr.Checkbox(label="Use Last Frame (Direct Tensor)", value=False, visible=False) # <-- For Chaining
            # REMOVED: enhance_checkbox
            # REMOVED: superres_checkbox
            
        with gr.Column():
            output_video = gr.Video(label="Last Generated Clip", interactive=False)
            use_last_frame_button = gr.Button("Use Last Frame as Input Image", visible=False)
            
            with gr.Accordion("Stitching Controls", open=True):
                clip_counter_display = gr.Markdown("Clips created: 0")
                with gr.Row(): 
                    stitch_button = gr.Button("🎬 Stitch All Clips");
                    clear_button = gr.Button("🗑️ Clear All Clips")
                final_video_output = gr.Video(label="Final Stitched Video", interactive=False)

    with gr.Accordion("Advanced settings", open=False):
        mode = gr.Dropdown(["text-to-video", "image-to-video", "video-to-video"], label="task", value="image-to-video", visible=False); 
        negative_prompt_input = gr.Textbox(label="Negative Prompt", value="worst quality, inconsistent motion, blurry, jittery, distorted, low clarity, low resolution, grainy, pixelated, oversaturated, glitchy, noisy", lines=2)
        
        with gr.Row():
            teacache_checkbox = gr.Checkbox(label="Enable TeaCache Acceleration", value=False)
            teacache_slider = gr.Slider(
                minimum=0.01,
                maximum=0.1,
                step=0.01,
                value=0.05,
                label="TeaCache Threshold (Higher = Faster)"
            )
            
        with gr.Row(): 
            seed_input = gr.Number(label="Seed", value=42, precision=0); 
            randomize_seed_input = gr.Checkbox(label="Randomize Seed", value=True)
            
        with gr.Row(visible=True): # <-- MODIFIED
            guidance_scale_input = gr.Slider(label="Guidance Scale (CFG)", minimum=1.0, maximum=10.0, value=PIPELINE_CONFIG_YAML.get("first_pass", {}).get("guidance_scale", 1.0), step=0.1)
        with gr.Row():
            # --- NEW UI COMPONENT ---
             text_encoder_max_tokens_input = gr.Slider(
                 label="Text Encoder Max Tokens (Affects Speed/Fidelity)", 
                 minimum=16,
                 maximum=300,
                 value=256,
                 step=1
             )
        with gr.Row(): 
            height_input = gr.Slider(label="Height", value=1024, step=32, minimum=32, maximum=MAX_IMAGE_SIZE); 
            width_input = gr.Slider(label="Width", value=1024, step=32, minimum=32, maximum=MAX_IMAGE_SIZE); 
        with gr.Row():
            image_cond_noise_scale_input = gr.Slider(
                label="Image Conditioning Noise Scale", 
                minimum=0.0, 
                maximum=1.0, 
                value=0.00,
                step=0.01,
                info="Controls how much noise is added to the input image/frame. Lower values preserve the image better, higher values allow more creative freedom (0.0 for near-perfect preservation)."
            )
        num_steps = gr.Slider(label="Steps", value=30, step=1, minimum=1, maximum=420); 
        fps = gr.Slider(label="FPS", value=24.0, step=1.0, minimum=4.0, maximum=60.0)
            
    def handle_image_upload_for_dims(f, h, w):
        if not f: return gr.update(value=h), gr.update(value=w)
        img = Image.open(f); new_h, new_w = calculate_new_dimensions(img.width, img.height); return gr.update(value=new_h), gr.update(value=new_w)
    
    def handle_video_upload_for_dims(f, h, w):
        if not f or not os.path.exists(str(f)): return gr.update(value=h), gr.update(value=w)
        with imageio.get_reader(str(f)) as reader:
            meta = reader.get_meta_data(); orig_w, orig_h = meta.get('size', (reader.get_data(0).shape[1], reader.get_data(0).shape[0])); 
            new_h, new_w = calculate_new_dimensions(orig_w, orig_h); return gr.update(value=new_h), gr.update(value=new_w)
            
    image_i2v.upload(handle_image_upload_for_dims, [image_i2v, height_input, width_input], [height_input, width_input]); 
    video_v2v.upload(handle_video_upload_for_dims, [video_v2v, height_input, width_input], [height_input, width_input]); 
    image_tab.select(update_task_image, outputs=[mode]); text_tab.select(update_task_text, outputs=[mode]); 
    video_tab.select(update_task_video, outputs=[mode])
    
    # --- FIX: Add new UI toggles to common_params ---
    common_params = [
        height_input, width_input, mode, duration_input, frames_to_use, 
        seed_input, randomize_seed_input, guidance_scale_input, improve_texture, 
        use_temporal_upscaler, use_last_tensor_toggle, num_steps, fps, 
        teacache_checkbox, teacache_slider, 
        text_encoder_max_tokens_input, # Already there
        image_cond_noise_scale_input # <--- NEW SLIDER ADDED HERE
    ]

    t2v_inputs = [t2v_prompt, negative_prompt_input, clips_state, image_n_hidden, video_n_hidden, last_frame_tensor_state] + common_params; 
    i2v_inputs = [i2v_prompt, negative_prompt_input, clips_state, image_i2v, video_i_hidden, last_frame_tensor_state] + common_params; 
    v2v_inputs = [v2v_prompt, negative_prompt_input, clips_state, image_v_hidden, video_v2v, last_frame_tensor_state] + common_params
    
    # --- FIX: Add new UI elements to outputs ---
    gen_outputs = [
        output_video, seed_input, use_last_frame_button, 
        clips_state, clip_counter_display, 
        use_last_tensor_toggle, last_frame_tensor_state,
        randomize_seed_input # <-- ADDED THIS
    ]
    
    # This function now needs to hide both buttons
    hide_btn = lambda: (gr.update(visible=False), gr.update(visible=False))
    
    t2v_button.click(
        hide_btn, outputs=[use_last_frame_button, use_last_tensor_toggle], queue=False
    ).then(
        fn=generate, inputs=t2v_inputs, outputs=gen_outputs, api_name="text_to_video"
    )
    i2v_button.click(
        hide_btn, outputs=[use_last_frame_button, use_last_tensor_toggle], queue=False
    ).then(
        fn=generate, inputs=i2v_inputs, outputs=gen_outputs, api_name="image_to_video"
    )
    v2v_button.click(
        hide_btn, outputs=[use_last_frame_button, use_last_tensor_toggle], queue=False
    ).then(
        fn=generate, inputs=v2v_inputs, outputs=gen_outputs, api_name="video_to_video"
    )

    # MODIFIED: Removed enhance_checkbox and superres_checkbox from inputs
    use_last_frame_button.click(fn=use_last_frame_as_input, inputs=[output_video], outputs=[image_i2v, tabs])
    stitch_button.click(fn=stitch_videos, inputs=[clips_state], outputs=[final_video_output])
    
    # Clear button also needs to reset the tensor state and hide the toggle
    clear_button.click(fn=clear_clips, outputs=[clips_state, clip_counter_display, output_video, final_video_output, use_last_tensor_toggle, last_frame_tensor_state, randomize_seed_input])

if __name__ == "__main__":
    if os.path.exists(models_dir): print(f"Model directory: {Path(models_dir).resolve()}")
    demo.queue().launch(debug=True, share=True, mcp_server=True)