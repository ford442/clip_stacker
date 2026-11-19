# Gradio demo for the MiniMax Music 3 diffusers port. Inputs follow the official prompt guide:
# a Structured Caption (Global Metadata / Vocal Details / Arrangement) + tagged lyrics.
import json
import os
import random
import time

import gradio as gr
import numpy as np
import spaces
import torch
from huggingface_hub import snapshot_download

from diffusers import ModularPipeline
from diffusers.models.modeling_outputs import Transformer2DModelOutput

PIPE = ModularPipeline.from_pretrained("MiniMaxAI/MiniMax-Music3")
PIPE.load_components(dtype=torch.bfloat16)
PIPE.to("cuda")


def _encode_prompt(caption, lyrics, device):
    # the modular TextEncoderStep's logic, needed here because the app drives the AR stage manually
    import diffusers.modular_pipelines.minimax_music3.encoders as P

    text = (
        f"{P._IM_START}{P._CAPTION_START}{P._clean_caption(caption)}{P._CAPTION_END}"
        f"{P._LYRICS_START}{P._normalize_lyrics(lyrics)}{P._LYRICS_END}{P._IM_END}{P._AUDIO_START}"
    )
    input_ids = PIPE.tokenizer(text, return_tensors="pt")["input_ids"]
    if input_ids.shape[1] > P._MAX_PROMPT_TOKENS:
        raise gr.Error(f"The assembled prompt has {input_ids.shape[1]} tokens; the maximum is {P._MAX_PROMPT_TOKENS}.")
    unconditional_ids = input_ids.clone()
    unconditional_ids[:, 1:-2] = P._AUDIO_CFG_TOKEN_ID
    return torch.cat((input_ids, unconditional_ids), dim=0).to(device)

# AoTI-compiled kernels (RTX Pro 6000 variant). The transformer artifact is static over full 689-latent
# chunks; the once-per-song final short chunk falls back to eager.
_AOTI_DIR = snapshot_download("diffusers-internal-dev/MiniMax-Music3-aoti")
_eager_transformer_forward = PIPE.transformer.forward
spaces.aoti_load_from_package_dir(PIPE.transformer, f"{_AOTI_DIR}/transformer")
_aoti_transformer_forward = PIPE.transformer.forward


def _guarded_transformer_forward(hidden_states, timestep, encoder_hidden_states, return_dict=True):
    if hidden_states.shape[-1] == 689:
        out = _aoti_transformer_forward(hidden_states, timestep, encoder_hidden_states)
        if not isinstance(out, Transformer2DModelOutput):
            out = Transformer2DModelOutput(sample=out[0] if isinstance(out, (tuple, list)) else out)
        return out
    return _eager_transformer_forward(hidden_states, timestep, encoder_hidden_states, return_dict=return_dict)


PIPE.transformer.forward = _guarded_transformer_forward
spaces.aoti_load_from_package_dir(PIPE.vocoder, f"{_AOTI_DIR}/vocoder")

# AoTI LM decode step, one artifact per StaticCache bucket; eager per-frame glue. Eager full-sequence
# prefill writes directly into each artifact's cache buffers (aliased StaticCache), matching eager exactly.
import copy as _copy

import torch.nn as _nn
from transformers import StaticCache
from transformers.integrations.executorch import TorchExportableModuleForDecoderOnlyLM

_LM = PIPE.language_model
_BUCKETS = [1024, 2048, 4096, 8192]
_STOP_CHECK_INTERVAL = 25

_lm_headless = _copy.copy(_LM)
_lm_headless._modules = dict(_LM._modules)  # nn.Module shallow copies share _modules
_lm_headless.lm_head = _nn.Identity()
_lm_headless.generation_config = _copy.deepcopy(_LM.generation_config)
_lm_headless.generation_config.cache_implementation = "static"

_LM_STEPS = {}
for _bucket in _BUCKETS:
    _exportable = TorchExportableModuleForDecoderOnlyLM(
        _lm_headless, batch_size=2, max_cache_len=_bucket, device="cuda"
    )
    for _m in _exportable.modules():
        _m._non_persistent_buffers_set.clear()
    spaces.aoti_load_from_package_dir(_exportable.model, f"{_AOTI_DIR}/lm_step_{_bucket}")
    _LM_STEPS[_bucket] = _exportable.model


def _aliased_cache(step_module, bucket):
    cache = StaticCache(max_cache_len=bucket, config=_LM.config.get_text_config())
    cache.early_initialization(
        2, _LM.config.num_key_value_heads, _LM.config.head_dim, _LM.dtype, torch.device("cuda")
    )
    for i, layer in enumerate(cache.layers):
        layer.keys = step_module.get_buffer(f"key_cache_{i}")
        layer.values = step_module.get_buffer(f"value_cache_{i}")
        layer.cumulative_length = step_module.get_buffer(f"cumulative_length_{i}")
        layer.keys.zero_()
        layer.values.zero_()
        layer.cumulative_length.zero_()
    return cache


def _hop_lm_cache(src_bucket, dst_bucket, used):
    src, dst = _LM_STEPS[src_bucket], _LM_STEPS[dst_bucket]
    for i in range(_LM.config.num_hidden_layers):
        dst.get_buffer(f"key_cache_{i}")[:, :, :used] = src.get_buffer(f"key_cache_{i}")[:, :, :used]
        dst.get_buffer(f"value_cache_{i}")[:, :, :used] = src.get_buffer(f"value_cache_{i}")[:, :, :used]
        dst.get_buffer(f"cumulative_length_{i}").copy_(src.get_buffer(f"cumulative_length_{i}"))


def _iter_frames_aoti(text_ids, max_frames, generator=None):
    import diffusers.modular_pipelines.minimax_music3.encoders as P

    prompt_len = text_ids.shape[1]
    bucket = _BUCKETS[0]
    while bucket < prompt_len + 16:
        bucket *= 2
    step = _LM_STEPS[bucket]
    cache = _aliased_cache(step, bucket)
    prompt_embeds = _LM.model.embed_tokens(text_ids)
    output = _LM.model(
        inputs_embeds=prompt_embeds,
        past_key_values=cache,
        cache_position=torch.arange(prompt_len, device="cuda"),
        use_cache=True,
    )
    last_hidden = output.last_hidden_state[:, -1]

    vocab_mask = torch.ones(_LM.config.vocab_size, dtype=torch.bool, device="cuda")
    vocab_mask[P._AUDIO_CODE_OFFSET : P._AUDIO_CODE_OFFSET + P._SEMANTIC_VOCAB_SIZE] = False
    vocab_mask[P._AUDIO_END_TOKEN_ID] = False

    emitted = 0
    position = prompt_len
    pending = []
    for frame_index in range(max_frames + 1):
        if position + 2 >= bucket:
            new_bucket = bucket * 2
            _hop_lm_cache(bucket, new_bucket, position)
            bucket = new_bucket
            step = _LM_STEPS[bucket]
        logits = _LM.lm_head(last_hidden).float()
        logits = logits.masked_fill(vocab_mask, -float("inf"))
        conditional, unconditional = logits[0:1], logits[1:2]
        guided = unconditional + (conditional - unconditional) * P._AR_CFG_SCALE
        threshold = torch.topk(conditional, P._AR_CFG_TOP_K, dim=-1).values[..., -1, None]
        guided = guided.masked_fill(conditional < threshold, -float("inf"))
        guided = guided.masked_fill(vocab_mask.unsqueeze(0), -float("inf"))
        sampled = P._sample_top_k(guided, generator)
        semantic_code = (sampled - P._AUDIO_CODE_OFFSET).clamp_min(0).repeat(2)
        frame_codes, depth_hidden = P._generate_depth_codes(PIPE, last_hidden, semantic_code, generator)
        frame_hidden = torch.cat((last_hidden[:1].clone(), depth_hidden), dim=-1) if frame_index > 0 else None
        pending.append((sampled, frame_hidden))
        if len(pending) >= _STOP_CHECK_INTERVAL or frame_index == max_frames:
            stop_flags = torch.cat([s == P._AUDIO_END_TOKEN_ID for s, _ in pending]).tolist()
            for flag, (_, fh) in zip(stop_flags, pending):
                if flag:
                    return
                if fh is not None:
                    emitted += 1
                    yield fh
                    if emitted >= max_frames:
                        return
            pending = []
        feedback = P._embed_audio_frame(PIPE, frame_codes)
        last_hidden = step(inputs_embeds=feedback, cache_position=torch.tensor([position], device="cuda"))[:, -1]
        position += 1
    for _, fh in pending:
        if fh is not None:
            yield fh


PIPE._iter_frames = _iter_frames_aoti


def _iter_frames_eager(text_ids, max_frames, generator=None):
    # Yields one hidden state [1, 32768] per generated frame (eager LM path).
    import diffusers.modular_pipelines.minimax_music3.encoders as P

    lm = PIPE.language_model
    embeds = lm.model.embed_tokens(text_ids)
    output = lm.model(inputs_embeds=embeds, use_cache=True)
    past_key_values = output.past_key_values
    last_hidden = output.last_hidden_state[:, -1]

    vocab_mask = torch.ones(lm.config.vocab_size, dtype=torch.bool, device=text_ids.device)
    vocab_mask[P._AUDIO_CODE_OFFSET : P._AUDIO_CODE_OFFSET + P._SEMANTIC_VOCAB_SIZE] = False
    vocab_mask[P._AUDIO_END_TOKEN_ID] = False

    emitted = 0
    for frame_index in range(max_frames + 1):
        logits = lm.lm_head(last_hidden).float().masked_fill(vocab_mask, -float("inf"))
        conditional, unconditional = logits[0:1], logits[1:2]
        guided = unconditional + (conditional - unconditional) * P._AR_CFG_SCALE
        threshold = torch.topk(conditional, P._AR_CFG_TOP_K, dim=-1).values[..., -1, None]
        guided = guided.masked_fill(conditional < threshold, -float("inf"))
        guided = guided.masked_fill(vocab_mask.unsqueeze(0), -float("inf"))
        sampled = P._sample_top_k(guided, generator)
        if int(sampled.item()) == P._AUDIO_END_TOKEN_ID:
            break
        semantic_code = (sampled - P._AUDIO_CODE_OFFSET).repeat(2)
        frame_codes, depth_hidden = P._generate_depth_codes(PIPE, last_hidden, semantic_code, generator)
        if frame_index > 0:
            emitted += 1
            yield torch.cat((last_hidden[:1].clone(), depth_hidden), dim=-1)
            if emitted >= max_frames:
                break
        feedback = P._embed_audio_frame(PIPE, frame_codes)
        output = lm.model(inputs_embeds=feedback, past_key_values=past_key_values, use_cache=True)
        past_key_values = output.past_key_values
        last_hidden = output.last_hidden_state[:, -1]


# eager fallback available as _iter_frames_eager

# LM_COMPILE=1 (default): compile the 8B backbone's decode step with a StaticCache — measured 1.9x on the
# autoregressive stage, which dominates song time. The DIT stays eager: SDPA auto-dispatch already runs
# FlashAttention-2 there and torch.compile measured slower end-to-end. First generation per cache bucket
# pays ~1 min of compilation.
if os.environ.get("LM_COMPILE", "0") == "1":
    from transformers import StaticCache

    _lm = PIPE.language_model
    _depth = PIPE.rvq_depth_decoder

    def _lm_decode_step(inputs_embeds, cache_position, cache):
        output = _lm.model(
            inputs_embeds=inputs_embeds, past_key_values=cache, cache_position=cache_position, use_cache=True
        )
        return output.last_hidden_state[:, -1]

    _compiled_lm_step = torch.compile(_lm_decode_step, fullgraph=True)

    def _new_cache(length):
        return StaticCache(config=_lm.config, max_batch_size=2, max_cache_len=length, device="cuda", dtype=_lm.dtype)

    def _grow_cache(old, new_len):
        # Migrate K/V into the next bucket: allocated stays within 2x of used, and every bucket size hits its
        # pre-compiled specialization (attention cost scales with the ALLOCATED static length).
        new = _new_cache(new_len)
        for old_layer, new_layer in zip(old.layers, new.layers):
            used = int(old_layer.cumulative_length.item())
            new_layer.lazy_initialization(old_layer.keys[:, :, :1], old_layer.values[:, :, :1])
            new_layer.keys[:, :, :used] = old_layer.keys[:, :, :used]
            new_layer.values[:, :, :used] = old_layer.values[:, :, :used]
            new_layer.cumulative_length.copy_(old_layer.cumulative_length)
        return new

    def _iter_frames_compiled(text_ids, max_frames, generator=None):
        # Yields one hidden state [1, 32768] per generated frame, so windows can be decoded mid-generation.
        import diffusers.modular_pipelines.minimax_music3.encoders as P

        prompt_len = text_ids.shape[1]
        bucket = 1024
        while bucket < prompt_len + 16:
            bucket *= 2
        cache = _new_cache(bucket)
        embeds = _lm.model.embed_tokens(text_ids)
        output = _lm.model(
            inputs_embeds=embeds,
            past_key_values=cache,
            cache_position=torch.arange(prompt_len, device="cuda"),
            use_cache=True,
        )
        last_hidden = output.last_hidden_state[:, -1]

        vocab_mask = torch.ones(_lm.config.vocab_size, dtype=torch.bool, device="cuda")
        vocab_mask[P._AUDIO_CODE_OFFSET : P._AUDIO_CODE_OFFSET + P._SEMANTIC_VOCAB_SIZE] = False
        vocab_mask[P._AUDIO_END_TOKEN_ID] = False

        emitted = 0
        cache_position = torch.tensor([prompt_len], device="cuda")
        for frame_index in range(max_frames + 1):
            if int(cache_position.item()) + 2 >= bucket:
                bucket *= 2
                cache = _grow_cache(cache, bucket)
            logits = _lm.lm_head(last_hidden).float()
            logits = logits.masked_fill(vocab_mask, -float("inf"))
            conditional, unconditional = logits[0:1], logits[1:2]
            guided = unconditional + (conditional - unconditional) * P._AR_CFG_SCALE
            threshold = torch.topk(conditional, P._AR_CFG_TOP_K, dim=-1).values[..., -1, None]
            guided = guided.masked_fill(conditional < threshold, -float("inf"))
            guided = guided.masked_fill(vocab_mask.unsqueeze(0), -float("inf"))
            sampled = P._sample_top_k(guided, generator)
            if int(sampled.item()) == P._AUDIO_END_TOKEN_ID:
                break
            semantic_code = (sampled - P._AUDIO_CODE_OFFSET).repeat(2)
            frame_codes, depth_hidden = P._generate_depth_codes(PIPE, last_hidden, semantic_code, generator)
            if frame_index > 0:
                emitted += 1
                yield torch.cat((last_hidden[:1].clone(), depth_hidden), dim=-1)
                if emitted >= max_frames:
                    break
            feedback = P._embed_audio_frame(PIPE, frame_codes)
            last_hidden = _compiled_lm_step(feedback, cache_position, cache).clone()
            cache_position = cache_position + 1

    def _generate_frames_compiled(text_ids, max_frames, generator=None):
        frame_hiddens = list(_iter_frames_compiled(text_ids, max_frames, generator))
        if not frame_hiddens:
            raise gr.Error("The model generated zero audio frames — try different lyrics or a longer duration.")
        return torch.stack(frame_hiddens, dim=1)

    PIPE.generate_frames = _generate_frames_compiled
    PIPE._iter_frames = _iter_frames_compiled

    # Each distinct bucket size compiles once per process; keep every specialization cached.
    torch._dynamo.config.cache_size_limit = 16

    # Pre-warm the common cache buckets at startup so users never hit a compile pause (each bucket size is one
    # dynamo specialization). The default covers songs up to ~80s; longer buckets compile on first use.
    @torch.inference_mode()
    def _warm_bucket(bucket):
        print(f"[warmup] compiling decode step for cache bucket {bucket}...", flush=True)
        cache = StaticCache(config=_lm.config, max_batch_size=2, max_cache_len=bucket, device="cuda", dtype=_lm.dtype)
        embeds = torch.zeros(2, 8, _lm.config.hidden_size, device="cuda", dtype=_lm.dtype)
        _lm.model(inputs_embeds=embeds, past_key_values=cache, cache_position=torch.arange(8, device="cuda"), use_cache=True)
        _compiled_lm_step(embeds[:, :1], torch.tensor([8], device="cuda"), cache)

    # The full ladder covers every slider duration (300s -> 7574 slots -> bucket 8192).
    for bucket in [int(b) for b in os.environ.get("WARM_BUCKETS", "1024,2048,4096,8192").split(",") if b]:
        _warm_bucket(bucket)
    # One short end-to-end generation covers the remaining one-time CUDA/cuDNN/SDPA initialization in the
    # flow-matching and vocoder stages.
    print("[warmup] end-to-end pass...", flush=True)
    PIPE(
        prompt="a short warm-up jingle",
        lyrics="[instrumental]",
        audio_duration=4.0,
        num_inference_steps=30,
        generator=torch.Generator("cuda").manual_seed(0),
    )
    print("[warmup] done", flush=True)


_CHUNK, _HOP, _HOP_SAMPLES = 200, 100, 86 * 512
_CROP_RIGHT_SAMPLES = (344 - 86) * 512


@torch.inference_mode()
def _decode_window(hidden_window, previous, generator, steps, guidance):
    previous_latent, previous_condition = previous
    condition = PIPE.condition_encoder(hidden_window)
    condition = condition.to(PIPE.transformer.dtype)
    latents = randn_like_seeded = torch.randn(
        (1, PIPE.transformer.config.in_channels, condition.shape[1]),
        generator=generator, device="cuda", dtype=condition.dtype,
    )
    overlap, noise_prompt = 0, None
    if previous_latent is not None:
        overlap = min(previous_latent.shape[-1], latents.shape[-1])
        noise_prompt = latents[..., :overlap].clone()
        condition[:, :overlap] = previous_condition[:, :overlap]
    condition_input = torch.cat((condition, torch.zeros_like(condition)), dim=0)
    PIPE.scheduler.set_timesteps(sigmas=np.linspace(1.0, 1.0 / steps, steps), device="cuda")
    for timestep in PIPE.scheduler.timesteps:
        if overlap > 0:
            t = timestep.to(latents.dtype)
            latents[..., :overlap] = (1.0 - (1.0 - 1e-6) * t) * noise_prompt + t * previous_latent[..., :overlap]
        velocity = PIPE.transformer(
            latents.expand(2, -1, -1).contiguous(), timestep.expand(2).to(latents.dtype), condition_input
        ).sample
        velocity = velocity[1:2] + guidance * (velocity[0:1] - velocity[1:2])
        latents = PIPE.scheduler.step(velocity, timestep, latents).prev_sample
    if overlap > 0:
        latents[..., :overlap] = previous_latent[..., :overlap]
    overlap_start = max(0, latents.shape[-1] - 2 * 172)
    overlap_end = max(overlap_start, latents.shape[-1] - 172)
    carry = (latents[..., overlap_start:overlap_end], condition[:, overlap_start:overlap_end])
    waveform = PIPE.vocoder(latents.to(PIPE.vocoder.dtype)).float().clamp(-1.0, 1.0)[0]
    return waveform, carry


def _to_int16(waveform):
    return (waveform.cpu().numpy().T * 32767.0).astype(np.int16)


def _pcm_msg(wave_int16, sr, seq, gen, off):
    # One streamed-player message: base64 of interleaved int16 stereo PCM with the chunk's absolute
    # sample offset. The custom gr.HTML player replaces the streaming gr.Audio (its HLS path never
    # re-attaches after the first stream and can't autoplay reliably), plays these gaplessly via
    # Web Audio, and stays lossless. Gradio's frontend coalesces rapid per-component updates (only
    # the newest survives a flush), so a chunk can be dropped: offsets keep the timeline correct,
    # and the final "done" message carries the finished wav's URL so the player re-fetches the
    # complete file whenever anything is missing.
    import base64

    return {"cmd": "chunk", "sr": int(sr), "ch": 2, "seq": int(seq), "gen": gen, "off": int(off),
            "pcm": base64.b64encode(np.ascontiguousarray(wave_int16).tobytes()).decode()}


_SONGS_DIR = "/tmp/mm3_songs"
os.makedirs(_SONGS_DIR, exist_ok=True)
os.environ.setdefault("GRADIO_ALLOWED_PATHS", f"{_SONGS_DIR},{os.path.abspath('examples')}")


def _file_url(path):
    return "/gradio_api/file=" + os.path.abspath(path)


@torch.inference_mode()
def _stream_windows(text_ids, max_frames, ar_generator, dit_generator, steps, guidance):
    frames = []
    windows_done = 0
    carry = (None, None)
    for hidden in PIPE._iter_frames(text_ids, max_frames, ar_generator):
        frames.append(hidden)
        window_start = windows_done * _HOP
        if len(frames) > window_start + _CHUNK:
            window = torch.stack(frames[window_start : window_start + _CHUNK], dim=1)
            waveform, carry = _decode_window(window, carry, dit_generator, steps, guidance)
            left = 0 if windows_done == 0 else _HOP_SAMPLES
            windows_done += 1
            yield waveform[:, left : waveform.shape[-1] - _CROP_RIGHT_SAMPLES]
    if not frames:
        raise gr.Error("The model generated zero audio frames — try different lyrics or a longer duration.")
    total = len(frames)
    window_starts = [0] if total <= _CHUNK else list(range(0, total - _HOP, _HOP))
    for w in range(windows_done, len(window_starts)):
        window_start = window_starts[w]
        window = torch.stack(frames[window_start : min(window_start + _CHUNK, total)], dim=1)
        waveform, carry = _decode_window(window, carry, dit_generator, steps, guidance)
        left = 0 if w == 0 else _HOP_SAMPLES
        right = _CROP_RIGHT_SAMPLES if w < len(window_starts) - 1 else 0
        yield waveform[:, left : waveform.shape[-1] - right]


DEFAULT_LYRICS = """[intro]

[verse]
Riding on a beam of light tonight
Every little star is burning bright
[pre-chorus]
Hold your breath, the sky is opening
[chorus]
We are made of sound and time
Every heartbeat keeps the rhyme
[outro]"""

DEFAULT_GLOBAL = (
    "Basic Attributes: bpm is 120. key is C, and scale is major. Synth-Pop / Electropop. Global Emotional "
    "Progression: The track opens in shimmering anticipation, a filtered pulse like city lights coming on at dusk. "
    "The verse glides forward with hopeful momentum, the pre-chorus holds its breath as the arrangement tightens "
    "and rises, and the chorus bursts open into wide-screen euphoria — bright, weightless, celebratory. The outro "
    "drifts back down into a starry afterglow, ending on air and quiet wonder. Application Scenarios & Imagery: a "
    "night drive under neon overpasses with the windows down; a planetarium dome igniting as the lights dim; a "
    "rooftop countdown at midnight. Sonics & Production Profile: a polished, modern pop mix with a wide stereo "
    "image — airy sparkling highs, present mid-range vocals, and a tight, punchy low end; side-chained compression "
    "gives the chorus a gentle pumping lift, and the outro dissolves into long reverb tails."
)
DEFAULT_VOCALS = (
    "Vocal Gender & Timbre: Singer A (Female), a warm mezzo-soprano with an intimate, breathy texture in her low "
    "register and a clear, ringing brightness when she lifts. Vocal Style: soft and close-miked through the verse, "
    "phrasing like a secret; the pre-chorus rises with held, urgent notes, and the chorus opens into a confident, "
    "soaring belt with sustained tones riding the beat; over the outro she dissolves into wordless, airy ad-libs "
    "echoing the chorus melody. Harmony/Backing Vocals: a single ghost double shadows the pre-chorus; stacked "
    "parallel harmonies in thirds widen the chorus into a glowing wall; the verse stays solo and intimate. Vocal "
    "FX: light plate reverb throughout, tempo-synced delay throws on chorus line endings, subtle saturation for "
    "chorus presence, and a longer, washier reverb on the outro ad-libs."
)
DEFAULT_ARRANGEMENT = (
    "Instrument Lifecycle Description (Primary/Secondary Layering): Primary: a round, side-chained analog-style "
    "synth bass anchors the harmony from the first verse through the chorus, under a soft pad bed that opens the "
    "intro and never fully leaves. Secondary: a shimmering arpeggio enters at the pre-chorus and runs through the "
    "chorus; wide analog pads and a bright synth counter-melody appear only in the chorus to lift it; a sparse felt "
    "piano takes over the outro as the synths fall away. Groove & Foundation Progression: the intro pulses on a "
    "filtered four-on-the-floor kick; the verse keeps drums minimal — kick, soft clap, ticking closed hat; the "
    "pre-chorus adds open hats and a rising snare build, and the chorus lands with the full kit: punchy kick on "
    "every beat, layered claps, driving crash accents. After the chorus the drums drop out entirely, leaving piano, "
    "pad, and air for the outro. Embellishments, Textures & Spatial FX: a white-noise riser and reverse swell "
    "launch the chorus; glittering bell accents answer the vocal there; and the final piano chord rings into a "
    "long, starlit reverb wash."
)

def render_video(wav_path, title):
    # Social share visualizer: warm citrus bars on a dark gradient, rendered via numpy -> ffmpeg pipe (CPU).
    if not wav_path:
        return gr.skip()
    import subprocess

    import scipy.io.wavfile

    sr, wave = scipy.io.wavfile.read(wav_path)
    mono = wave.astype(np.float32).mean(axis=1) / 32768.0
    fps, size, bars = 24, 720, 56
    total_frames = int(len(mono) / sr * fps)
    window = int(sr / fps * 2)
    bar_w = size // (bars + 6)
    x0 = (size - bars * bar_w) // 2

    from PIL import Image, ImageDraw, ImageFont

    def _font(px):
        for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                     "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
        return ImageFont.load_default(size=px)

    def _fit_title(draw, text, max_w):
        # Adaptive title sizing: shrink to fit, then wrap to two lines at the space nearest the middle.
        for px in range(30, 15, -2):
            f = _font(px)
            if draw.textlength(text, font=f) <= max_w:
                return [(text, f, 56)]
        spaces = [i for i, ch in enumerate(text) if ch == " "]
        split = min(spaces, key=lambda i: abs(i - len(text) // 2)) if spaces else len(text) // 2
        lines = [text[:split].strip(), text[split:].strip()]
        for px in range(24, 11, -2):
            f = _font(px)
            if all(draw.textlength(line, font=f) <= max_w for line in lines):
                break
        return [(lines[0], f, 40), (lines[1], f, 72)]

    # warm dark gradient with a soft vignette
    grad_y = np.linspace(0.0, 1.0, size)[:, None, None]
    bg = np.array([10.0, 10.0, 13.0]) * (1 - grad_y) + np.array([27.0, 18.0, 10.0]) * grad_y
    gx, gy = np.meshgrid(np.linspace(-1, 1, size), np.linspace(-1, 1, size))
    vignette = 1.0 - 0.38 * np.clip(np.sqrt(gx * gx + gy * gy) - 0.35, 0.0, 1.0) ** 1.5
    bg = (np.repeat(bg, size, axis=1) * vignette[..., None]).astype(np.uint8)

    overlay = Image.fromarray(bg)
    draw = ImageDraw.Draw(overlay)
    if title:
        for line, f, y in _fit_title(draw, title[:96], size - 48):
            draw.text((size // 2, y), line, fill=(240, 238, 232), anchor="mm", font=f)
    draw.text((size // 2, size - 52), "MiniMax Music 3", fill=(245, 158, 11), anchor="mm", font=_font(30))
    draw.text((size // 2, size - 24), "made with diffusers", fill=(150, 140, 124), anchor="mm", font=_font(16))
    base = np.asarray(overlay, dtype=np.uint8)

    # citrus palette across the bars: yellow -> orange -> ember
    _yellow, _orange, _ember = np.array([250.0, 204.0, 86.0]), np.array([245.0, 140.0, 32.0]), np.array([196.0, 74.0, 22.0])
    palette = []
    for b in range(bars):
        t = b / max(bars - 1, 1)
        col = _yellow + (_orange - _yellow) * (t * 2) if t < 0.5 else _orange + (_ember - _orange) * ((t - 0.5) * 2)
        palette.append(col)

    out_path = wav_path.replace(".wav", "_viz.mp4")
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size}x{size}", "-r", str(fps),
         "-i", "pipe:", "-i", wav_path, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", out_path],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    freqs = np.fft.rfftfreq(window, 1 / sr)
    band_edges = np.geomspace(40, 12000, bars + 1)
    smooth = np.zeros(bars)
    mid = size // 2 - 30
    prog_y, prog_xa, prog_xb = size - 92, int(size * 0.1), int(size * 0.9)
    for i in range(total_frames):
        start = int(i * sr / fps)
        chunk = mono[start : start + window]
        if len(chunk) < window:
            chunk = np.pad(chunk, (0, window - len(chunk)))
        spectrum = np.abs(np.fft.rfft(chunk * np.hanning(window)))
        levels = np.array([spectrum[(freqs >= band_edges[b]) & (freqs < band_edges[b + 1])].mean() for b in range(bars)])
        levels = np.log1p(12 * np.nan_to_num(levels))
        smooth = np.maximum(levels, smooth * 0.85)
        frame = base.copy()
        for b in range(bars):
            rel = min(smooth[b] / 4.5, 1.0)
            h = max(3, int(rel * (size * 0.26)))
            x = x0 + b * bar_w
            col = palette[b] * (0.45 + 0.55 * rel)
            glow = (col * 0.30).astype(np.uint8)
            region = frame[mid - h - 5 : mid + h + 5, x : x + bar_w - 2]
            np.maximum(region, glow, out=region)
            frame[mid - h : mid + h, x + 2 : x + bar_w - 4] = col.astype(np.uint8)
        frame[prog_y : prog_y + 3, prog_xa : prog_xb] = (52, 40, 26)
        px = prog_xa + int((prog_xb - prog_xa) * (i / max(total_frames - 1, 1)))
        frame[prog_y : prog_y + 3, prog_xa : px] = (245, 158, 11)
        ffmpeg.stdin.write(frame.tobytes())
    ffmpeg.stdin.close()
    ffmpeg.wait()
    return out_path


# ---------------------------------------------------------------------------
# gr.Workflow app. The canvas (workflow.json) wires two fn operators:
#   generate_song  — @spaces.GPU ZeroGPU worker: AR frames -> windowed DiT decode -> vocoder -> wav
#   make_video     — CPU ffmpeg visualizer for the share video
# Lyrics + structured caption are editable reference nodes (defaults from the official
# prompting guide). Workflow fn nodes are plain callables (no streaming), so the live PCM
# player of the Blocks version becomes a final audio subject.
# ---------------------------------------------------------------------------

import tempfile

MAX_SEED = int(np.iinfo(np.int32).max)


def _save_file(path, orig_name, mime_type):
    # Serialize a file as a JSON pointer the canvas can render (mirror of the
    # gradio.workflow tmp-save helper); Workflow.launch() allows the tempdir.
    return {"path": path, "url": f"/gradio_api/file={path}", "orig_name": orig_name, "mime_type": mime_type}


def _estimate_duration(lyrics, global_meta, vocal_details, arrangement, duration, seed, randomize_seed, steps, guidance):
    # Fitted on-Space (xlarge): wall = 0.75*dur + 0.20*dur*(steps/30) + ~15s cold-worker margin.
    return min(int(float(duration) * (0.75 + 0.20 * float(steps) / 30.0) + 15), 600)


def _friendly_gpu_error(err):
    msg = (str(err) or "").lower()
    if any(h in msg for h in ("gpu limit", "quota", "no gpu", "could not allocate", "gpu is busy", "too many", "concurrent")):
        return ("⛔ This demo's shared GPU is at capacity right now — it's not a problem with your prompt "
                "or your account. Please wait a minute and retry; demand clears between bursts.")
    if "out of memory" in msg or "oom" in msg:
        return "💥 Generation ran out of GPU memory. Try a shorter duration or fewer steps, then retry."
    return "⚠️ Generation failed. Please try again in a moment."


@spaces.GPU(duration=_estimate_duration, size="xlarge")
@torch.inference_mode()
def _generate_song_gpu(lyrics, global_meta, vocal_details, arrangement, duration, seed, randomize_seed, steps, guidance):
    caption = "\n".join(s.strip() for s in (global_meta, vocal_details, arrangement) if s and s.strip())
    if not caption:
        raise gr.Error("Fill in the structured prompt (Global metadata / Vocal details / Arrangement) first.")
    if not lyrics or not lyrics.strip():
        raise gr.Error("Lyrics are required (section tags like [verse] must be on their own line).")
    if randomize_seed:
        seed = random.randint(0, MAX_SEED)
    seed = int(seed)
    steps, guidance, sr = int(steps), float(guidance), PIPE.sampling_rate
    text_ids = _encode_prompt(caption, lyrics, "cuda")
    max_frames = min(int(float(duration) * PIPE.frame_rate), 9000)
    ar_generator = torch.Generator("cuda").manual_seed(seed)
    dit_generator = torch.Generator("cuda").manual_seed(seed + 1)

    start = time.time()
    chunks = [c for c in _stream_windows(text_ids, max_frames, ar_generator, dit_generator, steps, guidance)]
    streamed = sum(c.shape[-1] for c in chunks) / sr

    import scipy.io.wavfile

    full = _to_int16(torch.cat(chunks, dim=-1))
    wav_path = os.path.join(tempfile.gettempdir(), f"mm3_{os.urandom(8).hex()}.wav")
    scipy.io.wavfile.write(wav_path, sr, full)
    audio = _save_file(wav_path, "minimax-music3.wav", "audio/wav")
    stats = f"done: {streamed:.1f}s of audio in {time.time() - start:.0f}s — seed {seed}"
    return audio, seed, stats


def generate_song(lyrics: str, global_meta: str, vocal_details: str, arrangement: str,
                  duration: float, seed: float, randomize_seed: bool, steps: float, guidance: float):
    """Workflow-facing wrapper around the ZeroGPU worker: rewords allocator rejections."""
    try:
        return _generate_song_gpu(lyrics, global_meta, vocal_details, arrangement,
                                  duration, seed, randomize_seed, steps, guidance)
    except gr.Error:
        raise
    except Exception as e:
        raise gr.Error(_friendly_gpu_error(e)) from e


def _audio_to_path(audio):
    # The executor re-serializes port values between nodes, so the audio may arrive as a
    # plain path, a file dict with path/name, or a URL-only dict (path stripped).
    if isinstance(audio, str):
        return audio
    if isinstance(audio, dict):
        for key in ("path", "name"):
            if audio.get(key) and os.path.exists(audio[key]):
                return audio[key]
        url = audio.get("url") or ""
        if url.startswith("/gradio_api/file="):
            return url.split("/gradio_api/file=", 1)[1]
        if url:
            import urllib.request

            suffix = os.path.splitext(url.split("?")[0])[1] or ".wav"
            dst = os.path.join(tempfile.gettempdir(), f"mm3_in_{os.urandom(8).hex()}{suffix}")
            urllib.request.urlretrieve(url, dst)
            return dst
    return None


def make_video(audio, title: str):
    """Render the share visualizer for a generated song. `audio` is the audio port value."""
    if not audio:
        raise gr.Error("Generate a song first — make_video needs the Output Song audio.")
    wav_path = _audio_to_path(audio)
    if not wav_path or not os.path.exists(wav_path):
        raise gr.Error("Could not resolve the audio from the previous node — re-run generate_song.")
    out_path = render_video(wav_path, (title or "").strip() or "Untitled")
    return _save_file(out_path, "minimax-music3-share.mp4", "video/mp4")


demo = gr.Workflow(
    graph="workflow.json",
    bind={
        "generate_song": generate_song,
        "make_video": make_video,
    },
)

if __name__ == "__main__":
    demo.launch()
