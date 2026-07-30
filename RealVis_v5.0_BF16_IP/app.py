#!/usr/bin/env python
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
import spaces
import subprocess

@spaces.GPU(required=True)
def install_flashattn():
    subprocess.run(['sh', './flashattn.sh'])
    
#install_flashattn()


import os

os.environ['PYTORCH_NVML_BASED_CUDA_CHECK'] = '1'
os.environ['TORCH_LINALG_PREFER_CUSOLVER'] = '1'
os.environ['PYTORCH_ALLOC_CONF'] = 'expandable_segments:True,pinned_use_background_threads:True'
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

import contextlib
import functools
import random
import threading
import uuid
import gradio as gr
import numpy as np
from PIL import Image

from diffusers import AutoencoderKL, StableDiffusionXLPipeline, EulerAncestralDiscreteScheduler
from transformers import CLIPTextModelWithProjection, CLIPTextModel
from typing import Tuple
import paramiko
import datetime
from gradio import themes
from image_gen_aux import UpscaleWithModel
from ip_adapter import IPAdapterXL
from huggingface_hub import snapshot_download

FTP_HOST = 'noahcohn.com'
FTP_USER = 'ford442'
FTP_PASS = os.getenv("FTP_PASS")
FTP_DIR = 'img.noahcohn.com/stablediff/'

DESCRIPTIONXX = """
    ## ⚡⚡⚡⚡ REALVISXL V5.0 BF16 IP Adapter ⚡⚡⚡⚡
"""

examples = [

    "Many apples splashed with drops of water within a fancy bowl 4k, hdr  --v 6.0 --style raw",
    "A profile photo of a dog, brown background, shot on Leica M6 --ar 128:85 --v 6.0 --style raw",
]

MAX_IMAGE_SIZE = int(os.getenv("MAX_IMAGE_SIZE", "4096"))

BATCH_SIZE = int(os.getenv("BATCH_SIZE", "1"))

device = torch.device("cuda:0")

style_list = [
    {
        "name": "3840 x 2160",
        "prompt": "hyper-realistic 8K image of {prompt}. ultra-detailed, lifelike, high-resolution, sharp, vibrant colors, photorealistic",
        "negative_prompt": "cartoonish, low resolution, blurry, simplistic, abstract, deformed, ugly",
    },
    {
        "name": "2560 x 1440",
        "prompt": "hyper-realistic 4K image of {prompt}. ultra-detailed, lifelike, high-resolution, sharp, vibrant colors, photorealistic",
        "negative_prompt": "cartoonish, low resolution, blurry, simplistic, abstract, deformed, ugly",
    },
    {
        "name": "HD+",
        "prompt": "hyper-realistic 2K image of {prompt}. ultra-detailed, lifelike, high-resolution, sharp, vibrant colors, photorealistic",
        "negative_prompt": "cartoonish, low resolution, blurry, simplistic, abstract, deformed, ugly",
    },
    {
        "name": "Style Zero",
        "prompt": "{prompt}",
        "negative_prompt": "",
    },
]

styles = {k["name"]: (k["prompt"], k["negative_prompt"]) for k in style_list}
DEFAULT_STYLE_NAME = "Style Zero"
STYLE_NAMES = list(styles.keys())
HF_TOKEN = os.getenv("HF_TOKEN")

## load IP Adapter
repo_id = "ford442/SDXL-IP_ADAPTER"
subfolder = "image_encoder"
subfolder2 = "ip_adapter"
local_repo_path = snapshot_download(repo_id=repo_id, repo_type="model")
local_folder = os.path.join(local_repo_path, subfolder)
local_folder2 = os.path.join(local_repo_path, subfolder2) # Path to the ip_adapter dir
ip_ckpt = os.path.join(local_folder2, "ip-adapter_sdxl_vit-h.bin") # Correct path

upscaler = UpscaleWithModel.from_pretrained("Kim2091/ClearRealityV1").to(torch.device("cuda:0"))


def apply_style(style_name: str, positive: str, negative: str = "") -> Tuple[str, str]:
    if style_name in styles:
        p, n = styles.get(style_name, styles[DEFAULT_STYLE_NAME])
    else:
        p, n = styles[DEFAULT_STYLE_NAME]
    if not negative:
        negative = ""
    return p.replace("{prompt}", positive), n + negative

def load_and_prepare_model():
    #vae = AutoencoderKL.from_pretrained("ford442/sdxl-vae-bf16", safety_checker=None)
    vaeX = AutoencoderKL.from_pretrained("stabilityai/sdxl-vae", safety_checker=None, use_safetensors=False, low_cpu_mem_usage=False, torch_dtype=torch.float32, token=True) #.to(device).to(torch.bfloat16) #.to(device=device, dtype=torch.bfloat16)
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'ford442/RealVisXL_V5.0_BF16',
       #'ford442/Juggernaut-XI-v11-fp32',
      #   'SG161222/RealVisXL_V5.0',
        #'John6666/uber-realistic-porn-merge-xl-urpmxl-v3-sdxl',
        #torch_dtype=torch.bfloat16,
        add_watermarker=False,
       # custom_pipeline="lpw_stable_diffusion_xl",
        use_safetensors=True,
        token=HF_TOKEN,
        text_encoder=None,
        text_encoder_2=None,
        vae=None,
    )

    pipe.vae=vaeX
    pipe.to(device=device, dtype=torch.bfloat16)
    pipe.vae.set_default_attn_processor()
    print(f'Pipeline: ')
    print(f'image_processor: {pipe.image_processor}')
    print(f'init noise scale: {pipe.scheduler.init_noise_sigma}')
    pipe.watermark=None
    pipe.safety_checker=None
    return pipe

# Preload and compile both models
pipe = load_and_prepare_model()
ip_model = IPAdapterXL(pipe, local_folder, ip_ckpt, device)
text_encoder=CLIPTextModel.from_pretrained('ford442/RealVisXL_V5.0_BF16', subfolder='text_encoder',token=True).to(device=device, dtype=torch.bfloat16)
text_encoder_2=CLIPTextModelWithProjection.from_pretrained('ford442/RealVisXL_V5.0_BF16', subfolder='text_encoder_2',token=True).to(device=device, dtype=torch.bfloat16)

MAX_SEED = np.iinfo(np.int32).max

neg_prompt_2 = " 'non-photorealistic':1.5, 'unrealistic skin','unattractive face':1.3, 'low quality':1.1, ('dull color scheme', 'dull colors', 'digital noise':1.2),'amateurish', 'poorly drawn face':1.3, 'poorly drawn', 'distorted face', 'low resolution', 'simplistic' "

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

def save_image(img):
    unique_name = str(uuid.uuid4()) + ".png"
    img.save(unique_name,optimize=False,compress_level=0)
    return unique_name

def uploadNote(prompt,num_inference_steps,guidance_scale,timestamp):
    filename= f'IP_{timestamp}.txt'
    with open(filename, "w") as f:
        f.write(f"Realvis 5.0 IP Adapter \n")
        f.write(f"Date/time: {timestamp} \n")
        f.write(f"Prompt: {prompt} \n")
        f.write(f"Steps: {num_inference_steps} \n")
        f.write(f"Guidance Scale: {guidance_scale} \n")
        f.write(f"SPACE SETUP: \n")
        f.write(f"Use Model Dtype: no \n")
        f.write(f"Model Scheduler: Euler_a all_custom before cuda \n")
        f.write(f"Model VAE: sdxl-vae to bfloat safetensor=false before cuda then attn_proc / scale factor 8 \n")
        f.write(f"Model UNET: ford442/RealVisXL_V5.0_BF16 \n")
    return filename

@contextlib.contextmanager
def matmul_precision(precision):
    """Scope a global torch setting so run N behaves like run 1."""
    previous = torch.get_float32_matmul_precision()
    torch.set_float32_matmul_precision(precision)
    try:
        yield
    finally:
        torch.set_float32_matmul_precision(previous)


def open_image_prompt(path):
    """Load an uploaded image prompt, or None if the slot is empty.

    No pre-resize: CLIPImageProcessor resizes to 224 regardless, so scaling to
    the generation size here would only cost time — and at large widths would
    mean upsampling a bitmap purely to throw the extra pixels away.
    """
    if path is None:
        return None
    return Image.open(path).convert('RGB')


def upload_in_background(*filenames):
    """Push results to FTP off the GPU-held path.

    Uploading inside @spaces.GPU burns ZeroGPU quota on network wait for no
    benefit; the files are already on disk by this point.
    """
    for filename in filenames:
        threading.Thread(target=upload_to_ftp, args=(filename,), daemon=True).start()


def run_generation(
    prompt: str = "",
    negative_prompt: str = "",
    use_negative_prompt: bool = False,
    style_selection: str = "",
    width: int = 768,
    height: int = 768,
    guidance_scale: float = 4,
    num_inference_steps: int = 125,
    latent_file = None,
    latent_file_2 = None,
    latent_file_3 = None,
    latent_file_4 = None,
    latent_file_5 = None,
    text_scale: float = 1.0,
    ip_scale: float = 1.0,
    latent_file_1_scale: float = 1.0,
    latent_file_2_scale: float = 1.0,
    latent_file_3_scale: float = 1.0,
    latent_file_4_scale: float = 1.0,
    latent_file_5_scale: float = 1.0,
    combine_mode: str = "mean",
    samples=1,
    progress=gr.Progress(track_tqdm=True)
):
    """The one generate implementation. The @spaces.GPU wrappers below differ
    only in their duration budget."""
    if latent_file is None:
        print('-- IMAGE REQUIRED --')
        return []

    pipe.text_encoder = text_encoder
    pipe.text_encoder_2 = text_encoder_2
    seed = random.randint(0, MAX_SEED)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    sd_image_a = open_image_prompt(latent_file)
    sd_image_b = open_image_prompt(latent_file_2)
    sd_image_c = open_image_prompt(latent_file_3)
    sd_image_d = open_image_prompt(latent_file_4)
    sd_image_e = open_image_prompt(latent_file_5)

    # The checkbox governs the user's negative prompt box; the quality style's
    # own negative is part of the preset and stays either way.
    styled_prompt, styled_negative_prompt = apply_style(
        style_selection, prompt, negative_prompt if use_negative_prompt else "")

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f'rv_IP_{timestamp}.png'
    print("-- using image file --")
    print('-- generating image --')
    sd_image = ip_model.generate(
            pil_image_1=sd_image_a,
            pil_image_2=sd_image_b,
            pil_image_3=sd_image_c,
            pil_image_4=sd_image_d,
            pil_image_5=sd_image_e,
            prompt=styled_prompt,
            negative_prompt=styled_negative_prompt,
            width=width,
            height=height,
            text_scale=text_scale,
            ip_scale=ip_scale,
            scale_1=latent_file_1_scale,
            scale_2=latent_file_2_scale,
            scale_3=latent_file_3_scale,
            scale_4=latent_file_4_scale,
            scale_5=latent_file_5_scale,
            combine_mode=combine_mode,
            num_samples=samples,
            seed=seed,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
    )
    sd_image[0].save(filename, optimize=False, compress_level=0)
    note_filename = uploadNote(prompt, num_inference_steps, guidance_scale, timestamp)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    # UpscaleWithModel returns a single image regardless of input, so feeding it
    # the whole sample list would upscale every sample and discard all but the
    # first. Only sd_image[0] is saved and returned.
    with matmul_precision("medium"), torch.no_grad():
        upscale = upscaler(sd_image[0], tiling=True, tile_width=256, tile_height=256)
    downscale1 = upscale.resize((upscale.width // 4, upscale.height // 4), Image.LANCZOS)
    downscale_path = f"rvIP_upscale_{timestamp}.png"
    downscale1.save(downscale_path, optimize=False, compress_level=0)

    upload_in_background(filename, note_filename, downscale_path)
    return [save_image(downscale1)]


# functools.wraps keeps run_generation's signature visible through the wrapper,
# so Gradio still finds the gr.Progress parameter and injects the real tracker.
@spaces.GPU(duration=40)
@functools.wraps(run_generation)
def generate_30(*args, **kwargs):
    return run_generation(*args, **kwargs)


@spaces.GPU(duration=70)
@functools.wraps(run_generation)
def generate_60(*args, **kwargs):
    return run_generation(*args, **kwargs)


@spaces.GPU(duration=100)
@functools.wraps(run_generation)
def generate_90(*args, **kwargs):
    return run_generation(*args, **kwargs)


def load_predefined_images1():
    predefined_images1 = [
        "assets/7.png",
        "assets/8.png",
        "assets/9.png",
        "assets/1.png",
        "assets/2.png",
        "assets/3.png",
        "assets/4.png",
        "assets/5.png",
        "assets/6.png",
    ]
    return predefined_images1

css = '''
#col-container {
    margin: 0 auto;
    max-width: 640px;
}
h1{text-align:center}
footer {
    visibility: hidden
}
body {
  background-color: green;
}
'''

with gr.Blocks(theme=gr.themes.Origin(),css=css) as demo:
    gr.Markdown(DESCRIPTIONXX)
    with gr.Row():
        prompt = gr.Text(
            label="Prompt",
            show_label=False,
            max_lines=1,
            placeholder="Enter your prompt",
            container=False,
        )
        text_strength =  gr.Slider(
            label="Text Strength",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
        )
        run_button_30 = gr.Button("Run 30 Seconds", scale=0)
        run_button_60 = gr.Button("Run 60 Seconds", scale=0)
        run_button_90 = gr.Button("Run 90 Seconds", scale=0)
    result = gr.Gallery(label="Result", columns=1, show_label=False)
    ip_strength =  gr.Slider(
            label="Image Strength",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
    )
    with gr.Row():
        with gr.Column():
            latent_file = gr.Image(label="Image Prompt (Required)", sources=["upload", "clipboard"], type="filepath")
        file_1_strength =  gr.Slider(
            label="Img 1 %",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
        )
        with gr.Column():
            latent_file_2 = gr.Image(label="Image Prompt 2 (Optional)", sources=["upload", "clipboard"], type="filepath")
        file_2_strength =  gr.Slider(
            label="Img 2 %",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
        )
        with gr.Column():
            latent_file_3 = gr.Image(label="Image Prompt 3 (Optional)", sources=["upload", "clipboard"], type="filepath")
        file_3_strength =  gr.Slider(
            label="Img 3 %",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
        )
        with gr.Column():
            latent_file_4 = gr.Image(label="Image Prompt 4 (Optional)", sources=["upload", "clipboard"], type="filepath")
        file_4_strength =  gr.Slider(
            label="Img 4 %",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
        )
        with gr.Column():
            latent_file_5 = gr.Image(label="Image Prompt 5 (Optional)", sources=["upload", "clipboard"], type="filepath")
        file_5_strength =  gr.Slider(
            label="Img 5 %",
            minimum=0.0,
            maximum=16.0,
            step=0.01,
            value=1.0,
        )
        combine_mode = gr.Radio(
            show_label=True,
            container=True,
            interactive=True,
            choices=[
                ("Mean (blend styles)", "mean"),
                ("Concat (combine subjects)", "concat"),
            ],
            value="mean",
            label="Multi-Image Combine Mode",
            info="Mean blends the images into one conditioning. Concat gives each "
                 "image its own tokens so attention can pick between them — better "
                 "for combining distinct subjects, slightly slower.",
        )
        style_selection = gr.Radio(
            show_label=True,
            container=True,
            interactive=True,
            choices=STYLE_NAMES,
            value=DEFAULT_STYLE_NAME,
            label="Quality Style",
        )
        with gr.Row():
            with gr.Column(scale=1):
                use_negative_prompt = gr.Checkbox(label="Use negative prompt", value=True)
                negative_prompt = gr.Text(
                    label="Negative prompt",
                    max_lines=5,
                    lines=4,
                    placeholder="Enter a negative prompt",
                    value="('deformed', 'distorted', 'disfigured':1.3),'not photorealistic':1.5, 'poorly drawn', 'bad anatomy', 'wrong anatomy', 'extra limb', 'missing limb', 'floating limbs', 'poorly drawn hands', 'poorly drawn feet', 'poorly drawn face':1.3, 'out of frame', 'extra limbs', 'bad anatomy', 'bad art', 'beginner',  'distorted face','amateur'",
                    visible=True,
                )
        samples = gr.Slider(
            label="Samples",
            minimum=0,
            maximum=20,
            step=1,
            value=1,
        )
        randomize_seed = gr.Checkbox(label="Randomize seed", value=True)
        with gr.Row():
            width = gr.Slider(
                label="Width",
                minimum=448,
                maximum=MAX_IMAGE_SIZE,
                step=64,
                value=1024,
            )
            height = gr.Slider(
                label="Height",
                minimum=448,
                maximum=MAX_IMAGE_SIZE,
                step=64,
                value=1024,
            )
        with gr.Row():
            guidance_scale = gr.Slider(
                label="Guidance Scale",
                minimum=0.1,
                maximum=30,
                step=0.1,
                value=3.75,
            )
            num_inference_steps = gr.Slider(
                label="Number of inference steps",
                minimum=10,
                maximum=1000,
                step=10,
                value=200,
            )

    gr.Examples(
        examples=examples,
        inputs=prompt,
        cache_examples=False
    )

    use_negative_prompt.change(
        fn=lambda x: gr.update(visible=x),
        inputs=use_negative_prompt,
        outputs=negative_prompt,
        api_name=False,
    )


    gr.on(
        triggers=[
            run_button_30.click,
        ],
      #  api_name="generate",  # Add this line
        fn=generate_30,
        inputs=[
            prompt,
            negative_prompt,
            use_negative_prompt,
            style_selection,
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
            ip_strength,
            file_1_strength,
            file_2_strength,
            file_3_strength,
            file_4_strength,
            file_5_strength,
            combine_mode,
            samples,
        ],
        outputs=[result],
    )

    gr.on(
        triggers=[
            run_button_60.click,
        ],
      #  api_name="generate",  # Add this line
        fn=generate_60,
        inputs=[
            prompt,
            negative_prompt,
            use_negative_prompt,
            style_selection,
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
            ip_strength,
            file_1_strength,
            file_2_strength,
            file_3_strength,
            file_4_strength,
            file_5_strength,
            combine_mode,
            samples,
        ],
        outputs=[result],
    )

    gr.on(
        triggers=[
            run_button_90.click,
        ],
      #  api_name="generate",  # Add this line
        fn=generate_90,
        inputs=[
            prompt,
            negative_prompt,
            use_negative_prompt,
            style_selection,
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
            ip_strength,
            file_1_strength,
            file_2_strength,
            file_3_strength,
            file_4_strength,
            file_5_strength,
            combine_mode,
            samples,
        ],
        outputs=[result],
    )

    gr.Markdown("### REALVISXL V5.0")
    predefined_gallery = gr.Gallery(label="REALVISXL V5.0", columns=3, show_label=False, value=load_predefined_images1())

    #gr.Markdown("### LIGHTNING V5.0")
    #predefined_gallery = gr.Gallery(label="LIGHTNING V5.0", columns=3, show_label=False, value=load_predefined_images())

    gr.Markdown(
    """
    <div style="text-align: justify;">
    ⚡Models used in the playground <a href="https://huggingface.co/SG161222/RealVisXL_V5.0">[REALVISXL V5.0]</a>, <a href="https://huggingface.co/SG161222/RealVisXL_V5.0_Lightning">[REALVISXL V5.0 LIGHTNING]</a> for image generation. Stable Diffusion XL piped (SDXL) model HF. This is the demo space for generating images using the Stable Diffusion XL models, with multiple different variants available.
    </div>
    """)

    gr.Markdown(
    """
    <div style="text-align: justify;">
    ⚡This is the demo space for generating images using Stable Diffusion XL with quality styles, different models, and types. Try the sample prompts to generate higher quality images. Try the sample prompts for generating higher quality images.
    <a href='https://huggingface.co/spaces/prithivMLmods/Top-Prompt-Collection' target='_blank'>Try prompts</a>.
    </div>
    """)

    gr.Markdown(
    """
    <div style="text-align: justify;">
    ⚠️ Users are accountable for the content they generate and are responsible for ensuring it meets appropriate ethical standards.
    </div>
    """)

def text_generation(input_text, seed):
    full_prompt = "Text Generator Application by ecarbo"
    return full_prompt

title = "Text Generator Demo GPT-Neo"
description = "Text Generator Application by ecarbo"

if __name__ == "__main__":
    demo_interface = demo.queue(max_size=50)  # Remove .launch() here
    text_gen_interface = gr.Interface(
        fn=text_generation,
        inputs=[
            gr.Textbox(lines=1, label="Expand the following prompt to be more detailed and descriptive for image generation: "),
            gr.Number(value=10, label="Enter seed number")
        ],
        outputs=gr.Textbox(label="Text Generated"),
        title=title,
        description=description,
    )
    combined_interface = gr.TabbedInterface([demo_interface, text_gen_interface], ["Image Generation", "Text Generation"])
    combined_interface.launch(show_api=False)