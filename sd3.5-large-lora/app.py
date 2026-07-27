import subprocess
subprocess.run(['sh', './spaces.sh'])

import spaces

def install_torch():
    subprocess.run(['sh', './torch.sh'])

#install_torch()

@spaces.GPU(required=True)
def install_flashattn():
    subprocess.run(['sh', './flashattn.sh'])

#install_flashattn()

import os

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

torch.backends.cuda.matmul.allow_tf32 = False  #  torch 2.8
torch.backends.cudnn.allow_tf32 = False        #  torch 2.8

torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
#torch.backends.fp32_precision = "ieee"  torch 2.9
#torch.backends.cuda.matmul.fp32_precision = "ieee"  torch 2.9
#torch.backends.cudnn.fp32_precision = "ieee"  torch 2.9
#torch.backends.cudnn.conv.fp32_precision = "ieee"  torch 2.9
#torch.backends.cudnn.rnn.fp32_precision = "ieee"  torch 2.9
torch.backends.cudnn.deterministic = False
torch.backends.cudnn.benchmark = False
torch.backends.cuda.preferred_blas_library="cublas"
torch.backends.cuda.preferred_linalg_library="cusolver"
torch.set_float32_matmul_precision("highest")

import gradio as gr
import numpy as np
import random
import datetime
import threading
import io
import json

# --- New GCS Imports ---
from google.oauth2 import service_account
from google.cloud import storage


from diffusers import StableDiffusion3Pipeline, SD3Transformer2DModel, AutoencoderKL
from PIL import Image
from image_gen_aux import UpscaleWithModel


from diffusers.models.attention_processor import AttnProcessor2_0
from kernels import get_kernel, has_kernel


class FlashAttentionProcessor(AttnProcessor2_0):
    def __call__(
        self,
        attn,
        hidden_states,
        encoder_hidden_states=None, # This will be present for cross-attention
        attention_mask=None,
        temb=None, # This might be present in some attention mechanisms, pass through if not used directly
        **kwargs,
    ):
        # Determine if it's self-attention or cross-attention
        # For self-attention, encoder_hidden_states is None or identical to hidden_states
        is_cross_attention = encoder_hidden_states is not None and encoder_hidden_states.shape[1] != hidden_states.shape[1]
        # SD3.5 uses DiT, where hidden_states are often 3D (B, Seq, Dim)
        # However, attention can be within a transformer block which might internally reshape.
        # Ensure your inputs (query, key, value) are properly shaped for the kernel.
        # The kernel expects (Batch, Heads, Sequence, Dim_Head)
        query = attn.to_q(hidden_states)
        if is_cross_attention:
            key = attn.to_k(encoder_hidden_states)
            value = attn.to_v(encoder_hidden_states)
        else: # Self-attention
            key = attn.to_k(hidden_states)
            value = attn.to_v(hidden_states)
        scale = attn.scale
        query = query * scale
        b, t, c = query.shape # B=batch_size, T=sequence_length, C=embedding_dim
        h = attn.heads
        d = c // h # dim_per_head
        # Reshape to (Batch, Heads, Sequence, Dim_Head) for Flash Attention kernel
        q_reshaped = query.reshape(b, t, h, d).permute(0, 2, 1, 3)
        k_reshaped = key.reshape(b, t, h, d).permute(0, 2, 1, 3)
        v_reshaped = value.reshape(b, t, h, d).permute(0, 2, 1, 3)
        out_reshaped = torch.empty_like(q_reshaped)
        # Call the Flash Attention kernel
        fa3_kernel.attention(q_reshaped, k_reshaped, v_reshaped, out_reshaped)
        # Reshape output back to (Batch, Sequence, Heads * Dim_Head)
        out = out_reshaped.permute(0, 2, 1, 3).reshape(b, t, c)
        out = attn.to_out(out)
        return out

# Make sure to set these secrets in your Hugging Face Space settings
GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME")
GCS_SA_KEY = os.getenv("GCS_SA_KEY") # The full JSON key content as a string

# Initialize GCS client if credentials are available
gcs_client = None
if GCS_SA_KEY and GCS_BUCKET_NAME:
    try:
        # Service-account keys are JSON. json.loads both parses them correctly
        # (eval chokes on the literal `null`/`true` a real key can contain) and
        # avoids executing whatever the secret happens to hold.
        credentials_info = json.loads(GCS_SA_KEY)
        credentials = service_account.Credentials.from_service_account_info(credentials_info)
        gcs_client = storage.Client(credentials=credentials)
        print("✅ GCS Client initialized successfully.")
    except Exception as e:
        print(f"❌ Failed to initialize GCS client: {e}")

def upload_to_gcs(image_object, filename):
    if not gcs_client:
        print("⚠️ GCS client not initialized. Skipping upload.")
        return
    try:
        print(f"--> Starting GCS upload for {filename}...")
        bucket = gcs_client.bucket(GCS_BUCKET_NAME)
        blob = bucket.blob(f"stablediff/{filename}")
        img_byte_arr = io.BytesIO()
        image_object.save(img_byte_arr, format='PNG', optimize=False, compress_level=0)
        img_byte_arr = img_byte_arr.getvalue()
        blob.upload_from_string(img_byte_arr, content_type='image/png')
        print(f"✅ Successfully uploaded {filename} to GCS.")
    except Exception as e:
        print(f"❌ An error occurred during GCS upload: {e}")

device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")

def load_model():
    pipe = StableDiffusion3Pipeline.from_pretrained(
        "ford442/stable-diffusion-3.5-large-bf16",
        trust_remote_code=True,
        transformer=None, # Load transformer separately
        use_safetensors=True
    )
    ll_transformer=SD3Transformer2DModel.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='transformer').to(device, dtype=torch.bfloat16)
    pipe.transformer=ll_transformer
    pipe.load_lora_weights("ford442/sdxl-vae-bf16", weight_name="LoRA/UltraReal.safetensors")
    pipe.to(device=device, dtype=torch.bfloat16)
    upscaler_2 = UpscaleWithModel.from_pretrained("Kim2091/ClearRealityV1").to(device)
    return pipe, upscaler_2
    
pipe, upscaler_2 = load_model()

#fa_processor = FlashAttentionProcessor()

#for name, module in pipe.transformer.named_modules():
#    if isinstance(module, AttnProcessor2_0):
#        module.processor = fa_processor

MAX_SEED = np.iinfo(np.int32).max
MAX_IMAGE_SIZE = 4096

@spaces.GPU(duration=45)
def generate_images_30(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, progress=gr.Progress(track_tqdm=True)):
    seed = random.randint(0, MAX_SEED)
    generator = torch.Generator(device=device).manual_seed(seed)
    print('-- generating image --')
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    sd_image = pipe(
        prompt=prompt, prompt_2=prompt, prompt_3=prompt,
        negative_prompt=neg_prompt_1, negative_prompt_2=neg_prompt_2, negative_prompt_3=neg_prompt_3,
        guidance_scale=guidance, num_inference_steps=steps,
        width=width, height=height, generator=generator,
        max_sequence_length=384
    ).images[0]
    print('-- got image --')
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    with torch.no_grad():
        upscale = upscaler_2(sd_image, tiling=True, tile_width=256, tile_height=256)
        upscale2 = upscaler_2(upscale, tiling=True, tile_width=256, tile_height=256)
    print('-- got upscaled image --')
    downscaled_upscale = upscale2.resize((upscale2.width // 16, upscale2.height // 16), Image.LANCZOS)
    return sd_image, downscaled_upscale, prompt

@spaces.GPU(duration=70)
def generate_images_60(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, progress=gr.Progress(track_tqdm=True)):
    seed = random.randint(0, MAX_SEED)
    generator = torch.Generator(device=device).manual_seed(seed)
    print('-- generating image --')
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    sd_image = pipe(
        prompt=prompt, prompt_2=prompt, prompt_3=prompt,
        negative_prompt=neg_prompt_1, negative_prompt_2=neg_prompt_2, negative_prompt_3=neg_prompt_3,
        guidance_scale=guidance, num_inference_steps=steps,
        width=width, height=height, generator=generator,
        max_sequence_length=384
    ).images[0]
    print('-- got image --')
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    with torch.no_grad():
        upscale = upscaler_2(sd_image, tiling=True, tile_width=256, tile_height=256)
        upscale2 = upscaler_2(upscale, tiling=True, tile_width=256, tile_height=256)
    print('-- got upscaled image --')
    downscaled_upscale = upscale2.resize((upscale2.width // 12, upscale2.height // 12), Image.LANCZOS)
    return sd_image, downscaled_upscale, prompt

@spaces.GPU(duration=120)
def generate_images_110(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, progress=gr.Progress(track_tqdm=True)):
    seed = random.randint(0, MAX_SEED)
    generator = torch.Generator(device=device).manual_seed(seed)
    print('-- generating image --')
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    sd_image = pipe(
        prompt=prompt, prompt_2=prompt, prompt_3=prompt,
        negative_prompt=neg_prompt_1, negative_prompt_2=neg_prompt_2, negative_prompt_3=neg_prompt_3,
        guidance_scale=guidance, num_inference_steps=steps,
        width=width, height=height, generator=generator,
        max_sequence_length=384
    ).images[0]
    print('-- got image --')
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    with torch.no_grad():
        upscale = upscaler_2(sd_image, tiling=True, tile_width=256, tile_height=256)
        upscale2 = upscaler_2(upscale, tiling=True, tile_width=256, tile_height=256)
    print('-- got upscaled image --')
    downscaled_upscale = upscale2.resize((upscale2.width // 16, upscale2.height // 16), Image.LANCZOS)
    return downscaled_upscale, upscale2, prompt

def run_inference_and_upload_30(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, save_consent, progress=gr.Progress(track_tqdm=True)):
    sd_image, upscaled_image, expanded_prompt = generate_images_30(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, progress)
    if save_consent:
        print("✅ User consented to save. Preparing uploads...")
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        sd_filename = f"sd35ll_{timestamp}.png"
        upscale_filename = f"sd35ll_upscale_{timestamp}.png"
        sd_thread = threading.Thread(target=upload_to_gcs, args=(sd_image, sd_filename))
        upscale_thread = threading.Thread(target=upload_to_gcs, args=(upscaled_image, upscale_filename))
        sd_thread.start()
        upscale_thread.start()
    else:
        print("ℹ️ User did not consent to save. Skipping upload.")
    return sd_image, expanded_prompt

def run_inference_and_upload_60(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, save_consent, progress=gr.Progress(track_tqdm=True)):
    sd_image, upscaled_image, expanded_prompt = generate_images_60(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, progress)
    if save_consent:
        print("✅ User consented to save. Preparing uploads...")
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        sd_filename = f"sd35ll_{timestamp}.png"
        upscale_filename = f"sd35ll_upscale_{timestamp}.png"
        sd_thread = threading.Thread(target=upload_to_gcs, args=(sd_image, sd_filename))
        upscale_thread = threading.Thread(target=upload_to_gcs, args=(upscaled_image, upscale_filename))
        sd_thread.start()
        upscale_thread.start()
    else:
        print("ℹ️ User did not consent to save. Skipping upload.")
    return sd_image, expanded_prompt

def run_inference_and_upload_110(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, save_consent, progress=gr.Progress(track_tqdm=True)):
    sd_image, upscaled_image, expanded_prompt = generate_images_110(prompt, neg_prompt_1, neg_prompt_2, neg_prompt_3, width, height, guidance, steps, progress)
    if save_consent:
        print("✅ User consented to save. Preparing uploads...")
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        sd_filename = f"sd35ll_{timestamp}.png"
        upscale_filename = f"sd35ll_upscale_{timestamp}.png"
        sd_thread = threading.Thread(target=upload_to_gcs, args=(sd_image, sd_filename))
        upscale_thread = threading.Thread(target=upload_to_gcs, args=(upscaled_image, upscale_filename))
        sd_thread.start()
        upscale_thread.start()
    else:
        print("ℹ️ User did not consent to save. Skipping upload.")
    return sd_image, expanded_prompt
    
css = """
#col-container {margin: 0 auto;max-width: 640px;}
body{background-color: blue;}
"""
with gr.Blocks(theme=gr.themes.Origin(), css=css) as demo:
    with gr.Column(elem_id="col-container"):
        gr.Markdown(" # StableDiffusion 3.5 Large with UltraReal lora test")
        expanded_prompt_output = gr.Textbox(label="Prompt", lines=1)
        with gr.Row():
            prompt = gr.Text(
                label="Prompt", show_label=False, max_lines=1,
                placeholder="Enter your prompt", container=False,
            )
            run_button_30 = gr.Button("Run30", scale=0, variant="primary")
            run_button_60 = gr.Button("Run60", scale=0, variant="primary")
            run_button_110 = gr.Button("Run100", scale=0, variant="primary")
        result = gr.Image(label="Result", show_label=False, type="pil")
        save_consent_checkbox = gr.Checkbox(
            label="✅ Anonymously upload result to a public gallery",
            value=True, # Default to not uploading
            info="Check this box to help us by contributing your image."
        )
        with gr.Accordion("Advanced Settings", open=True):
            negative_prompt_1 = gr.Text(label="Negative prompt 1", max_lines=1, placeholder="Enter a negative prompt", value="bad anatomy, poorly drawn hands, distorted face, blurry, out of frame, low resolution, grainy, pixelated, disfigured, mutated, extra limbs, bad composition")
            negative_prompt_2 = gr.Text(label="Negative prompt 2", max_lines=1, placeholder="Enter a second negative prompt", value="unrealistic, cartoon, anime, sketch, painting, drawing, illustration, graphic, digital art, render, 3d, blurry, deformed, disfigured, poorly drawn, bad anatomy, mutated, extra limbs, ugly, out of frame, bad composition, low resolution, grainy, pixelated, noisy, oversaturated, undersaturated, (worst quality, low quality:1.3), (bad hands, missing fingers:1.2)")
            negative_prompt_3 = gr.Text(label="Negative prompt 3", max_lines=1, placeholder="Enter a third negative prompt", value="(worst quality, low quality:1.3), (bad anatomy, bad hands, missing fingers, extra digit, fewer digits:1.2), (blurry:1.1), cropped, watermark, text, signature, logo, jpeg artifacts, (ugly, deformed, disfigured:1.2), (poorly drawn:1.2), mutated, extra limbs, (bad proportions, gross proportions:1.2), (malformed limbs, missing arms, missing legs, extra arms, extra legs:1.2), (fused fingers, too many fingers, long neck:1.2), (unnatural body, unnatural pose:1.1), out of frame, (bad composition, poorly composed:1.1), (oversaturated, undersaturated:1.1), (grainy, pixelated:1.1), (low resolution, noisy:1.1), (unrealistic, distorted:1.1), (extra fingers, mutated hands, poorly drawn hands, bad hands:1.3), (missing fingers:1.3)")
            with gr.Row():
                width = gr.Slider(label="Width", minimum=256, maximum=MAX_IMAGE_SIZE, step=32, value=1024)
                height = gr.Slider(label="Height", minimum=256, maximum=MAX_IMAGE_SIZE, step=32, value=1024)
            with gr.Row():
                guidance_scale = gr.Slider(label="Guidance scale", minimum=0.0, maximum=30.0, step=0.1, value=4.2)
                num_inference_steps = gr.Slider(label="Inference steps", minimum=1, maximum=150, step=1, value=60)

        run_button_30.click(
            fn=run_inference_and_upload_30,
            inputs=[
                prompt,
                negative_prompt_1,
                negative_prompt_2,
                negative_prompt_3,
                width,
                height,
                guidance_scale,
                num_inference_steps,
                save_consent_checkbox # Pass the checkbox value
            ],
            outputs=[result, expanded_prompt_output],
        )

        run_button_60.click(
            fn=run_inference_and_upload_60,
            inputs=[
                prompt,
                negative_prompt_1,
                negative_prompt_2,
                negative_prompt_3,
                width,
                height,
                guidance_scale,
                num_inference_steps,
                save_consent_checkbox # Pass the checkbox value
            ],
            outputs=[result, expanded_prompt_output],
        )

        run_button_110.click(
            fn=run_inference_and_upload_110,
            inputs=[
                prompt,
                negative_prompt_1,
                negative_prompt_2,
                negative_prompt_3,
                width,
                height,
                guidance_scale,
                num_inference_steps,
                save_consent_checkbox # Pass the checkbox value
            ],
            outputs=[result, expanded_prompt_output],
        )
        
if __name__ == "__main__":
    demo.launch(
        server_name="0.0.0.0",
        server_port=7860,
        share=False,
        show_error=True
    )