"""RIFE interpolation / boomerang / smart stitch — HuggingFace Space source.

DEPLOYED TO: https://huggingface.co/spaces/1inkusFace/RIFE
             (served at https://1inkusface-rife.hf.space)

This directory is the single source of truth for that Space. It was previously
duplicated at `src/hf_space/`, and the two copies drifted apart — the live
Space ran an older HTML+JS reorder UI while the repo copy had a newer Gallery
one. Do not add a second copy; see RIFE/README.md for the deploy procedure.

The browser client in `src/utils/huggingface.ts` calls the three `api_name`
routes below — `interpolate_video`, `stitch` and `morph`. Changing their
signatures breaks it.
"""

import spaces
import os
import shutil
import subprocess
import sys
import numpy as np
import gradio as gr
import uuid

# --- Constants ---
BASE_DIR = os.getcwd()
RIFE_DIR = os.path.join(BASE_DIR, "Practical-RIFE")
MODEL_URL = "https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip"
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace_temp")

# Frame rate every stitched clip is normalized to. 30 rather than 60: upsampling
# 24 fps sources to 60 was the main cause of multi-minute normalizations.
STITCH_FPS = 30
# Default hold time for still-image clips (matches clip_stacker STILL_IMAGE_DEFAULT_DURATION).
STILL_IMAGE_DEFAULT_DURATION = 5.0
# avg_frame_rate rarely lands exactly on 30 (30000/1001 is 29.97), and a clip
# that close needs no resampling.
FPS_TOLERANCE = 0.05
# MP4 media timescale forced on every normalized clip. A multiple of both 30
# and 30000/1001 keeps frame durations integral either way, and forcing one
# value means the concat demuxer never has to reconcile two time bases.
VIDEO_TRACK_TIMESCALE = 30000
IMAGE_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif",
})
# Recursion depth cap for morph interpolation; see morph_transition.
MAX_MORPH_MULTI = 8

# Ensure our safe workspace directory exists
os.makedirs(WORKSPACE_DIR, exist_ok=True)

# --- Global NumPy patch ---
if not hasattr(np, 'float'):
    np.float = float
if not hasattr(np, 'int'):
    np.int = int

def is_still_image(path):
    """True when `path` looks like a single-frame image upload."""
    ext = os.path.splitext(path)[1].lower()
    return ext in IMAGE_EXTENSIONS


def nle_friendly_h264_video_args(gop=None):
    """libx264 flags aligned with clip_stacker buildStillImageFfmpegArgs.

    Editors are stricter than players. Beyond codec/profile they want a
    constant frame rate, a declared colour space and one fixed media
    timescale — a still-image clip encoded without those lands in an NLE as a
    variable-rate, colour-shifted, oddly-timed asset even though it plays fine
    in VLC. Everything here is emitted for every clip so the whole concat set
    is byte-level uniform.
    """
    gop = gop or STITCH_FPS
    return [
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-tune', 'stillimage',
        '-profile:v', 'high', '-level', '4.1',
        '-g', str(gop), '-keyint_min', str(gop), '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        # No B-frames: reordering writes negative DTS and CTS offsets, which
        # the MP4 muxer papers over with an edit list. Editors that ignore
        # edit lists then show the clip off by a frame or two, and stills gain
        # nothing from B-frames anyway.
        '-bf', '0',
        # Constant frame rate, declared in both the stream and the container.
        '-vsync', 'cfr', '-r', str(STITCH_FPS),
        # Untagged H.264 makes editors guess bt601 vs bt709; a still rendered
        # through the shader path then reads as colour-shifted next to clips
        # that are tagged. Say it explicitly.
        '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709', '-color_range', 'tv',
        # One timescale everywhere: mixing the muxer's per-clip defaults is
        # what makes a concat-copied file report VFR / wrong duration.
        '-video_track_timescale', str(VIDEO_TRACK_TIMESCALE),
    ]


def nle_friendly_aac_audio_args():
    return ['-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2']


def stitch_scale_filter(target_w, target_h):
    """Scale/pad/fps filter chain with explicit yuv420p for concat compatibility."""
    return (
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,"
        # PNG/JPEG density metadata can yield a non-square sample aspect that
        # editors honour, stretching the still against its neighbours.
        f"setsar=1,fps={STITCH_FPS},format=yuv420p,"
        f"setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709"
    )

# ── Thumbnail JPEG files (Gradio Gallery needs real paths, not data URIs) ───

def extract_thumb_path(media_path):
    """Write a small JPEG thumbnail and return its path."""
    thumb_path = os.path.join(WORKSPACE_DIR, f"thumb_{uuid.uuid4().hex}.jpg")
    try:
        if is_still_image(media_path):
            cmd = [
                'ffmpeg', '-i', media_path,
                '-vframes', '1',
                '-vf', 'scale=240:-1',
                '-y', thumb_path,
            ]
        else:
            cmd = [
                'ffmpeg', '-i', media_path,
                '-ss', '00:00:00.5', '-vframes', '1',
                '-vf', 'scale=240:-1',
                '-y', thumb_path,
            ]
        result = subprocess.run(
            cmd, stderr=subprocess.DEVNULL, timeout=10,
        )
        if result.returncode == 0 and os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 0:
            return thumb_path
    except Exception as e:
        print(f"Thumb failed {media_path}: {e}")
    try:
        if os.path.exists(thumb_path):
            os.remove(thumb_path)
    except OSError:
        pass
    return None


def delete_thumb_file(thumb_entry):
    """Remove a generated gallery thumbnail from the workspace."""
    if not thumb_entry:
        return
    path = thumb_entry[0]
    if not path or not isinstance(path, str) or path.startswith('data:'):
        return
    if not path.startswith(WORKSPACE_DIR):
        return
    try:
        os.remove(path)
    except OSError:
        pass


def create_thumbs(paths):
    """Return list of (thumb_path_or_None, label) for each path."""
    out = []
    for i, p in enumerate(paths):
        out.append((extract_thumb_path(p), f"{i+1}. {os.path.basename(p)}"))
    return out

# ── Environment setup ─────────────────────────────────────────────────────────

def run_command(command, cwd=None):
    subprocess.run(command, shell=True, check=True, cwd=cwd)

def patch_skvideo_fully():
    try:
        skvideo_dir = subprocess.check_output(
            [sys.executable, "-c", "import skvideo; print(skvideo.__path__[0])"],
            text=True).strip()
        patched = 0
        for root, _, files in os.walk(skvideo_dir):
            for fname in files:
                if fname.endswith(".py"):
                    fp = os.path.join(root, fname)
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        c = f.read()
                    if "np.float" in c or "np.int" in c:
                        with open(fp, "w", encoding="utf-8") as f:
                            f.write(c.replace("np.float", "float").replace("np.int", "int"))
                        patched += 1
        print(f"skvideo patched ({patched} files)")
    except Exception as e:
        print(f"skvideo patch failed: {e}")

def setup_environment():
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                           "scikit-video", "imageio[ffmpeg]", "tqdm",
                           "opencv-python>=4.1.2", "moviepy>=1.0.3", "torchvision"])
    patch_skvideo_fully()

    if not os.path.exists(RIFE_DIR):
        run_command(f"git clone https://github.com/hzwer/Practical-RIFE {RIFE_DIR}")

    hdv3_path = os.path.join(RIFE_DIR, "HDv3")
    if not os.path.exists(hdv3_path) or \
       not os.path.exists(os.path.join(RIFE_DIR, "train_log", "RIFE_HDv3.py")):
        zip_path = os.path.join(RIFE_DIR, "RIFEv4.26_0921.zip")
        run_command(f"wget -O {zip_path} {MODEL_URL}")
        run_command(f"unzip -o {zip_path} -d {RIFE_DIR}")
        train_log_dir = os.path.join(RIFE_DIR, "train_log")
        os.makedirs(train_log_dir, exist_ok=True)
        extract_folder = os.path.join(RIFE_DIR, "RIFEv4.26_0921")
        for f in ["RIFE_HDv3.py", "IFNet_HDv3.py"]:
            src = os.path.join(extract_folder, f)
            if os.path.exists(src):
                shutil.move(src, train_log_dir)
        with open(os.path.join(train_log_dir, "__init__.py"), 'w') as f:
            pass
        os.makedirs(hdv3_path, exist_ok=True)
        flownet_src = os.path.join(extract_folder, "flownet.pkl")
        if os.path.exists(flownet_src):
            shutil.move(flownet_src, hdv3_path)
        shutil.rmtree(extract_folder, ignore_errors=True)
        if os.path.exists(zip_path):
            os.remove(zip_path)

    inference_script = os.path.join(RIFE_DIR, "inference_video.py")
    if os.path.exists(inference_script):
        with open(inference_script, 'r') as f:
            content = f.read()
        if "libx264" not in content:
            content = content.replace(
                "-c:v', 'mpeg4', '-qscale:v', '1'",
                "-c:v', 'libx264', '-preset', 'medium', '-crf', '23'")
            with open(inference_script, 'w') as f:
                f.write(content)

setup_environment()

# ── Core processing ───────────────────────────────────────────────────────────

def get_fps(video_path):
    try:
        cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
               '-show_entries', 'stream=avg_frame_rate',
               '-of', 'default=noprint_wrappers=1:nokey=1', video_path]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        fps_str = result.stdout.strip()
        if '/' in fps_str:
            num, den = map(int, fps_str.split('/'))
            return num / den if den != 0 else 30.0
        return float(fps_str)
    except:
        return 30.0

def probe_video_stream(video_path):
    """Width, height, fps and codec of the first video stream, or None."""
    try:
        cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
               '-show_entries', 'stream=width,height,avg_frame_rate,codec_name',
               '-of', 'default=noprint_wrappers=1', video_path]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        fields = {}
        for line in result.stdout.strip().splitlines():
            if '=' in line:
                key, _, value = line.partition('=')
                fields[key] = value
        rate = fields.get('avg_frame_rate', '0/0')
        if '/' in rate:
            num, den = rate.split('/')
            fps = float(num) / float(den) if float(den) else 0.0
        else:
            fps = float(rate or 0)
        return {
            'width': int(fields['width']),
            'height': int(fields['height']),
            'fps': fps,
            'codec': fields.get('codec_name', ''),
        }
    except Exception as e:
        print(f"Probe failed for {video_path}: {e}")
        return None


def probe_audio_codec(video_path):
    """Codec name of the first audio stream, '' when there is none."""
    try:
        cmd = ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
               '-show_entries', 'stream=codec_name',
               '-of', 'default=noprint_wrappers=1:nokey=1', video_path]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except Exception:
        return ''


def clip_already_conforms(video_path, target_w, target_h, target_fps=STITCH_FPS):
    """True when a clip can go into the concat list without re-encoding.

    The concat demuxer needs every input to share codec, resolution and time
    base, so this insists on an exact match rather than a close one. Anything
    that fails goes down the normalization path unchanged.
    """
    info = probe_video_stream(video_path)
    if info is None:
        return False
    if info['codec'] != 'h264':
        return False
    if info['width'] != int(target_w) or info['height'] != int(target_h):
        return False
    if abs(info['fps'] - target_fps) > FPS_TOLERANCE:
        return False
    # A missing audio track would desync the concat against clips that have
    # one, and a non-AAC track would not concat cleanly with the re-encoded
    # AAC of its neighbours.
    return probe_audio_codec(video_path) == 'aac'


def still_image_duration(path):
    """Seconds to hold a still image when normalizing for stitch."""
    duration = get_duration(path)
    if duration is not None and duration > 0:
        return duration
    return STILL_IMAGE_DEFAULT_DURATION


def normalize_still_image_for_stitch(
    image_path, out_path, target_w, target_h, duration=None,
):
    """Turn a still image into an h264+aac clip at STITCH_FPS for concat."""
    hold = duration if duration is not None else still_image_duration(image_path)
    hold = max(0.1, float(hold))
    subprocess.run([
        'ffmpeg', '-loop', '1', '-t', str(hold), '-i', image_path,
        '-f', 'lavfi', '-i',
        f'anullsrc=channel_layout=stereo:sample_rate=44100:d={hold}',
        '-vf', stitch_scale_filter(target_w, target_h),
        '-map', '0:v:0', '-map', '1:a:0',
        *nle_friendly_h264_video_args(),
        *nle_friendly_aac_audio_args(),
        '-movflags', '+faststart',
        '-t', str(hold),
        '-y', out_path,
    ], check=True, capture_output=True, text=True)


def normalize_video_for_stitch(vid_path, out_path, target_w, target_h):
    """Re-encode a video clip to the stitch target (scale/pad/fps + AAC audio)."""
    scale = stitch_scale_filter(target_w, target_h)
    has_audio = probe_audio_codec(vid_path) != ''
    if has_audio:
        subprocess.run([
            'ffmpeg', '-i', vid_path, '-vf', scale,
            *nle_friendly_h264_video_args(),
            *nle_friendly_aac_audio_args(),
            '-movflags', '+faststart',
            '-y', out_path,
        ], check=True, capture_output=True, text=True)
    else:
        duration = max(0.1, get_duration(vid_path) or STILL_IMAGE_DEFAULT_DURATION)
        subprocess.run([
            'ffmpeg', '-i', vid_path,
            '-f', 'lavfi', '-i',
            f'anullsrc=channel_layout=stereo:sample_rate=44100:d={duration}',
            '-vf', scale,
            '-map', '0:v:0', '-map', '1:a:0',
            *nle_friendly_h264_video_args(),
            *nle_friendly_aac_audio_args(),
            '-movflags', '+faststart',
            '-t', str(duration),
            '-y', out_path,
        ], check=True, capture_output=True, text=True)


def get_duration(video_path):
    """Get exact video duration in seconds"""
    try:
        cmd = ['ffprobe', '-v', 'error', '-show_entries',
               'format=duration', '-of',
               'default=noprint_wrappers=1:nokey=1', video_path]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())
    except:
        print("⚠️ Could not detect duration, falling back to default behavior")
        return None

def rife_timeout_seconds(video_path, multi):
    """Scale RIFE subprocess timeout with clip length and interpolation factor."""
    duration = get_duration(video_path) or 60.0
    try:
        multi_val = max(1, int(str(multi).strip().replace("x", "") or "2"))
    except ValueError:
        multi_val = 2
    # Base overhead plus generous per-second budget scaled by interpolation factor.
    return max(300, int(duration * multi_val * 45 + 120))

def run_rife_inference(video_path, output_path, multi, label="RIFE"):
    """Run inference_video.py with a duration-aware timeout."""
    timeout = rife_timeout_seconds(video_path, multi)
    try:
        return subprocess.run(
            ['python3', 'inference_video.py', '--video', video_path,
             '--output', output_path, '--multi', str(multi), '--model', 'HDv3'],
            capture_output=True, text=True, cwd=RIFE_DIR, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        duration = get_duration(video_path)
        dur_str = f"{duration:.1f}s" if duration is not None else "unknown duration"
        raise Exception(
            f"{label} inference timed out after {timeout}s "
            f"(input {dur_str}, {multi}x multiplier). "
            "Try a shorter clip or a lower multiplier."
        ) from e

def create_boomerang_loop(input_path, output_path, fps):
    """Forward + reversed concat via FFmpeg (no full-frame NumPy load)."""
    session_id = uuid.uuid4().hex
    reversed_path = os.path.join(WORKSPACE_DIR, f"boom_rev_{session_id}.mp4")
    forward_path = os.path.join(WORKSPACE_DIR, f"boom_fwd_{session_id}.mp4")
    list_path = os.path.join(WORKSPACE_DIR, f"boom_list_{session_id}.txt")
    encode_args = [
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-r', str(fps), '-preset', 'slow', '-crf', '17', '-an',
    ]
    try:
        subprocess.run(
            ['ffmpeg', '-i', input_path, '-vf', 'reverse', *encode_args,
             '-y', reversed_path],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ['ffmpeg', '-i', input_path, *encode_args, '-y', forward_path],
            check=True, capture_output=True, text=True,
        )
        with open(list_path, 'w') as f:
            f.write(f"file '{forward_path}'\n")
            f.write(f"file '{reversed_path}'\n")
        subprocess.run([
            'ffmpeg', '-f', 'concat', '-safe', '0', '-i', list_path,
            '-c', 'copy', '-movflags', '+faststart', '-y', output_path,
        ], check=True, capture_output=True, text=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Boomerang failed: {e.stderr or e}")
        return False
    finally:
        for p in (reversed_path, forward_path, list_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass

@spaces.GPU(required=True)
def interpolate_video(input_video_path, multi_factor, create_boomerang=False):
    if input_video_path is None:
        return None
    
    safe_input = os.path.join(WORKSPACE_DIR, f"input_{uuid.uuid4().hex}.mp4")
    shutil.copy(input_video_path, safe_input)

    factor = str(multi_factor).strip().replace("x", "")
    session_id = uuid.uuid4().hex
    output_path   = os.path.join(WORKSPACE_DIR, f"output_rife_{session_id}.mp4")
    final_path    = os.path.join(WORKSPACE_DIR, f"final_interp_{session_id}.mp4")
    boomerang_path = os.path.join(WORKSPACE_DIR, f"final_boom_{session_id}.mp4")
    no_audio = output_path.replace(".mp4", "_noaudio.mp4")

    r = run_rife_inference(safe_input, output_path, factor, label="RIFE")

    if r.returncode != 0:
        raise Exception(f"RIFE failed: {r.stderr}")
    
    src = output_path if os.path.exists(output_path) else no_audio
    has_audio = probe_audio_codec(safe_input) != ''
    if has_audio:
        subprocess.run([
            'ffmpeg', '-i', src, '-i', safe_input,
            '-map', '0:v:0', '-map', '1:a:0?',
            *nle_friendly_h264_video_args(),
            *nle_friendly_aac_audio_args(),
            '-movflags', '+faststart',
            '-shortest', '-y', final_path,
        ], check=True, capture_output=True, text=True)
    else:
        subprocess.run([
            'ffmpeg', '-i', src,
            *nle_friendly_h264_video_args(),
            '-an', '-movflags', '+faststart',
            '-y', final_path,
        ], check=True, capture_output=True, text=True)
    
    if create_boomerang:
        fps = get_fps(final_path)
        if create_boomerang_loop(final_path, boomerang_path, fps):
            return boomerang_path
    return final_path

@spaces.GPU(required=True)
def morph_transition(frame_pair_video, frame_count, output_fps=30):
    """Generate a morph segment from a 2-frame clip (A_last, B_first) via RIFE.

    `frame_count` is the number of output frames to keep (spanning the transition
    duration at `output_fps`). Returns a short MP4 of only the in-between frames.
    """
    if frame_pair_video is None:
        return None

    frame_count = max(2, int(frame_count))
    output_fps = max(1.0, float(output_fps))

    safe_input = os.path.join(WORKSPACE_DIR, f"morph_in_{uuid.uuid4().hex}.mp4")
    shutil.copy(frame_pair_video, safe_input)

    session_id = uuid.uuid4().hex
    rife_out = os.path.join(WORKSPACE_DIR, f"morph_rife_{session_id}.mp4")
    morph_out = os.path.join(WORKSPACE_DIR, f"morph_final_{session_id}.mp4")

    # 2-frame input → (2-1)*multi + 1 frames from RIFE; pick multi to cover the
    # target, but cap it. RIFE interpolates recursively, so multi is effectively
    # a depth: past ~8x on a 2-frame pair the extra passes cost real time for
    # marginal quality, and the fps filter below resamples to frame_count
    # anyway. A default 15-frame morph used to run at 14x.
    multi = max(2, min(frame_count - 1, MAX_MORPH_MULTI))

    r = run_rife_inference(safe_input, rife_out, multi, label="RIFE morph")

    if r.returncode != 0:
        raise Exception(f"RIFE morph failed: {r.stderr}")

    src = rife_out if os.path.exists(rife_out) else rife_out.replace(".mp4", "_noaudio.mp4")
    if not os.path.exists(src):
        raise Exception("RIFE morph produced no output file.")

    # Trim to the exact frame count and set output frame rate.
    #
    # RIFE returned multi + 1 frames. Reinterpret them as spanning the intended
    # transition duration (frame_count / output_fps) so the fps filter resamples
    # to exactly frame_count frames — when multi was capped that means the
    # filter duplicates a few, rather than the morph coming out short.
    # Uncapped, in_rate works out to output_fps and this is a no-op.
    rife_frames = multi + 1
    in_rate = rife_frames * output_fps / frame_count
    subprocess.run([
        'ffmpeg', '-r', f'{in_rate:.6f}', '-i', src,
        '-vf', f'fps={output_fps},format=yuv420p',
        '-frames:v', str(frame_count),
        *nle_friendly_h264_video_args(gop=int(output_fps)),
        '-movflags', '+faststart', '-an',
        '-y', morph_out,
    ], check=True, capture_output=True, text=True)

    try:
        os.remove(safe_input)
    except OSError:
        pass

    return morph_out

def stitch_videos(video_files, resolution_choice, audio_file=None, audio_mode="Keep original audio", overlay_vol=1.0, progress=gr.Progress()):
    if not video_files:
        return None
    try:
        target_w, target_h = resolution_choice.split("x")
    except:
        target_w, target_h = "1920", "1080"
    
    session_id = uuid.uuid4().hex
    list_path = os.path.join(WORKSPACE_DIR, f"stitch_list_{session_id}.txt")
    concat_video = os.path.join(WORKSPACE_DIR, f"concat_{session_id}.mp4")
    output_final = os.path.join(WORKSPACE_DIR, f"final_stitched_{session_id}.mp4")
    temp_dir = os.path.join(WORKSPACE_DIR, f"temp_stitch_{session_id}")
    os.makedirs(temp_dir, exist_ok=True)

    # ── Step 1: Normalize clips (scale/pad + common fps for concat) ──
    # Clips that already match the target are stream-copied instead of being
    # re-encoded — the concat demuxer only needs matching codec/resolution/rate,
    # and re-encoding a conforming clip at CRF 18 is pure cost plus a
    # generation loss. Anything that does not match takes the original path.
    # preset=fast keeps quality reasonable while cutting encode time sharply.
    clip_count = len(video_files)
    normalized = []
    copied = 0
    for i, vid_path in enumerate(video_files):
        progress((i / max(clip_count, 1)) * 0.85, desc=f"Normalizing clip {i + 1}/{clip_count}")
        out = os.path.join(temp_dir, f"norm_{i}.mp4")
        if clip_already_conforms(vid_path, target_w, target_h):
            # Remux rather than re-encode: same bitstream, fresh container with
            # the faststart flag the concat step expects.
            subprocess.run([
                'ffmpeg', '-i', vid_path, '-c', 'copy',
                # Same bitstream, but retimed onto the shared timescale so it
                # concats against the re-encoded clips without timestamp drift.
                '-video_track_timescale', str(VIDEO_TRACK_TIMESCALE),
                '-movflags', '+faststart', '-y', out
            ], check=True)
            copied += 1
        elif is_still_image(vid_path) or probe_video_stream(vid_path) is None:
            normalize_still_image_for_stitch(vid_path, out, target_w, target_h)
        else:
            normalize_video_for_stitch(vid_path, out, target_w, target_h)
        normalized.append(out)
    print(f"Stitch: {copied}/{clip_count} clips stream-copied, "
          f"{clip_count - copied} re-encoded")

    # Write concat list
    with open(list_path, 'w') as f:
        for p in normalized:
            f.write(f"file '{p}'\n")
           
    progress(0.9, desc="Concatenating normalized clips")

    # ── Step 2: Concatenate videos (lossless) ───────────────────────
    subprocess.run([
        # +genpts regenerates presentation timestamps across the joins rather
        # than trusting each segment's own; stale ones read as gaps in an
        # editor. muxdelay/muxpreload 0 keeps the result starting at zero.
        'ffmpeg', '-fflags', '+genpts', '-f', 'concat', '-safe', '0',
        '-i', list_path,
        '-c', 'copy',
        '-video_track_timescale', str(VIDEO_TRACK_TIMESCALE),
        '-muxpreload', '0', '-muxdelay', '0',
        '-movflags', '+faststart',
        '-y', concat_video
    ], check=True)

    progress(0.95, desc="Finalizing stitched output")

    # ── Step 3: Audio handling — VIDEO length ALWAYS wins ───────────
    if audio_mode == "Replace with uploaded audio" and audio_file and os.path.exists(audio_file):
        # Replace audio + force full video duration (this fixes the cut-off)
        duration = get_duration(concat_video)
        cmd = [
            'ffmpeg', '-i', concat_video, '-i', audio_file,
            '-filter_complex', '[1:a]apad[a]',
            '-map', '0:v:0', '-map', '[a]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '320k', '-ar', '44100', '-ac', '2',
            '-video_track_timescale', str(VIDEO_TRACK_TIMESCALE),
            '-movflags', '+faststart',
            '-y', output_final
        ]
        if duration:
            # Insert -t right before -y
            cmd.insert(-1, str(duration))
            cmd.insert(-1, '-t')

    elif audio_mode == "Overlay/Mix uploaded audio on top" and audio_file and os.path.exists(audio_file):
        # Mix mode (already correct)
        vol = float(overlay_vol)
        filter_complex = f"[1:a]volume={vol}[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=3[a]"
        cmd = [
            'ffmpeg', '-i', concat_video, '-i', audio_file,
            '-filter_complex', filter_complex,
            '-map', '0:v:0', '-map', '[a]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '320k', '-ar', '44100', '-ac', '2',
            '-video_track_timescale', str(VIDEO_TRACK_TIMESCALE),
            '-shortest', '-movflags', '+faststart', '-y', output_final
        ]
    else:
        # Keep original audio — remux with faststart for broad player/NLE compatibility.
        cmd = [
            'ffmpeg', '-i', concat_video, '-c', 'copy',
            '-video_track_timescale', str(VIDEO_TRACK_TIMESCALE),
            '-movflags', '+faststart', '-y', output_final,
        ]

    subprocess.run(cmd, check=True)

    # Cleanup
    shutil.rmtree(temp_dir, ignore_errors=True)
    for p in [concat_video, list_path]:
        if os.path.exists(p):
            os.remove(p)

    return output_final

# ── Clip reorder: Gallery + pure Python state (no JS bridge) ──────────────────

def gallery_items(thumbs):
    """Gradio Gallery value from (thumb_path, label) pairs."""
    items = []
    for path, label in thumbs:
        if path and os.path.isfile(path):
            items.append((path, label))
    return items

def selection_label(paths, sel):
    if not paths:
        return "_Upload clips above — click a thumbnail to select it._"
    sel = max(0, min(int(sel), len(paths) - 1))
    name = os.path.basename(paths[sel])
    return f"**Selected:** clip **{sel + 1}** of **{len(paths)}** — `{name}`"

def position_choices(count):
    return [str(i + 1) for i in range(count)]

def reorder_panel_outputs(paths, thumbs, sel):
    """Single place to build every Stitch-tab reorder UI update."""
    if not paths:
        return (
            [],
            [],
            gr.update(value=[], selected_index=None),
            0,
            selection_label([], 0),
            gr.update(choices=[], value=None),
        )
    sel = max(0, min(int(sel), len(paths) - 1))
    choices = position_choices(len(paths))
    return (
        paths,
        thumbs,
        gr.update(value=gallery_items(thumbs), selected_index=sel),
        sel,
        selection_label(paths, sel),
        gr.update(choices=choices, value=str(sel + 1)),
    )

def reorder_clip(paths, thumbs, sel, to_idx):
    """Move the selected clip to `to_idx` (0-based) in one step."""
    if not paths:
        return reorder_panel_outputs([], [], 0)
    sel = max(0, min(int(sel), len(paths) - 1))
    to_idx = max(0, min(int(to_idx), len(paths) - 1))
    if sel != to_idx:
        path = paths.pop(sel)
        thumb = thumbs.pop(sel)
        paths.insert(to_idx, path)
        thumbs.insert(to_idx, thumb)
        sel = to_idx
    return reorder_panel_outputs(paths, thumbs, sel)

def handle_upload(files):
    if not files:
        return reorder_panel_outputs([], [], 0)

    paths = []
    for f in files:
        src = f.name if hasattr(f, "name") else str(f)
        ext = os.path.splitext(src)[1].lower()
        if ext not in IMAGE_EXTENSIONS and ext != ".mp4":
            ext = ".mp4"
        dst = os.path.join(WORKSPACE_DIR, f"uploaded_{uuid.uuid4().hex}{ext}")
        shutil.copy(src, dst)
        paths.append(dst)

    thumbs = create_thumbs(paths)
    return reorder_panel_outputs(paths, thumbs, 0)

def on_gallery_select(paths, thumbs, sel, evt: gr.SelectData):
    if not paths or not evt.selected:
        return reorder_panel_outputs(paths or [], thumbs or [], sel)[3:]
    idx = int(evt.index)
    return reorder_panel_outputs(paths, thumbs, idx)[3:]

def move_up(paths, thumbs, sel):
    sel = int(sel)
    return reorder_clip(paths, thumbs, sel, sel - 1)

def move_down(paths, thumbs, sel):
    sel = int(sel)
    return reorder_clip(paths, thumbs, sel, sel + 1)

def move_to_first(paths, thumbs, sel):
    return reorder_clip(paths, thumbs, sel, 0)

def move_to_last(paths, thumbs, sel):
    if not paths:
        return reorder_panel_outputs([], [], 0)
    return reorder_clip(paths, thumbs, sel, len(paths) - 1)

def move_to_position(paths, thumbs, sel, pos):
    if not paths or pos is None:
        return reorder_panel_outputs(paths, thumbs, sel)
    return reorder_clip(paths, thumbs, sel, int(pos) - 1)

def remove_clip(paths, thumbs, sel):
    sel = int(sel)
    if not paths or sel < 0 or sel >= len(paths):
        return reorder_panel_outputs(paths, thumbs, sel)
    delete_thumb_file(thumbs[sel])
    paths = [p for i, p in enumerate(paths) if i != sel]
    thumbs = [t for i, t in enumerate(thumbs) if i != sel]
    new_sel = max(0, min(sel, len(paths) - 1))
    return reorder_panel_outputs(paths, thumbs, new_sel)

def clear_all_clips(_paths, thumbs):
    for thumb in thumbs or []:
        delete_thumb_file(thumb)
    return reorder_panel_outputs([], [], 0)

# ── Gradio UI ─────────────────────────────────────────────────────────────────

with gr.Blocks(title="RIFE + Boomerang + Smart Stitch") as demo:
    gr.Markdown("# 🎞️ RIFE: Interpolate & Boomerang + Smart Stitch")

    with gr.Tabs():

        # ── Tab 1 ─────────────────────────────────────────────────────────────
        with gr.TabItem("1. Smooth Video + Boomerang"):
            gr.Markdown("Upload → choose multiplier → optional boomerang loop")
            with gr.Row():
                with gr.Column():
                    video_input     = gr.Video(label="Input Video")
                    multi_select    = gr.Dropdown(["2","4","8"], value="2",
                                                  label="RIFE Multiplier")
                    boomerang_check = gr.Checkbox(label="Create Boomerang Loop",
                                                  value=False)
                    interp_btn      = gr.Button("▶ Process Video", variant="primary")
                with gr.Column():
                    video_output    = gr.Video(label="Output Video")

            interp_btn.click(interpolate_video,
                             inputs=[video_input, multi_select, boomerang_check],
                             outputs=video_output,
                             api_name="interpolate_video")

        # ── Tab 2 ─────────────────────────────────────────────────────────────
        with gr.TabItem("2. Stitch Videos"):
            gr.Markdown("### Upload clips → select & reorder → stitch")

            stitch_inputs = gr.File(
                label="Upload Video or Still-Image Clips (multiple)",
                file_count="multiple",
                file_types=["video", "image"],
                height=100
            )

            paths_state  = gr.State([])
            thumbs_state = gr.State([])
            sel_state    = gr.State(0)

            clip_gallery = gr.Gallery(
                label="Clip order (left → right) — click a thumbnail to select",
                columns=6,
                height=160,
                object_fit="cover",
                allow_preview=False,
            )
            sel_label = gr.Markdown(selection_label([], 0))

            # ── Reorder controls ──────────────────────────────────────────────
            with gr.Row():
                up_btn    = gr.Button("↑ Up", size="sm", scale=1)
                down_btn  = gr.Button("↓ Down", size="sm", scale=1)
                first_btn = gr.Button("⏮ First", size="sm", scale=1)
                last_btn  = gr.Button("⏭ Last", size="sm", scale=1)
                rm_btn    = gr.Button("✕ Remove", variant="stop", size="sm", scale=1)
                clr_btn   = gr.Button("Clear All", variant="stop", size="sm", scale=1)

            with gr.Row():
                move_to = gr.Dropdown(
                    label="Move selected to position",
                    choices=[],
                    scale=2,
                )
                move_btn = gr.Button("Move →", size="sm", scale=1)

            with gr.Row():
                res_sel    = gr.Dropdown(
                    choices=["1920x1080","1280x1280","1024x1024"],
                    value="1920x1080", label="Output Resolution", scale=2
                )
                stitch_btn = gr.Button("🎬 Stitch in Shown Order",
                                       variant="primary", scale=3)

            stitch_out = gr.Video(label="Stitched Result")

            # ── Audio post-processing (defined AFTER outputs, BEFORE events) ──
            gr.Markdown("### Optional Audio Post-Processing")
            with gr.Row():
                audio_input = gr.Audio(
                    label="Upload Audio Track (supports mp3, wav, m4a, aac, ogg, etc.)",
                    type="filepath",
                    sources=["upload"]  # or ["upload", "microphone"] if you want recording
                )
                audio_mode = gr.Radio(
                    choices=[
                        "Keep original audio",
                        "Replace with uploaded audio",
                        "Overlay/Mix uploaded audio on top"
                    ],
                    value="Keep original audio",
                    label="Audio Mode",
                    scale=2
                )
            audio_volume = gr.Slider(
                minimum=0.0,
                maximum=2.0,
                value=1.0,
                step=0.1,
                label="Overlay Volume Multiplier (only used in Mix mode)",
                visible=False
            )

            # ── Show/hide volume slider based on mode ─────────────────────────
            def show_volume(mode):
                return gr.update(visible=(mode == "Overlay/Mix uploaded audio on top"))

            # Now safe to wire events — all components are already defined
            audio_mode.change(
                show_volume,
                inputs=audio_mode,
                outputs=audio_volume
            )
            

    _reorder_outs = [
        paths_state, thumbs_state, clip_gallery, sel_state, sel_label, move_to,
    ]

    stitch_inputs.change(
        fn=handle_upload, inputs=stitch_inputs, outputs=_reorder_outs,
    )

    clip_gallery.select(
        fn=on_gallery_select,
        inputs=[paths_state, thumbs_state, sel_state],
        outputs=[sel_state, sel_label, move_to],
    )

    up_btn.click(
        fn=move_up,
        inputs=[paths_state, thumbs_state, sel_state],
        outputs=_reorder_outs,
    )

    down_btn.click(
        fn=move_down,
        inputs=[paths_state, thumbs_state, sel_state],
        outputs=_reorder_outs,
    )

    first_btn.click(
        fn=move_to_first,
        inputs=[paths_state, thumbs_state, sel_state],
        outputs=_reorder_outs,
    )

    last_btn.click(
        fn=move_to_last,
        inputs=[paths_state, thumbs_state, sel_state],
        outputs=_reorder_outs,
    )

    move_btn.click(
        fn=move_to_position,
        inputs=[paths_state, thumbs_state, sel_state, move_to],
        outputs=_reorder_outs,
    )

    rm_btn.click(
        fn=remove_clip,
        inputs=[paths_state, thumbs_state, sel_state],
        outputs=_reorder_outs,
    )

    clr_btn.click(
        fn=clear_all_clips,
        inputs=[paths_state, thumbs_state],
        outputs=_reorder_outs,
    )

    stitch_btn.click(
        fn=stitch_videos,
        inputs=[paths_state, res_sel, audio_input, audio_mode, audio_volume],
        outputs=stitch_out
    )

    # ── Headless API endpoint for the clip_stacker web app ───────────────────
    # The UI "Stitch" button takes a gr.State (paths_state) as its first input,
    # which is NOT callable through @gradio/client. This endpoint exposes the
    # same stitch_videos() pipeline with plain gr.File inputs so the web app can
    # call client.predict("/stitch", [...]) directly. Components are hidden — it
    # exists only to register the named "/stitch" API route.
    api_files = gr.File(
        file_count="multiple", file_types=["video", "image"], visible=False,
    )
    api_res = gr.Textbox(value="1920x1080", visible=False)
    api_audio = gr.Audio(type="filepath", sources=["upload"], visible=False)
    api_mode = gr.Textbox(value="Keep original audio", visible=False)
    api_vol = gr.Number(value=1.0, visible=False)
    api_out = gr.Video(visible=False)
    api_btn = gr.Button("stitch_api", visible=False)

    def stitch_api(files, resolution_choice, audio_file, audio_mode, overlay_vol):
        """Normalize every uploaded clip to one resolution, then concat + mux.

        `files` is a list of uploaded video file objects (gr.File multiple). We
        reuse the existing stitch_videos() pipeline, which scales/pads each clip
        to `resolution_choice` so the stitched output keeps one resolution.
        """
        if not files:
            return None
        paths = [f.name if hasattr(f, "name") else str(f) for f in files]
        return stitch_videos(
            paths, resolution_choice, audio_file, audio_mode, overlay_vol,
        )

    api_btn.click(
        fn=stitch_api,
        inputs=[api_files, api_res, api_audio, api_mode, api_vol],
        outputs=api_out,
        api_name="stitch",
    )

    # Headless morph endpoint: 2-frame pair → RIFE in-betweens trimmed to frame_count.
    morph_files = gr.File(file_count="single", file_types=["video"], visible=False)
    morph_frame_count = gr.Number(value=15, visible=False)
    morph_fps = gr.Number(value=30, visible=False)
    morph_out = gr.Video(visible=False)
    morph_btn = gr.Button("morph_api", visible=False)

    def morph_api(frame_pair, frame_count, output_fps):
        if not frame_pair:
            return None
        path = frame_pair.name if hasattr(frame_pair, "name") else str(frame_pair)
        return morph_transition(path, frame_count, output_fps)

    morph_btn.click(
        fn=morph_api,
        inputs=[morph_files, morph_frame_count, morph_fps],
        outputs=morph_out,
        api_name="morph",
    )

if __name__ == "__main__":
    demo.launch()
