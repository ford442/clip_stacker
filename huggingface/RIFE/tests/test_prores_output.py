"""Tests for the Space's ProRes output option without running FFmpeg or RIFE."""

import importlib.util
import os
import sys
import types

import pytest


APP_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py")


@pytest.fixture
def app(tmp_path):
    sys.modules.setdefault("spaces", types.SimpleNamespace(
        GPU=lambda *a, **k: (lambda f: f)))
    sys.modules.setdefault("gradio", types.SimpleNamespace(
        Progress=lambda *a, **k: (lambda *_a, **_k: None)))
    sys.modules.setdefault("numpy", types.SimpleNamespace(float=float, int=int))

    with open(APP_PATH) as handle:
        source = handle.read()
    source = source.replace("\nsetup_environment()\n", "\npass\n")
    source = source.replace(
        'WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace_temp")',
        f'WORKSPACE_DIR = {str(tmp_path)!r}',
    )
    ui_marker = "\n# ── Clip reorder"
    assert ui_marker in source, "UI section marker moved; update this fixture"
    source = source[:source.index(ui_marker)]

    spec = importlib.util.spec_from_loader("rife_prores_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = APP_PATH
    exec(compile(source, APP_PATH, "exec"), module.__dict__)
    return module


def test_prores_output_format_and_encoder_args(app):
    assert app.normalize_output_format("prores") == "prores"
    assert app.normalize_output_format("unknown") == "mp4"
    assert app.prores_encoder_args(1) == [
        "-c:v", "prores_ks", "-profile:v", "1",
        "-pix_fmt", "yuv422p10le", "-vendor", "apl0",
    ]
    assert app.prores_encoder_args(2)[3] == "2"
    assert app.prores_encoder_args(3)[3] == "3"
    assert app.prores_encoder_args(9)[3] == "3"


def test_convert_to_prores_uses_the_edit_friendly_profile(app, monkeypatch):
    calls = []
    monkeypatch.setattr(app.subprocess, "run", lambda args, **kwargs: calls.append((args, kwargs)))

    app.convert_to_prores("input.mp4", "output.mov")

    args, kwargs = calls[0]
    assert args == [
        "ffmpeg", "-i", "input.mp4",
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "prores_ks", "-profile:v", "3",
        "-pix_fmt", "yuv422p10le", "-vendor", "apl0",
        "-c:a", "copy", "-movflags", "+faststart",
        "-f", "mov", "-y", "output.mov",
    ]
    assert kwargs["check"] is True


def test_stitch_chunks_are_encoded_as_prores_and_concatenated_by_stream_copy(app, monkeypatch):
    calls = []
    monkeypatch.setattr(app.subprocess, "run", lambda args, **kwargs: calls.append(args))
    monkeypatch.setattr(app, "probe_audio_codec", lambda _path: "aac")

    app.normalize_video_for_stitch(
        "input.mp4", "chunk.mov", 1920, 1080, output_format="prores",
    )
    args = calls[0]
    assert app.prores_encoder_args(3) == args[
        args.index("-c:v"):args.index("-vsync")
    ]
    assert "format=yuv422p10le" in args[args.index("-vf") + 1]
    assert args[-4:] == ["-f", "mov", "-y", "chunk.mov"]

    concat_args = app.build_stitch_concat_args(
        "list.txt", "stitched.mov", output_format="prores",
    )
    assert concat_args[concat_args.index("-c"):concat_args.index("-video_track_timescale")] == [
        "-c", "copy",
    ]
    assert concat_args[-4:] == ["-f", "mov", "-y", "stitched.mov"]


def test_prores_batch_chunks_keep_the_format_and_mov_extension(app, tmp_path, monkeypatch):
    app.WORKSPACE_DIR = str(tmp_path / "workspace")
    os.makedirs(app.WORKSPACE_DIR)
    output = tmp_path / "prores-output.mov"
    output.write_bytes(b"mov")
    called = []

    def fake_chunk(paths, multiplier, fps, output_format="mp4"):
        called.append(output_format)
        return [str(output)]

    monkeypatch.setattr(app, "_interpolate_batch_chunk", fake_chunk)
    job = app.start_batch_job(
        [{"path": "/tmp/input.mp4", "orig_name": "camera clip.mp4"}],
        "2",
        "60",
        "prores",
    )
    job = app.advance_batch_job(job)

    assert called == ["prores"]
    assert os.path.basename(job["results"][0]) == "camera clip.mov"
