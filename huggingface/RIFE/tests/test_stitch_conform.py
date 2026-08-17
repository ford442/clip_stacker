"""Tests for the stitch fast path and the morph resample math.

These generate real MP4s with ffmpeg and probe them, so they exercise the
actual ffprobe parsing rather than a mock of it. RIFE itself is not involved.

Run from the Space root:  python -m pytest tests/ -q
"""

import importlib.util
import os
import subprocess
import sys
import types

import pytest

APP_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py")

pytestmark = pytest.mark.skipif(
    subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0,
    reason="ffmpeg not installed")


@pytest.fixture(scope="module")
def app():
    """Execute app.py's processing half, without its import-time side effects.

    The module installs pip packages, clones Practical-RIFE and downloads model
    weights at import time, then builds a whole Gradio app. None of that is
    needed to test ffprobe parsing, so setup_environment() is stubbed out and
    everything from the UI section onward is dropped.
    """
    sys.modules.setdefault("spaces", types.SimpleNamespace(
        GPU=lambda *a, **k: (lambda f: f)))
    sys.modules.setdefault("gradio", types.SimpleNamespace(
        Progress=lambda *a, **k: (lambda *_a, **_k: None)))

    with open(APP_PATH) as handle:
        source = handle.read()
    source = source.replace("\nsetup_environment()\n", "\npass\n")

    ui_marker = "\n# ── Clip reorder"
    assert ui_marker in source, "UI section marker moved; update this fixture"
    source = source[:source.index(ui_marker)]

    spec = importlib.util.spec_from_loader("rife_app", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = APP_PATH
    exec(compile(source, APP_PATH, "exec"), module.__dict__)
    return module


def make_video(path, width=1920, height=1080, fps=30, seconds=1,
               vcodec="libx264", acodec="aac", bf=None, pix_fmt="yuv420p",
               sample_rate=44100):
    cmd = [
        "ffmpeg", "-v", "error",
        "-f", "lavfi", "-i", f"testsrc=size={width}x{height}:rate={fps}:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:v", vcodec, "-pix_fmt", pix_fmt,
    ]
    if bf is not None:
        cmd += ["-bf", str(bf)]
    if acodec is None:
        cmd += ["-an"]
    else:
        cmd += ["-c:a", acodec, "-ar", str(sample_rate), "-ac", "2"]
    cmd += ["-shortest", "-y", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return str(path)


def moov_before_mdat(path):
    """True when the moov atom appears before mdat (faststart)."""
    moov = mdat = None
    with open(path, "rb") as handle:
        offset = 0
        while True:
            header = handle.read(8)
            if len(header) < 8:
                break
            size = int.from_bytes(header[:4], "big")
            typ = header[4:8].decode("latin1")
            if size == 1:
                wide = handle.read(8)
                if len(wide) < 8:
                    break
                size = int.from_bytes(wide, "big")
            if typ == "moov":
                moov = offset
            elif typ == "mdat":
                mdat = offset
            if size < 8:
                break
            offset += size
            handle.seek(offset)
    return moov is not None and (mdat is None or moov < mdat)


def make_still_image(path, width=1920, height=1080):
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi",
        "-i", f"color=c=red:s={width}x{height}",
        "-frames:v", "1", "-y", str(path),
    ], check=True, capture_output=True)
    return str(path)


def test_is_still_image_recognises_common_extensions(app, tmp_path):
    path = make_still_image(tmp_path / "frame.png")
    assert app.is_still_image(path) is True
    video = make_video(tmp_path / "clip.mp4")
    assert app.is_still_image(video) is False


def test_still_image_does_not_conform(app, tmp_path):
    path = make_still_image(tmp_path / "still.png")
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_normalize_still_image_produces_h264_aac(app, tmp_path):
    source = make_still_image(tmp_path / "still.png", 800, 600)
    out = str(tmp_path / "norm.mp4")
    app.normalize_still_image_for_stitch(source, out, "1920", "1080", duration=2)

    info = app.probe_video_stream(out)
    assert info is not None
    assert info["codec"] == "h264"
    assert info["width"] == 1920
    assert info["height"] == 1080
    assert info["fps"] == pytest.approx(app.STITCH_FPS, abs=0.05)
    assert app.probe_audio_codec(out) == "aac"
    duration = app.get_duration(out)
    assert duration == pytest.approx(2.0, abs=0.15)

    pix_fmt = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=pix_fmt,profile", "-of",
         "default=noprint_wrappers=1:nokey=1", out],
        check=True, capture_output=True, text=True,
    ).stdout.strip().splitlines()
    assert "yuv420p" in pix_fmt
    assert any("High" in line for line in pix_fmt)


def probe(path, entries, stream="v:0"):
    """Map ffprobe stream fields by name — it emits them in its own order."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", entries, "-of", "default=noprint_wrappers=1", path],
        check=True, capture_output=True, text=True,
    ).stdout.strip().splitlines()
    return dict(line.split("=", 1) for line in out if "=" in line)


def test_normalized_still_is_tagged_and_square_pixel(app, tmp_path):
    """Editors read these tags literally; leaving them unset is the bug."""
    source = make_still_image(tmp_path / "still.png", 800, 600)
    out = str(tmp_path / "norm.mp4")
    app.normalize_still_image_for_stitch(source, out, "1920", "1080", duration=1)

    fields = probe(out, "stream=color_space,color_primaries,color_transfer,"
                        "sample_aspect_ratio,time_base")
    assert fields["color_space"] == "bt709"
    assert fields["color_primaries"] == "bt709"
    assert fields["color_transfer"] == "bt709"
    assert fields["sample_aspect_ratio"] == "1:1"  # square pixels after setsar
    assert fields["time_base"] == f"1/{app.VIDEO_TRACK_TIMESCALE}"


def test_stitched_output_is_constant_rate_on_one_timescale(app, tmp_path):
    """A still + a video must join without VFR timestamps or a shifted start."""
    still = make_still_image(tmp_path / "still.png", 640, 480)
    video = make_video(tmp_path / "clip.mp4", 640, 480, 30, seconds=1)
    out = app.stitch_videos([still, video], "1920x1080")

    fields = probe(
        out, "stream=avg_frame_rate,r_frame_rate,time_base,start_time")
    assert fields["time_base"] == f"1/{app.VIDEO_TRACK_TIMESCALE}"
    # r_frame_rate is derived from the actual frame spacing: an exact 30/1
    # means no join left a short or long frame behind.
    assert fields["r_frame_rate"] == f"{app.STITCH_FPS}/1"
    num, den = (int(x) for x in fields["avg_frame_rate"].split("/"))
    assert num / den == pytest.approx(app.STITCH_FPS, abs=0.2)
    # Only the AAC priming offset (1024/44100 ≈ 0.023s) may remain; anything
    # larger means a join left the video shifted against its own timeline.
    assert float(fields["start_time"]) < 0.03
    assert probe(out, "stream=has_b_frames")["has_b_frames"] == "0"


def test_still_image_thumb_is_jpeg_file(app, tmp_path):
    path = make_still_image(tmp_path / "still.png")
    thumb = app.extract_thumb_path(path)
    assert thumb is not None
    assert os.path.isfile(thumb)
    assert thumb.endswith('.jpg')
    assert os.path.getsize(thumb) > 0


def test_stitch_videos_accepts_still_image_plus_video(app, tmp_path):
    still = make_still_image(tmp_path / "still.png", 640, 480)
    video = make_video(tmp_path / "clip.mp4", 640, 480, 30, seconds=1)
    out = app.stitch_videos([still, video], "1920x1080")
    assert out is not None
    assert os.path.exists(out)
    info = app.probe_video_stream(out)
    assert info is not None
    assert info["width"] == 1920
    assert info["height"] == 1080
    duration = app.get_duration(out)
    assert duration is not None
    # Default 5s still + ~1s video.
    assert duration == pytest.approx(6.0, abs=0.5)


def test_probe_reads_real_stream_properties(app, tmp_path):
    path = make_video(tmp_path / "a.mp4", width=1280, height=720, fps=25)
    info = app.probe_video_stream(path)
    assert info["width"] == 1280
    assert info["height"] == 720
    assert info["codec"] == "h264"
    assert info["fps"] == pytest.approx(25.0, abs=0.01)


def test_probe_returns_none_for_a_non_video(app, tmp_path):
    path = tmp_path / "not-a-video.mp4"
    path.write_bytes(b"definitely not an mp4")
    assert app.probe_video_stream(str(path)) is None


def test_conforming_clip_is_recognised(app, tmp_path):
    path = make_video(tmp_path / "ok.mp4", 1920, 1080, 30, bf=0)
    assert app.clip_already_conforms(path, "1920", "1080") is True


def test_ntsc_frame_rate_still_conforms(app, tmp_path):
    """29.97 is within tolerance; resampling it would be wasted work."""
    path = make_video(tmp_path / "ntsc.mp4", 1920, 1080, "30000/1001", bf=0)
    info = app.probe_video_stream(path)
    assert info["fps"] == pytest.approx(29.97, abs=0.01)
    assert app.clip_already_conforms(path, "1920", "1080") is True


def test_b_frame_clip_does_not_conform(app, tmp_path):
    """Default libx264 B-frames write edit lists that Cubase rejects."""
    path = make_video(tmp_path / "bframes.mp4", 1920, 1080, 30, bf=2)
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_yuv444_clip_does_not_conform(app, tmp_path):
    path = make_video(
        tmp_path / "444.mp4", 1920, 1080, 30, bf=0, pix_fmt="yuv444p")
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_non_44100_aac_does_not_conform(app, tmp_path):
    path = make_video(tmp_path / "48k.mp4", 1920, 1080, 30, bf=0, sample_rate=48000)
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_mono_aac_does_not_conform(app, tmp_path):
    path = tmp_path / "mono.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "0",
        "-c:a", "aac", "-ar", "44100", "-ac", "1",
        "-shortest", "-y", str(path),
    ], check=True, capture_output=True)
    assert app.clip_already_conforms(str(path), "1920", "1080") is False


def test_wrong_resolution_does_not_conform(app, tmp_path):
    path = make_video(tmp_path / "small.mp4", 1280, 720, 30)
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_wrong_frame_rate_does_not_conform(app, tmp_path):
    path = make_video(tmp_path / "24fps.mp4", 1920, 1080, 24)
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_wrong_video_codec_does_not_conform(app, tmp_path):
    path = make_video(tmp_path / "mpeg4.mp4", 1920, 1080, 30, vcodec="mpeg4")
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_missing_audio_does_not_conform(app, tmp_path):
    """Concat needs matching stream layouts, or the mix desyncs."""
    path = make_video(tmp_path / "silent.mp4", 1920, 1080, 30, acodec=None)
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_non_aac_audio_does_not_conform(app, tmp_path):
    path = make_video(tmp_path / "mp3.mp4", 1920, 1080, 30, acodec="libmp3lame")
    assert app.clip_already_conforms(path, "1920", "1080") is False


def test_unreadable_file_does_not_conform(app, tmp_path):
    path = tmp_path / "missing.mp4"
    assert app.clip_already_conforms(str(path), "1920", "1080") is False


def test_stitched_video_only_clip_gets_silent_aac_and_faststart(app, tmp_path):
    """A 1080p30 H.264 clip without audio must leave the Space Cubase-ready."""
    silent = make_video(tmp_path / "silent.mp4", 1920, 1080, 30, bf=2, acodec=None)
    out = app.stitch_videos([silent], "1920x1080")
    assert app.probe_audio_codec(out) == "aac"
    layout = app.probe_audio_layout(out)
    assert layout["sample_rate"] == 44100
    assert layout["channels"] == 2
    nle = app.probe_nle_video_fields(out)
    assert nle["pix_fmt"] == "yuv420p"
    assert nle["has_b_frames"] == 0
    assert nle["r_fps"] == pytest.approx(app.STITCH_FPS, abs=0.2)
    assert moov_before_mdat(out)


def test_stitched_b_frame_source_is_reencoded(app, tmp_path):
    source = make_video(tmp_path / "src.mp4", 1920, 1080, 30, bf=3)
    assert app.clip_already_conforms(source, "1920", "1080") is False
    out = app.stitch_videos([source], "1920x1080")
    assert app.probe_nle_video_fields(out)["has_b_frames"] == 0
    assert app.probe_audio_codec(out) == "aac"
    assert moov_before_mdat(out)


def test_stream_copy_preserves_the_bitstream(app, tmp_path):
    """The fast path must be lossless, not just fast."""
    source = make_video(tmp_path / "src.mp4", 1920, 1080, 30)
    remuxed = str(tmp_path / "out.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-i", source, "-c", "copy",
                    "-movflags", "+faststart", "-y", remuxed],
                   check=True, capture_output=True)

    def video_md5(path):
        return subprocess.run(
            ["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0",
             "-f", "md5", "-"],
            check=True, capture_output=True, text=True).stdout

    assert video_md5(source) == video_md5(remuxed)


# ── Morph resample math ───────────────────────────────────────────────────────

def morph_rates(frame_count, output_fps, max_multi):
    """Mirror of the multi / in_rate calculation in morph_transition."""
    multi = max(2, min(frame_count - 1, max_multi))
    rife_frames = multi + 1
    return multi, rife_frames * output_fps / frame_count


def test_morph_multi_is_capped(app):
    assert app.MAX_MORPH_MULTI == 8
    multi, _ = morph_rates(15, 30, app.MAX_MORPH_MULTI)
    assert multi == 8  # was 14 before the cap


def test_morph_multi_uncapped_below_the_limit(app):
    for frame_count in range(3, 10):
        multi, in_rate = morph_rates(frame_count, 30, app.MAX_MORPH_MULTI)
        assert multi == frame_count - 1
        # Uncapped, the reinterpretation is a no-op.
        assert in_rate == pytest.approx(30.0)


def test_morph_capped_rate_preserves_duration(app):
    """Capping multi must not shorten the transition."""
    frame_count, output_fps = 15, 30
    multi, in_rate = morph_rates(frame_count, output_fps, app.MAX_MORPH_MULTI)
    rife_frames = multi + 1
    assert rife_frames / in_rate == pytest.approx(frame_count / output_fps)


def test_capped_morph_still_yields_the_requested_frame_count(app, tmp_path):
    """Run the real ffmpeg resample on a stand-in for RIFE's output."""
    frame_count, output_fps = 15, 30
    multi, in_rate = morph_rates(frame_count, output_fps, app.MAX_MORPH_MULTI)

    rife_stub = str(tmp_path / "rife.mp4")
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi",
        "-i", f"testsrc=size=320x240:rate=1:duration={multi + 1}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", rife_stub,
    ], check=True, capture_output=True)

    out = str(tmp_path / "morph.mp4")
    subprocess.run([
        "ffmpeg", "-v", "error", "-r", f"{in_rate:.6f}", "-i", rife_stub,
        "-vf", f"fps={output_fps}", "-frames:v", str(frame_count),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", out,
    ], check=True, capture_output=True)

    count = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=nb_read_frames", "-of",
         "default=noprint_wrappers=1:nokey=1", out],
        check=True, capture_output=True, text=True).stdout.strip()
    assert int(count) == frame_count
