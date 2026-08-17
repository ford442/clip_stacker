import os
from typing import List

import torch
from diffusers import StableDiffusionPipeline
from diffusers.pipelines.controlnet import MultiControlNetModel
from transformers import CLIPVisionModelWithProjection, CLIPImageProcessor
from PIL import Image

from .attention_processor import IPAttnProcessor2_0 as IPAttnProcessor, AttnProcessor2_0 as AttnProcessor, CNAttnProcessor2_0 as CNAttnProcessor
from .resampler import Resampler

from .combine import (
    COMBINE_MODES,
    MAX_IP_TOKENS,
    group_concat_slots,
    normalize_weights,
    weighted_mean,
)


class ImageProjModel(torch.nn.Module):
    """Projection Model"""
    def __init__(self, cross_attention_dim=1024, clip_embeddings_dim=1024, clip_extra_context_tokens=4):
        super().__init__()
        
        self.cross_attention_dim = cross_attention_dim
        self.clip_extra_context_tokens = clip_extra_context_tokens
        self.proj = torch.nn.Linear(clip_embeddings_dim, self.clip_extra_context_tokens * cross_attention_dim)
        self.norm = torch.nn.LayerNorm(cross_attention_dim)
        
    def forward(self, image_embeds):
        embeds = image_embeds
        clip_extra_context_tokens = self.proj(embeds).reshape(-1, self.clip_extra_context_tokens, self.cross_attention_dim)
        clip_extra_context_tokens = self.norm(clip_extra_context_tokens)
        return clip_extra_context_tokens

class IPAdapter:
    
    def __init__(self, sd_pipe, image_encoder_path, ip_ckpt, device, num_tokens=4):
        
        self.device = device
        self.image_encoder_path = image_encoder_path
        self.ip_ckpt = ip_ckpt
        self.num_tokens = num_tokens
        
        self.pipe = sd_pipe.to(self.device)
        self.set_ip_adapter()
        
        # load image encoder
        self.image_encoder = CLIPVisionModelWithProjection.from_pretrained(self.image_encoder_path).to(self.device, dtype=torch.bfloat16)
        self.clip_image_processor = CLIPImageProcessor()
        # image proj model
        self.image_proj_model = self.init_proj()
        self.load_ip_adapter()
        
    def init_proj(self):
        image_proj_model = ImageProjModel(
            cross_attention_dim=self.pipe.unet.config.cross_attention_dim,
            clip_embeddings_dim=self.image_encoder.config.projection_dim,
            clip_extra_context_tokens=self.num_tokens,
        ).to(self.device, dtype=torch.bfloat16)
        return image_proj_model
        
    def set_ip_adapter(self):
        unet = self.pipe.unet
        attn_procs = {}
        for name in unet.attn_processors.keys():
            cross_attention_dim = None if name.endswith("attn1.processor") else unet.config.cross_attention_dim
            if name.startswith("mid_block"):
                hidden_size = unet.config.block_out_channels[-1]
            elif name.startswith("up_blocks"):
                block_id = int(name[len("up_blocks.")])
                hidden_size = list(reversed(unet.config.block_out_channels))[block_id]
            elif name.startswith("down_blocks"):
                block_id = int(name[len("down_blocks.")])
                hidden_size = unet.config.block_out_channels[block_id]
            if cross_attention_dim is None:
                attn_procs[name] = AttnProcessor()
            else:
                attn_procs[name] = IPAttnProcessor(hidden_size=hidden_size, cross_attention_dim=cross_attention_dim,
                scale=1.0,num_tokens= self.num_tokens).to(self.device, dtype=torch.bfloat16)
        unet.set_attn_processor(attn_procs)
        if hasattr(self.pipe, "controlnet"):
            if isinstance(self.pipe.controlnet, MultiControlNetModel):
                for controlnet in self.pipe.controlnet.nets:
                    controlnet.set_attn_processor(CNAttnProcessor(num_tokens=self.num_tokens))
            else:
                self.pipe.controlnet.set_attn_processor(CNAttnProcessor(num_tokens=self.num_tokens))

    def update_state_dict(self, state_dict):
        image_proj_dict = {}
        ip_adapter_dict = {}

        for k in state_dict.keys():
            if k.startswith("image_proj_model"):
                image_proj_dict[k.replace("image_proj_model.", "")] = state_dict[k]
            if k.startswith("adapter_modules"):
                ip_adapter_dict[k.replace("adapter_modules.", "")] = state_dict[k]

        dict = {'image_proj': image_proj_dict,
                'ip_adapter' : ip_adapter_dict
                } 
        return dict
    
    def load_ip_adapter(self):
        state_dict = torch.load(self.ip_ckpt, map_location="cpu")
        if "image_proj_model.proj.weight" in state_dict.keys():
            state_dict = self.update_state_dict(state_dict)
        self.image_proj_model.load_state_dict(state_dict["image_proj"])
        ip_layers = torch.nn.ModuleList(self.pipe.unet.attn_processors.values())
        ip_layers.load_state_dict(state_dict["ip_adapter"])
        
    @torch.inference_mode()
    def get_clip_image_embeds(self, pil_image):
        """Raw CLIP image embeddings, before the projection model.

        Blending happens here rather than after `image_proj_model`, whose final
        LayerNorm makes averaging shrink the signal instead of mixing it.
        """
        if isinstance(pil_image, Image.Image):
            pil_image = [pil_image]
        clip_image = self.clip_image_processor(images=pil_image, return_tensors="pt").pixel_values
        return self.image_encoder(clip_image.to(self.device, dtype=torch.bfloat16)).image_embeds

    @torch.inference_mode()
    def get_image_embeds(self, pil_image):
        clip_image_embeds = self.get_clip_image_embeds(pil_image)
        image_prompt_embeds = self.image_proj_model(clip_image_embeds)
        uncond_image_prompt_embeds = self.get_uncond_image_embeds(clip_image_embeds)
        return image_prompt_embeds, uncond_image_prompt_embeds

    @torch.inference_mode()
    def get_uncond_image_embeds(self, clip_image_embeds):
        """The unconditional token set for a given CLIP embedding shape.

        This is `image_proj_model(zeros)`, so it depends only on the shape — it
        is identical for every image and only needs computing once per batch.
        It is deliberately never multiplied by a per-image weight: under CFG the
        two branches have to keep matching magnitudes or `uncond + g*(cond -
        uncond)` gets distorted in a way no user asked for.
        """
        return self.image_proj_model(torch.zeros_like(clip_image_embeds))

    def set_scale(self, scale):
        for attn_processor in self.pipe.unet.attn_processors.values():
            if isinstance(attn_processor, IPAttnProcessor):
                attn_processor.scale = scale

    def set_num_tokens(self, num_tokens):
        """Tell every processor how many trailing tokens are image conditioning.

        'concat' mode hands the UNet N image token sets instead of one, so the
        split point in `IPAttnProcessor.__call__` has to move with it.
        """
        for attn_processor in self.pipe.unet.attn_processors.values():
            if isinstance(attn_processor, IPAttnProcessor):
                attn_processor.num_tokens = num_tokens
        if hasattr(self.pipe, "controlnet"):
            controlnets = (self.pipe.controlnet.nets
                           if isinstance(self.pipe.controlnet, MultiControlNetModel)
                           else [self.pipe.controlnet])
            for controlnet in controlnets:
                for attn_processor in controlnet.attn_processors.values():
                    if isinstance(attn_processor, CNAttnProcessor):
                        attn_processor.num_tokens = num_tokens


    def generate(
        self,
        pil_image,
        prompt=None,
        negative_prompt=None,
        scale=1.0,
        num_samples=4,
        seed=-1,
        guidance_scale=7.5,
        num_inference_steps=30,
        **kwargs,
    ):
        self.set_scale(scale)
        
        if isinstance(pil_image, List):
            num_prompts = len(pil_image)
        else:
            num_prompts = 1
        
        # if isinstance(pil_image, Image.Image):
        #     num_prompts = 1
        # else:
        #     num_prompts = len(pil_image)
        #     print("num promp", num_prompts)
        
        if prompt is None:
            prompt = "best quality, high quality"
        if negative_prompt is None:
            negative_prompt = "monochrome, lowres, bad anatomy, worst quality, low quality"
            
        if not isinstance(prompt, List):
            prompt = [prompt] * num_prompts
        if not isinstance(negative_prompt, List):
            negative_prompt = [negative_prompt] * num_prompts
        
        image_prompt_embeds, uncond_image_prompt_embeds = self.get_image_embeds(pil_image)
        bs_embed, seq_len, _ = image_prompt_embeds.shape
        image_prompt_embeds = image_prompt_embeds.repeat(1, num_samples, 1)
        image_prompt_embeds = image_prompt_embeds.view(bs_embed * num_samples, seq_len, -1)
        uncond_image_prompt_embeds = uncond_image_prompt_embeds.repeat(1, num_samples, 1)
        uncond_image_prompt_embeds = uncond_image_prompt_embeds.view(bs_embed * num_samples, seq_len, -1)

        with torch.inference_mode():
            prompt_embeds = self.pipe._encode_prompt(
                prompt, device=self.device, num_images_per_prompt=num_samples, do_classifier_free_guidance=True, negative_prompt=negative_prompt)
            negative_prompt_embeds_, prompt_embeds_ = prompt_embeds.chunk(2)

            prompt_embeds = torch.cat([prompt_embeds_, image_prompt_embeds], dim=1)
            negative_prompt_embeds = torch.cat([negative_prompt_embeds_, uncond_image_prompt_embeds], dim=1)
            
        generator = torch.Generator(self.device).manual_seed(seed) if seed is not None else None
        images = self.pipe(
            prompt_embeds=prompt_embeds,
            negative_prompt_embeds=negative_prompt_embeds,
            guidance_scale=guidance_scale,
            num_inference_steps=num_inference_steps,
            generator=generator,
            **kwargs,
        ).images
        
        return images
    
class IPAdapterXL(IPAdapter):
    """SDXL"""
    
    def get_scale(self):
        for attn_processor in self.pipe.unet.attn_processors.values():
            if isinstance(attn_processor, IPAttnProcessor):
                print('IP attn_scale:')
                print(attn_processor.scale)
        for attn_processor in self.pipe.unet.attn_processors.values():
            if isinstance(attn_processor, AttnProcessor):
                print('UNET attn_scale:')
                print(attn_processor.scale)
                
    def generate(
        self,
        pil_image_1,
        pil_image_2=None,
        pil_image_3=None,
        pil_image_4=None,
        pil_image_5=None,
        prompt=None,
        negative_prompt=None,
        text_scale=1.0,
        ip_scale=1.0,
        scale_1=1.0,
        scale_2=1.0,
        scale_3=1.0,
        scale_4=1.0,
        scale_5=1.0,
        num_samples=1,
        seed=-1,
        num_inference_steps=30,
        guidance_scale=7.5,
        combine_mode="mean",
        **kwargs,
    ):
        #self.get_scale()
        self.set_scale(ip_scale)

        if combine_mode not in COMBINE_MODES:
            raise ValueError(f"combine_mode must be one of {COMBINE_MODES}, got {combine_mode!r}")

        if isinstance(pil_image_1, Image.Image):
            num_prompts = 1
        else:
            num_prompts = len(pil_image_1)

        if prompt is None:
            prompt = "best quality, high quality"
        if negative_prompt is None:
            negative_prompt = "monochrome, lowres, bad anatomy, worst quality, low quality"
            
        if not isinstance(prompt, List):
            prompt = [prompt] * num_prompts
        if not isinstance(negative_prompt, List):
            negative_prompt = [negative_prompt] * num_prompts
            
        slots = [
            (pil_image_1, scale_1, 'primary'),
            (pil_image_2, scale_2, 'secondary'),
            (pil_image_3, scale_3, 'tertiary'),
            (pil_image_4, scale_4, 'quaternary'),
            (pil_image_5, scale_5, 'quinary'),
        ]

        clip_embeds_list = []
        weights = []
        for pil_image, scale, label in slots:
            if pil_image is None:
                continue
            print(f'Using {label} image.')
            clip_embeds_list.append(self.get_clip_image_embeds(pil_image))
            weights.append(scale)

        if not clip_embeds_list:
            raise ValueError("generate() needs at least one image prompt")

        # Weights average 1.0, so the balance between images is independent of
        # total IP strength — that stays on set_scale(ip_scale) above, applied
        # in the attention processor where the adapter expects it.
        weights = normalize_weights(weights)

        # One uncond token set for the whole batch: image_proj_model(zeros) does
        # not depend on which images were supplied.
        uncond_image_prompt_embeds = self.get_uncond_image_embeds(clip_embeds_list[0])

        if combine_mode == "mean" or len(clip_embeds_list) == 1:
            image_prompt_embeds = self.image_proj_model(weighted_mean(clip_embeds_list, weights))
        else:
            image_prompt_embeds, uncond_image_prompt_embeds = self._concat_image_embeds(
                clip_embeds_list, weights, uncond_image_prompt_embeds)

        print(f'combine_mode={combine_mode} image_prompt_embeds shape:', image_prompt_embeds.shape)

        bs_embed, seq_len, _ = image_prompt_embeds.shape
        image_prompt_embeds = image_prompt_embeds.repeat(1, num_samples, 1)
        image_prompt_embeds = image_prompt_embeds.view(bs_embed * num_samples, seq_len, -1)
        uncond_image_prompt_embeds = uncond_image_prompt_embeds.repeat(1, num_samples, 1)
        uncond_image_prompt_embeds = uncond_image_prompt_embeds.view(bs_embed * num_samples, seq_len, -1)

        # concat mode widened the image token block; every processor has to be
        # told, and told back afterwards so the next mean-mode call still splits
        # encoder_hidden_states at the right position.
        active_num_tokens = image_prompt_embeds.shape[1]
        if active_num_tokens != self.num_tokens:
            self.set_num_tokens(active_num_tokens)
        try:
            with torch.inference_mode():
                prompt_embeds, negative_prompt_embeds, pooled_prompt_embeds, negative_pooled_prompt_embeds = self.pipe.encode_prompt(
                    prompt, num_images_per_prompt=num_samples, do_classifier_free_guidance=True, negative_prompt=negative_prompt)
                prompt_embeds = prompt_embeds * text_scale
                prompt_embeds = torch.cat([prompt_embeds, image_prompt_embeds], dim=1)
                negative_prompt_embeds = torch.cat([negative_prompt_embeds, uncond_image_prompt_embeds], dim=1)

            generator = torch.Generator(self.device).manual_seed(seed) if seed is not None else None

            images = self.pipe(
                prompt_embeds=prompt_embeds,
                negative_prompt_embeds=negative_prompt_embeds,
                pooled_prompt_embeds=pooled_prompt_embeds,
                negative_pooled_prompt_embeds=negative_pooled_prompt_embeds,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=generator,
                **kwargs,
            ).images
        finally:
            if active_num_tokens != self.num_tokens:
                self.set_num_tokens(self.num_tokens)

        return images

    def _concat_image_embeds(self, clip_embeds_list, weights, uncond_image_prompt_embeds):
        """Project each image separately and concatenate the token sets.

        A mean answers "blend these moods"; concatenation lets cross-attention
        pick per-image features spatially, which is what multi-subject
        composition needs. Weights become per-token scaling here rather than
        mixing coefficients.

        Over the token budget, the highest-weighted images keep their own slots
        and the remainder collapse into the last one — a partial mean instead of
        an unbounded attention cost.
        """
        groups, group_weights = group_concat_slots(weights, self.num_tokens)
        if len(groups) < len(clip_embeds_list):
            print(f'concat: {len(clip_embeds_list)} images exceed the {MAX_IP_TOKENS}-token budget, '
                  f'blending all but the top {len(groups) - 1} by weight into one slot.')

        token_sets = []
        for group, weight in zip(groups, group_weights):
            members = [clip_embeds_list[i] for i in group]
            if len(members) == 1:
                clip_embeds = members[0]
            else:
                clip_embeds = weighted_mean(members, normalize_weights([weights[i] for i in group]))
            token_sets.append(self.image_proj_model(clip_embeds) * weight)

        image_prompt_embeds = torch.cat(token_sets, dim=1)
        # Match the conditional's token count with unweighted copies so CFG sees
        # two branches of the same shape and comparable magnitude.
        uncond_image_prompt_embeds = uncond_image_prompt_embeds.repeat(1, len(token_sets), 1)
        return image_prompt_embeds, uncond_image_prompt_embeds
    
    
class IPAdapterPlus(IPAdapter):
    """IP-Adapter with fine-grained features"""
    
    def init_proj(self):
        image_proj_model = Resampler(
            dim=self.pipe.unet.config.cross_attention_dim,
            depth=4,
            dim_head=64,
            heads=12,
            num_queries=self.num_tokens,
            embedding_dim=self.image_encoder.config.hidden_size,
            output_dim=self.pipe.unet.config.cross_attention_dim,
            ff_mult=4
        ).to(self.device, dtype=torch.bfloat16)
        return image_proj_model
    
    @torch.inference_mode()
    def get_image_embeds(self, pil_image):
        if isinstance(pil_image, Image.Image):
            pil_image = [pil_image]
        clip_image = self.clip_image_processor(images=pil_image, return_tensors="pt").pixel_values
        clip_image = clip_image.to(self.device, dtype=torch.bfloat16)
        clip_image_embeds = self.image_encoder(clip_image, output_hidden_states=True).hidden_states[-2]
        image_prompt_embeds = self.image_proj_model(clip_image_embeds)
        uncond_clip_image_embeds = self.image_encoder(torch.zeros_like(clip_image), output_hidden_states=True).hidden_states[-2]
        uncond_image_prompt_embeds = self.image_proj_model(uncond_clip_image_embeds)
        return image_prompt_embeds, uncond_image_prompt_embeds
