"""Tests for chunked_media_upload FastAPI router.

Run from repo root (with fastapi/httpx installed):

    pip install fastapi httpx pydantic
    python -m pytest contabo_storage_manager/python/test_chunked_media_upload.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chunked_media_upload import DEFAULT_CHUNK_SIZE, create_chunked_upload_router


@pytest.fixture
def client(tmp_path: Path):
    app = FastAPI()
    app.include_router(
        create_chunked_upload_router(
            files_dir=tmp_path,
            static_base_url="https://storage.example.com",
            chunk_size=8,
            max_upload_bytes=1024,
            ttl_seconds=3600,
        ),
        prefix="/webhook/clip-stacker",
    )
    return TestClient(app), tmp_path


def test_init_returns_upload_id_and_chunk_size(client):
    http, _ = client
    response = http.post(
        "/webhook/clip-stacker/media/upload/init",
        json={"name": "clip.mp4", "size": 20, "contentType": "video/mp4"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "uploadId" in data
    assert data["chunkSize"] == 8


def test_chunked_upload_round_trip(client):
    http, tmp_path = client
    payload = b"abcdefghij0123456789"  # 20 bytes → 3 chunks of 8/8/4
    init = http.post(
        "/webhook/clip-stacker/media/upload/init",
        json={"name": "clip.mp4", "size": len(payload)},
    ).json()
    upload_id = init["uploadId"]
    chunk_size = init["chunkSize"]

    for index in range(0, len(payload), chunk_size):
        chunk = payload[index : index + chunk_size]
        end = index + len(chunk) - 1
        chunk_index = index // chunk_size
        response = http.put(
            f"/webhook/clip-stacker/media/upload/{upload_id}/{chunk_index}",
            content=chunk,
            headers={
                "Content-Range": f"bytes {index}-{end}/{len(payload)}",
                "Content-Type": "application/octet-stream",
            },
        )
        assert response.status_code == 200
        assert response.json()["received"] == end + 1

    status = http.get(f"/webhook/clip-stacker/media/upload/{upload_id}/status")
    assert status.status_code == 200
    assert status.json()["receivedChunks"] == [0, 1, 2]

    complete = http.post(f"/webhook/clip-stacker/media/upload/{upload_id}/complete")
    assert complete.status_code == 200
    data = complete.json()
    assert data["url"].startswith("https://storage.example.com/files/clip-stacker/media/")
    assert data["size_bytes"] == len(payload)

    media_files = list((tmp_path / "clip-stacker" / "media").glob("*"))
    assert len(media_files) == 1
    assert media_files[0].read_bytes() == payload


def test_resume_skips_already_received_chunks(client):
    http, _ = client
    payload = b"0123456789abcdef"  # 16 bytes → 2 chunks
    init = http.post(
        "/webhook/clip-stacker/media/upload/init",
        json={"name": "a.bin", "size": len(payload)},
    ).json()
    upload_id = init["uploadId"]

    http.put(
        f"/webhook/clip-stacker/media/upload/{upload_id}/0",
        content=payload[:8],
        headers={"Content-Range": f"bytes 0-7/{len(payload)}"},
    )
    status = http.get(f"/webhook/clip-stacker/media/upload/{upload_id}/status").json()
    assert status["receivedChunks"] == [0]

    # Re-upload chunk 0 (idempotent) and finish with chunk 1.
    http.put(
        f"/webhook/clip-stacker/media/upload/{upload_id}/0",
        content=payload[:8],
        headers={"Content-Range": f"bytes 0-7/{len(payload)}"},
    )
    http.put(
        f"/webhook/clip-stacker/media/upload/{upload_id}/1",
        content=payload[8:],
        headers={"Content-Range": f"bytes 8-15/{len(payload)}"},
    )
    complete = http.post(f"/webhook/clip-stacker/media/upload/{upload_id}/complete")
    assert complete.status_code == 200


def test_complete_rejects_missing_chunks(client):
    http, _ = client
    init = http.post(
        "/webhook/clip-stacker/media/upload/init",
        json={"name": "a.bin", "size": 16},
    ).json()
    upload_id = init["uploadId"]
    http.put(
        f"/webhook/clip-stacker/media/upload/{upload_id}/0",
        content=b"01234567",
        headers={"Content-Range": "bytes 0-7/16"},
    )
    response = http.post(f"/webhook/clip-stacker/media/upload/{upload_id}/complete")
    assert response.status_code == 409


def test_rejects_oversized_init(client):
    http, _ = client
    response = http.post(
        "/webhook/clip-stacker/media/upload/init",
        json={"name": "huge.bin", "size": 10_000},
    )
    assert response.status_code == 413


def test_default_chunk_size_constant():
    assert DEFAULT_CHUNK_SIZE == 5_242_880
