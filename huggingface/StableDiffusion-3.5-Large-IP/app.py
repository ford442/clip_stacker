import spaces
import gradio as gr
import numpy as np
import random
import torch
from PIL import Image
import re
import paramiko
import urllib
import time
import os
import datetime
import gc

from models.transformer_sd3 import SD3Transformer2DModel
#from diffusers import StableDiffusion3Pipeline
from transformers import CLIPTextModelWithProjection, T5EncoderModel
from transformers import CLIPTokenizer, T5TokenizerFast
from diffusers import AutoencoderKL
from pipeline_stable_diffusion_3_ipa import StableDiffusion3Pipeline

from image_gen_aux import UpscaleWithModel
from huggingface_hub import hf_hub_download

from ip_combine import SIGLIP_IMAGE_ENCODER

FTP_HOST = '1ink.us'
FTP_USER = 'ford442'
FTP_PASS = os.getenv("FTP_PASS")
FTP_DIR = '1ink.us/stable_diff/'

torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
torch.backends.cudnn.allow_tf32 = False
torch.backends.cudnn.deterministic = False
torch.backends.cudnn.benchmark = False
#torch.backends.cuda.preferred_blas_library="cublas"
#torch.backends.cuda.preferred_linalg_library="cusolver"

hftoken = os.getenv("HF_TOKEN") 

ipadapter_path = hf_hub_download(repo_id="InstantX/SD3.5-Large-IP-Adapter", filename="ip-adapter.bin")
model_path = 'ford442/stable-diffusion-3.5-large-bf16'
ULTRAREAL_LORA_REPO = "ford442/sdxl-vae-bf16"
ULTRAREAL_LORA_WEIGHT = "LoRA/UltraReal.safetensors"
_ultrareal_loaded = False

def upload_to_ftp(filename):
    try:
        transport = paramiko.Transport((FTP_HOST, 22))
        destination_path=FTP_DIR+filename
        transport.connect(username = FTP_USER, password = FTP_PASS)
        sftp = paramiko.SFTPClient.from_transport(transport)
        sftp.put(filename, destination_path)
        sftp.close()
        transport.close()
        print(f"Uploaded {filename} to FTP server")
    except Exception as e:
        print(f"FTP upload error: {e}")

device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
torch_dtype = torch.bfloat16

transformer = SD3Transformer2DModel.from_pretrained(
    model_path, subfolder="transformer" #, torch_dtype=torch.bfloat16
)

vaeX=AutoencoderKL.from_pretrained("ford442/stable-diffusion-3.5-large-fp32", safety_checker=None, use_safetensors=True, low_cpu_mem_usage=False, subfolder='vae', torch_dtype=torch.float32, token=True)

pipe = StableDiffusion3Pipeline.from_pretrained(
    #"stabilityai  #  stable-diffusion-3.5-large",
    "ford442/stable-diffusion-3.5-large-bf16",
     #scheduler = FlowMatchHeunDiscreteScheduler.from_pretrained('ford442/stable-diffusion-3.5-large-bf16', subfolder='scheduler',token=True),
    text_encoder=None, #CLIPTextModelWithProjection.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='text_encoder', token=True),
    text_encoder_2=None, #CLIPTextModelWithProjection.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='text_encoder_2',token=True),
    text_encoder_3=None, #T5EncoderModel.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='text_encoder_3',token=True),
    #tokenizer=CLIPTokenizer.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", add_prefix_space=True, subfolder="tokenizer", token=True),
    #tokenizer_2=CLIPTokenizer.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", add_prefix_space=True, subfolder="tokenizer_2", token=True),
    tokenizer_3=T5TokenizerFast.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", use_fast=True, subfolder="tokenizer_3", token=True),
    #torch_dtype=torch.bfloat16,
    transformer=transformer,
    vae=None
    #use_safetensors=False,
)

pipe.to(device=device, dtype=torch.bfloat16)

#pipe.to(device)
pipe.vae=vaeX.to(device)
text_encoder=CLIPTextModelWithProjection.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='text_encoder', token=True).to(device=device, dtype=torch.bfloat16)
text_encoder_2=CLIPTextModelWithProjection.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='text_encoder_2',token=True).to(device=device, dtype=torch.bfloat16)
text_encoder_3=T5EncoderModel.from_pretrained("ford442/stable-diffusion-3.5-large-bf16", subfolder='text_encoder_3',token=True).to(device=device, dtype=torch.bfloat16)

upscaler_2 = UpscaleWithModel.from_pretrained("Kim2091/ClearRealityV1").to(torch.device("cuda:0"))

MAX_SEED = np.iinfo(np.int32).max
MAX_IMAGE_SIZE = 4096

@spaces.GPU(duration=80)
def infer(
    prompt,
    negative_prompt_1,
    negative_prompt_2,
    negative_prompt_3,
    width,
    height,
    guidance_scale,
    num_inference_steps,
    latent_file = gr.File(),  # Add latents file input
    latent_file_2 = gr.File(),  # Add latents file input
    latent_file_3 = gr.File(),  # Add latents file input
    latent_file_4 = gr.File(),  # Add latents file input
    latent_file_5 = gr.File(),  # Add latents file input
    text_scale: float = 1.0,
    ip_scale: float = 0.5,
    latent_file_1_scale: float = 1.0,
    latent_file_2_scale: float = 1.0,
    latent_file_3_scale: float = 1.0,
    latent_file_4_scale: float = 1.0,
    latent_file_5_scale: float = 1.0,
    image_encoder_path=None,
    combine_mode: str = "concat",
    lora_scale: float = 1.0,
    progress=gr.Progress(track_tqdm=True),
):
    global _ultrareal_loaded
    pipe.text_encoder=text_encoder
    pipe.text_encoder_2=text_encoder_2
    pipe.text_encoder_3=text_encoder_3
    # Load InstantX processors once. Re-running every request rebuilt the
    # attention processors and (if LoRA is on) wasted the ZeroGPU window.
    pipe.ensure_ipadapter(
        ip_adapter_path=ipadapter_path,
        image_encoder_path=image_encoder_path or SIGLIP_IMAGE_ENCODER,
        nb_token=64,
    )
    # UltraReal lives on the same Attention linears the IP processor still
    # calls (to_q/to_k/to_v/to_out). IP-only layers (to_k_ip/to_v_ip) stay
    # un-adapted. Load after the IP processors exist; PEFT wraps the linears.
    if not _ultrareal_loaded:
        try:
            pipe.load_lora_weights(ULTRAREAL_LORA_REPO, weight_name=ULTRAREAL_LORA_WEIGHT)
            _ultrareal_loaded = True
            print("-- loaded UltraReal LoRA --")
        except Exception as e:
            print(f"-- UltraReal LoRA not loaded: {e} --")
    if _ultrareal_loaded:
        # Strength is applied per step via joint_attention_kwargs["scale"]
        # (PEFT). Do not also set_adapters(weight=...) or the two multiply.
        if lora_scale and lora_scale > 0:
            pipe.enable_lora()
        else:
            pipe.disable_lora()
    upscaler_2.to(torch.device('cpu'))
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch.set_float32_matmul_precision("highest")
    seed = random.randint(0, MAX_SEED)
    generator = torch.Generator(device='cuda').manual_seed(seed)
    enhanced_prompt = prompt
    if latent_file:
        sd_image_a = Image.open(latent_file.name).convert('RGB')
        print("-- using image file --")
        sd_image_b = Image.open(latent_file_2.name).convert('RGB') if latent_file_2 is not None else None
        sd_image_c = Image.open(latent_file_3.name).convert('RGB') if latent_file_3 is not None else None
        sd_image_d = Image.open(latent_file_4.name).convert('RGB') if latent_file_4 is not None else None
        sd_image_e = Image.open(latent_file_5.name).convert('RGB') if latent_file_5 is not None else None
        print('-- generating image --')
        sd_image = pipe(
            width=width,
            height=height,
            prompt=enhanced_prompt,
            prompt_2=enhanced_prompt,
            prompt_3=enhanced_prompt,
            negative_prompt=negative_prompt_1,
            negative_prompt_2=negative_prompt_2,
            negative_prompt_3=negative_prompt_3,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            generator=generator,
            max_sequence_length=512,
            clip_image=sd_image_a,
            clip_image_2=sd_image_b,
            clip_image_3=sd_image_c,
            clip_image_4=sd_image_d,
            clip_image_5=sd_image_e,
            text_scale=text_scale,
            ipadapter_scale=ip_scale,
            scale_1=latent_file_1_scale,
            scale_2=latent_file_2_scale,
            scale_3=latent_file_3_scale,
            scale_4=latent_file_4_scale,
            scale_5=latent_file_5_scale,
            combine_mode=combine_mode,
            lora_scale=lora_scale if _ultrareal_loaded else 0.0,
        ).images[0]
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        rv_path = f"sd35IP_{timestamp}.png"
        sd_image.save(rv_path,optimize=False,compress_level=0)
        upload_to_ftp(rv_path)
        upscaler_2.to(torch.device('cuda'))
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        with torch.no_grad():
            upscale2 = upscaler_2(sd_image, tiling=True, tile_width=256, tile_height=256)
        print('-- got upscaled image --')
        downscale2 = upscale2.resize((upscale2.width // 4, upscale2.height // 4),Image.LANCZOS)
        upscale_path = f"sd35l_upscale_{seed}.png"
        downscale2.save(upscale_path,optimize=False,compress_level=0)
        upload_to_ftp(upscale_path)
    else:
        raise gr.Error("At least one input image is required.")
    return sd_image, enhanced_prompt

examples = [
    "Astronaut in a jungle, cold color palette, muted colors, detailed, 8k",
    "An astronaut riding a green horse",
    "A delicious ceviche cheesecake slice",
]

css = """
#col-container {
    margin: 0 auto;
    max-width: 640px;
}
body{
  background-color: blue;
}
"""

with gr.Blocks(theme=gr.themes.Origin(),css=css) as demo:
    with gr.Column(elem_id="col-container"):
        gr.Markdown(" # StableDiffusion 3.5 Large — IP-Adapter + UltraReal LoRA")
        expanded_prompt_output = gr.Textbox(label="Prompt", lines=5) 
        with gr.Row():
            prompt = gr.Text(
                label="Prompt",
                show_label=False,
                max_lines=1,
                placeholder="Enter your prompt",
                container=False,
            )
            text_strength =  gr.Slider(
                label="Text Scale",
                minimum=0.0,
                maximum=4.0,
                step=0.01,
                value=1.0,
            ) 
            run_button = gr.Button("Run", scale=0, variant="primary")
            result = gr.Image(label="Result", show_label=False)
        with gr.Accordion("Advanced Settings", open=True):
            with gr.Row():
                latent_file = gr.File(label="Image Prompt (Required)")
                file_1_strength =  gr.Slider(
                    label="Img 1 Scale",
                    minimum=0.0,
                    maximum=16.0,
                    step=0.01,
                    value=1.0,
                )
                latent_file_2 = gr.File(label="Image Prompt 2 (Optional)")
                file_2_strength =  gr.Slider(
                    label="Img 2 Scale",
                    minimum=0.0,
                    maximum=16.0,
                    step=0.01,
                    value=1.0,
                )
                latent_file_3 = gr.File(label="Image Prompt 3 (Optional)")
                file_3_strength =  gr.Slider(
                    label="Img 3 Scale",
                    minimum=0.0,
                    maximum=16.0,
                    step=0.01,
                    value=1.0,
                )
                latent_file_4 = gr.File(label="Image Prompt 4 (Optional)")
                file_4_strength =  gr.Slider(
                    label="Img 4 Scale",
                    minimum=0.0,
                    maximum=16.0,
                    step=0.01,
                    value=1.0,
                    )
                latent_file_5 = gr.File(label="Image Prompt 5 (Optional)")
                file_5_strength =  gr.Slider(
                    label="Img 5 Scale",
                    minimum=0.0,
                    maximum=16.0,
                    step=0.01,
                    value=1.0,
                )
                image_encoder_path = gr.Dropdown(
                    [SIGLIP_IMAGE_ENCODER, "jancuhel/google-siglip-so400m-patch14-384-img-text-relevancy"],
                    value=SIGLIP_IMAGE_ENCODER,
                    label="SigLIP encoder (InstantX was trained on google/siglip-so400m-patch14-384)",
                )
                combine_mode = gr.Dropdown(
                    ["concat", "mean"],
                    value="concat",
                    label="Multi-image combine (concat = keep each image's tokens; mean = blend moods)",
                )
                ip_scale = gr.Slider(
                    label="Overall Image Scale",
                    minimum=0.0,
                    maximum=2.0,
                    step=0.01,
                    value=0.5,
                )
                lora_scale = gr.Slider(
                    label="UltraReal LoRA scale (0 = off)",
                    minimum=0.0,
                    maximum=1.5,
                    step=0.01,
                    value=0.8,
                )            
                negative_prompt_1 = gr.Text(
                    label="Negative prompt 1",
                    max_lines=1,
                    placeholder="Enter a negative prompt",
                    visible=True,
                    value="bad anatomy, poorly drawn hands, distorted face, blurry, out of frame, low resolution, grainy, pixelated, disfigured, mutated, extra limbs, bad composition"
                )
                negative_prompt_2 = gr.Text(
                    label="Negative prompt 2",
                    max_lines=1,
                    placeholder="Enter a second negative prompt",
                    visible=True,
                    value="unrealistic, cartoon, anime, sketch, painting, drawing, illustration, graphic, digital art, render, 3d, blurry, deformed, disfigured, poorly drawn, bad anatomy, mutated, extra limbs, ugly, out of frame, bad composition, low resolution, grainy, pixelated, noisy, oversaturated, undersaturated, (worst quality, low quality:1.3), (bad hands, missing fingers:1.2)"
                )
                negative_prompt_3 = gr.Text(
                    label="Negative prompt 3",
                    max_lines=1,
                    placeholder="Enter a third negative prompt",
                    visible=True,
                    value="(worst quality, low quality:1.3), (bad anatomy, bad hands, missing fingers, extra digit, fewer digits:1.2), (blurry:1.1), cropped, watermark, text, signature, logo, jpeg artifacts, (ugly, deformed, disfigured:1.2), (poorly drawn:1.2), mutated, extra limbs, (bad proportions, gross proportions:1.2), (malformed limbs, missing arms, missing legs, extra arms, extra legs:1.2), (fused fingers, too many fingers, long neck:1.2), (unnatural body, unnatural pose:1.1), out of frame, (bad composition, poorly composed:1.1), (oversaturated, undersaturated:1.1), (grainy, pixelated:1.1), (low resolution, noisy:1.1), (unrealistic, distorted:1.1), (extra fingers, mutated hands, poorly drawn hands, bad hands:1.3), (missing fingers:1.3)"
                )
            with gr.Row():
                width = gr.Slider(
                    label="Width",
                    minimum=256,
                    maximum=MAX_IMAGE_SIZE,
                    step=32,
                    value=768, 
                )
                height = gr.Slider(
                    label="Height",
                    minimum=256,
                    maximum=MAX_IMAGE_SIZE,
                    step=32,
                    value=768, 
                )
                guidance_scale = gr.Slider(
                    label="Guidance scale",
                    minimum=0.0,
                    maximum=30.0,
                    step=0.1,
                    value=4.2,
                )
                num_inference_steps = gr.Slider(
                    label="Number of inference steps",
                    minimum=1,
                    maximum=500,
                    step=1,
                    value=50, 
                )
            gr.Examples(examples=examples, inputs=[prompt])
        gr.on(
        triggers=[run_button.click, prompt.submit],
        fn=infer,
        inputs=[
            prompt,
            negative_prompt_1,
            negative_prompt_2,
            negative_prompt_3,
            width,
            height,
            guidance_scale,
            num_inference_steps,
            latent_file,
            latent_file_2,
            latent_file_3,
            latent_file_4,
            latent_file_5,  
            text_strength,
            ip_scale,
            file_1_strength,
            file_2_strength,
            file_3_strength,
            file_4_strength,
            file_5_strength,
            image_encoder_path,
            combine_mode,
            lora_scale,
        ],
        outputs=[result, expanded_prompt_output],
        )

if __name__ == "__main__":
    demo.launch()