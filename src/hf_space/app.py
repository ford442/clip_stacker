import spaces
import os
import shutil
import subprocess
import sys
import numpy as np
import gradio as gr
import base64
import uuid

# --- Constants ---
BASE_DIR = os.getcwd()
RIFE_DIR = os.path.join(BASE_DIR, "Practical-RIFE")
MODEL_URL = "https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip"
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace_temp")

# Ensure our safe workspace directory exists
os.makedirs(WORKSPACE_DIR, exist_ok=True)

# --- Global NumPy patch ---
if not hasattr(np, 'float'):
    np.float = float
if not hasattr(np, 'int'):
    np.int = int

# ── Thumbnail: base64 data URIs ──────────

def extract_thumb_b64(vid_path):
    """Pipe first frame to stdout as JPEG, return data URI. No temp files."""
    try:
        cmd = [
            'ffmpeg', '-i', vid_path,
            '-ss', '00:00:00.5', '-vframes', '1',
            '-vf', 'scale=240:-1',
            '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=10)
        if result.returncode == 0 and result.stdout:
            b64 = base64.b64encode(result.stdout).decode('utf-8')
            return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        print(f"Thumb failed {vid_path}: {e}")
    return None

def create_thumbs(paths):
    """Return list of (data_uri_or_None, label) for each path."""
    out = []
    for i, p in enumerate(paths):
        out.append((extract_thumb_b64(p), f"{i+1}. {os.path.basename(p)}"))
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
import skvideo.io

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

def create_boomerang_loop(input_path, output_path, fps):
    try:
        videodata = skvideo.io.vread(input_path)
        final = np.concatenate((videodata, videodata[::-1]), axis=0)
        skvideo.io.vwrite(output_path, final,
                          inputdict={'-r': str(fps)},
                          outputdict={'-c:v': 'libx264', '-pix_fmt': 'yuv420p',
                                      '-r': str(fps), '-preset': 'slow',
                                      '-crf': '17', '-movflags': '+faststart'})
        return True
    except:
        return False

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

    r = subprocess.run(
        ['python3', 'inference_video.py', '--video', safe_input,
         '--output', output_path, '--multi', factor, '--model', 'HDv3'],
        capture_output=True, text=True, cwd=RIFE_DIR, timeout=300)
    
    if r.returncode != 0:
        raise Exception(f"RIFE failed: {r.stderr}")
    
    src = output_path if os.path.exists(output_path) else no_audio
    subprocess.run(['ffmpeg', '-i', src, '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    '-y', final_path], check=True)
    
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

    # 2-frame input → (2-1)*multi + 1 frames from RIFE; pick multi to cover target.
    multi = max(2, frame_count - 1)

    r = subprocess.run(
        ['python3', 'inference_video.py', '--video', safe_input,
         '--output', rife_out, '--multi', str(multi), '--model', 'HDv3'],
        capture_output=True, text=True, cwd=RIFE_DIR, timeout=300)

    if r.returncode != 0:
        raise Exception(f"RIFE morph failed: {r.stderr}")

    src = rife_out if os.path.exists(rife_out) else rife_out.replace(".mp4", "_noaudio.mp4")
    if not os.path.exists(src):
        raise Exception("RIFE morph produced no output file.")

    # Trim to the exact frame count and set output frame rate.
    subprocess.run([
        'ffmpeg', '-i', src,
        '-vf', f'fps={output_fps}',
        '-frames:v', str(frame_count),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-an',
        '-y', morph_out,
    ], check=True, capture_output=True, text=True)

    try:
        os.remove(safe_input)
    except OSError:
        pass

    return morph_out

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
        
def stitch_videos(video_files, resolution_choice, audio_file=None, audio_mode="Keep original audio", overlay_vol=1.0):
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

    # ── Step 1: Normalize clips — MAX QUALITY ───────────────────────
    normalized = []
    for i, vid_path in enumerate(video_files):
        out = os.path.join(temp_dir, f"norm_{i}.mp4")
        scale = (f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
                 f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2")
        subprocess.run([
            'ffmpeg', '-i', vid_path, '-r', '60', '-vf', scale,
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
            '-c:a', 'aac', '-b:a', '320k', '-ar', '44100',
            '-y', out
        ], check=True)
        normalized.append(out)

    # Write concat list
    with open(list_path, 'w') as f:
        for p in normalized:
            f.write(f"file '{p}'\n")
           
    # ── Step 2: Concatenate videos (lossless) ───────────────────────
    subprocess.run([
        'ffmpeg', '-f', 'concat', '-safe', '0', '-i', list_path,
        '-c', 'copy', '-y', concat_video
    ], check=True)

    # ── Step 3: Audio handling — VIDEO length ALWAYS wins ───────────
    if audio_mode == "Replace with uploaded audio" and audio_file and os.path.exists(audio_file):
        # Replace audio + force full video duration (this fixes the cut-off)
        duration = get_duration(concat_video)
        cmd = [
            'ffmpeg', '-i', concat_video, '-i', audio_file,
            '-filter_complex', '[1:a]apad[a]',
            '-map', '0:v:0', '-map', '[a]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '320k',
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
            '-c:a', 'aac', '-b:a', '320k',
            '-shortest', '-y', output_final
        ]
    else:
        # Keep original audio
        cmd = ['ffmpeg', '-i', concat_video, '-c', 'copy', '-y', output_final]

    subprocess.run(cmd, check=True)

    # Cleanup
    shutil.rmtree(temp_dir, ignore_errors=True)
    for p in [concat_video, list_path]:
        if os.path.exists(p):
            os.remove(p)

    return output_final

# ── Reorder panel: pure Python state + explicit buttons ───────────────────────

def _card_html(i, path, data_uri, selected):
    """One clip card. We add class='clip-card' and data-idx='{i}' to make it clickable by JS."""
    name   = os.path.basename(path)
    border = "3px solid #00ddff" if selected else "2px solid #444"
    bg     = "#0d3a5a" if selected else "#1e1e1e"
    shadow = "0 0 15px #00ddff88" if selected else "none"
    cursor = "default" if selected else "pointer"
    
    img    = (f'<img src="{data_uri}" style="width:100%;height:88px;'
              f'object-fit:cover;border-radius:6px 6px 0 0;display:block;" />'
              if data_uri else
              '<div style="width:100%;height:88px;background:#2a2a2a;'
              'border-radius:6px 6px 0 0;display:flex;align-items:center;'
              'justify-content:center;font-size:28px;color:#555;">🎬</div>')
    
    # Notice the added class="clip-card" and data-idx="{i}"
    return f"""
<div class="clip-card" data-idx="{i}" style="
    width:156px;flex-shrink:0;border-radius:8px;
    border:{border};background:{bg};
    box-shadow:{shadow}; cursor:{cursor};
    transition: all 0.2s ease;
">
    {img}
    <div style="padding:5px 7px;font-size:10px;color:#bbb;
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
         title="{name}">
        <span style="color:#666;margin-right:4px;">#{i+1}</span>{name}
    </div>
</div>"""

def render_panel(paths, thumbs, sel_idx):
    """Render the clip strip as HTML."""
    if not paths:
        return """<div style="
            font-family:monospace;color:#555;text-align:center;
            padding:48px 20px;border:2px dashed #333;border-radius:12px;
            background:#111;font-size:14px;">
            📂 Upload clips above — they'll appear here
        </div>"""

    cards = ""
    for i, path in enumerate(paths):
        uri = thumbs[i][0] if thumbs and i < len(thumbs) else None
        cards += _card_html(i, path, uri, i == sel_idx)

    return f"""<div style="
        background:#111;border-radius:12px;padding:14px;
        border:1px solid #2a2a2a;font-family:monospace;
    ">
        <div style="color:#bbb;font-size:13px;margin-bottom:10px;">
            **Click a clip** to select it, then use ↑ / ↓ to reorder or ✕ to remove.
        </div>
        <div id="clip-container" style="display:flex;flex-wrap:nowrap;gap:10px;
                    overflow-x:auto;padding-bottom:6px;min-height:130px;
                    align-items:flex-start;">
            {cards}
        </div>
    </div>"""

# ── State callbacks ───────────────────────────────────────────────────────────

def handle_upload(files):
    if not files:
        return [], [], render_panel([], [], 0), 1
        
    paths = []
    for f in files:
        src = f.name if hasattr(f, "name") else str(f)
        dst = os.path.join(WORKSPACE_DIR, f"uploaded_{uuid.uuid4().hex}.mp4")
        shutil.copy(src, dst)
        paths.append(dst)
        
    thumbs = create_thumbs(paths)
    return paths, thumbs, render_panel(paths, thumbs, 0), 1

def move_up(paths, thumbs, sel):
    sel = int(sel)
    if not paths or sel <= 0:
        return paths, thumbs, render_panel(paths, thumbs, sel), sel
    paths[sel], paths[sel-1] = paths[sel-1], paths[sel]
    thumbs[sel], thumbs[sel-1] = thumbs[sel-1], thumbs[sel]
    new_sel = sel - 1
    return paths, thumbs, render_panel(paths, thumbs, new_sel), new_sel

def move_down(paths, thumbs, sel):
    sel = int(sel)
    if not paths or sel >= len(paths) - 1:
        return paths, thumbs, render_panel(paths, thumbs, sel), sel
    paths[sel], paths[sel+1] = paths[sel+1], paths[sel]
    thumbs[sel], thumbs[sel+1] = thumbs[sel+1], thumbs[sel]
    new_sel = sel + 1
    return paths, thumbs, render_panel(paths, thumbs, new_sel), new_sel

def remove_clip(paths, thumbs, sel):
    sel = int(sel)
    if not paths or sel < 0 or sel >= len(paths):
        return paths, thumbs, render_panel(paths, thumbs, sel), sel
    paths  = [p for i, p in enumerate(paths)  if i != sel]
    thumbs = [t for i, t in enumerate(thumbs) if i != sel]
    new_sel = max(0, min(sel, len(paths) - 1))
    return paths, thumbs, render_panel(paths, thumbs, new_sel), new_sel

def stitch_videos(video_files, resolution_choice, audio_file=None, audio_mode="Keep original audio", overlay_vol=1.0):
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

    # ── Step 1: Normalize clips ─────────────────────────────────────
    normalized = []
    for i, vid_path in enumerate(video_files):
        out = os.path.join(temp_dir, f"norm_{i}.mp4")
        scale = (f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
                 f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2")
        subprocess.run([
            'ffmpeg', '-i', vid_path, '-r', '60', '-vf', scale,
            '-c:v', 'libx264', '-crf', '23',
            '-c:a', 'aac', '-ar', '44100', '-y', out
        ], check=True)
        normalized.append(out)

    # Write concat list
    with open(list_path, 'w') as f:
        for p in normalized:
            f.write(f"file '{p}'\n")
           
    # ── Step 2: Concatenate videos ─────────────────────────────────
    subprocess.run([
        'ffmpeg', '-f', 'concat', '-safe', '0', '-i', list_path,
        '-c', 'copy', '-y', concat_video
    ], check=True)

    # ── Step 3: Final audio handling (FIXED) ───────────────────────
    cmd = ['ffmpeg', '-i', concat_video, '-y']

    if audio_mode == "Replace with uploaded audio" and audio_file and os.path.exists(audio_file):
        # Replace original audio completely
        cmd += ['-i', audio_file,
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-shortest',
                output_final]

    elif audio_mode == "Overlay/Mix uploaded audio on top" and audio_file and os.path.exists(audio_file):
        # Proper mix: volume only on uploaded track + amix
        vol = float(overlay_vol)
        filter_complex = f"[1:a]volume={vol}[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=3[a]"
        cmd += ['-i', audio_file,
                '-filter_complex', filter_complex,
                '-map', '0:v:0',
                '-map', '[a]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-shortest',
                output_final]
    else:
        # Keep original audio
        cmd += ['-c', 'copy', output_final]

    subprocess.run(cmd, check=True)

    # Cleanup
    shutil.rmtree(temp_dir, ignore_errors=True)
    for p in [concat_video, list_path]:
        if os.path.exists(p):
            os.remove(p)

    return output_final
    
# ── Gradio UI ─────────────────────────────────────────────────────────────────

CSS = """
.clip-strip { overflow-x: auto; }
#sel-num input[type=number] { text-align: center; font-weight: bold; }
.clip-card:hover { transform: translateY(-2px); }
"""

# Global Javascript listener that catches clicks on our HTML cards and updates the hidden bridge textbox
JS_CLICK_HANDLER = """
function() {
    document.addEventListener('click', (e) => {
        let card = e.target.closest('.clip-card');
        if (!card) return;
        
        let idx = card.getAttribute('data-idx');
        
        // Find our hidden Gradio Textbox (Gradio renders textboxes as textarea or input)
        let bridge = document.querySelector('#click_bridge textarea') || document.querySelector('#click_bridge input');
        
        if (bridge) {
            bridge.value = idx;
            // Dispatch a change event so Gradio detects the new value
            bridge.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}
"""

with gr.Blocks(title="RIFE + Boomerang + Smart Stitch", css=CSS) as demo:
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
                label="Upload Video Clips (multiple)",
                file_count="multiple",
                file_types=["video"],
                height=100
            )

            paths_state  = gr.State([])
            thumbs_state = gr.State([])

            clip_panel = gr.HTML(value=render_panel([], [], 0), elem_id="clip_panel")
            
            # Hidden bridge for click detection
            click_bridge = gr.Textbox(visible=False, elem_id="click_bridge")

            # ── Reorder controls ──────────────────────────────────────────────
            with gr.Row():
                sel_num = gr.Number(
                    label="Selected clip # (1 = first)",
                    value=1, minimum=1, precision=0,
                    elem_id="sel-num", scale=1
                )
                up_btn   = gr.Button("↑ Move Up",   size="sm", scale=1)
                down_btn = gr.Button("↓ Move Down", size="sm", scale=1)
                rm_btn   = gr.Button("✕ Remove",    variant="stop", size="sm", scale=1)
                clr_btn  = gr.Button("Clear All",   variant="stop", size="sm", scale=1)

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
            

    # ── helpers: sel_num is 1-based in UI, 0-based in Python ─────────────────
    def _sel0(sel_num):
        return max(0, int(sel_num) - 1)
    def _wrap_up(p, t, s):
        p, t, panel, new_s = move_up(p, t, _sel0(s))
        return p, t, panel, new_s + 1   # back to 1-based

    def _wrap_down(p, t, s):
        p, t, panel, new_s = move_down(p, t, _sel0(s))
        return p, t, panel, new_s + 1

    def _wrap_rm(p, t, s):
        p, t, panel, new_s = remove_clip(p, t, _sel0(s))
        return p, t, panel, new_s + 1

    def _wrap_refresh(p, t, s):
        return render_panel(p, t, _sel0(s))

    # This handles the JS click passing an index back
    def _update_from_click(idx_str):
        if not idx_str or not idx_str.strip().isdigit():
            return 1
        return int(idx_str) + 1  # JS passes 0-based, we convert to 1-based for the UI Number box

    # ── event wiring ─────────────────────────────────────────────────────────
    _panel_outs = [paths_state, thumbs_state, clip_panel, sel_num]

    stitch_inputs.change(fn=handle_upload, inputs=stitch_inputs, outputs=_panel_outs)

    # When the hidden bridge is updated by Javascript, update the visible Number selector
    click_bridge.change(fn=_update_from_click, inputs=click_bridge, outputs=sel_num)

    sel_num.change(fn=_wrap_refresh,
                   inputs=[paths_state, thumbs_state, sel_num],
                   outputs=clip_panel)

    up_btn.click(fn=_wrap_up,
                 inputs=[paths_state, thumbs_state, sel_num],
                 outputs=_panel_outs)

    down_btn.click(fn=_wrap_down,
                   inputs=[paths_state, thumbs_state, sel_num],
                   outputs=_panel_outs)

    rm_btn.click(fn=_wrap_rm,
                 inputs=[paths_state, thumbs_state, sel_num],
                 outputs=_panel_outs)

    clr_btn.click(fn=lambda: ([], [], render_panel([],[],0), 1),
                  outputs=_panel_outs)

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
        file_count="multiple", file_types=["video"], visible=False,
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

    # Load the Javascript into the demo
    demo.load(js=JS_CLICK_HANDLER)

if __name__ == "__main__":
    demo.launch()
