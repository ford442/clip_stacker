"""
Chunked, resumable media upload endpoints for clip-stacker.

Drop this module into contabo_storage_manager and include the router on the
existing webhook app (paths are relative to `/webhook/clip-stacker`):

    from chunked_media_upload import create_chunked_upload_router

    app.include_router(
        create_chunked_upload_router(
            files_dir=settings.files_dir,
            static_base_url=settings.static_base_url,
            ftp_upload=ftp_client.upload,  # optional
        ),
        prefix="/webhook/clip-stacker",
    )

Protocol (tus-inspired, session-based):

    POST   /media/upload/init
    PUT    /media/upload/{uploadId}/{chunkIndex}
    POST   /media/upload/{uploadId}/complete
    GET    /media/upload/{uploadId}/status
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 5_242_880  # 5 MiB
DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024  # 10 GiB
DEFAULT_TTL_SECONDS = 24 * 60 * 60  # 24 h
UPLOAD_META_NAME = "meta.json"
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


class InitUploadRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=512)
    size: int = Field(..., gt=0)
    contentType: Optional[str] = Field(default="application/octet-stream")


FtpUploadFn = Callable[[Path, str], Awaitable[Optional[str]]]


def _safe_filename(name: str) -> str:
    cleaned = SAFE_NAME_RE.sub("_", name).strip("._") or "file"
    return cleaned[:200]


def _ts_slug() -> str:
    return time.strftime("%Y%m%dT%H%M%S")


def create_chunked_upload_router(
    *,
    files_dir: str | Path,
    static_base_url: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ftp_upload: Optional[FtpUploadFn] = None,
) -> APIRouter:
    """Build a FastAPI router with chunked upload endpoints."""

    router = APIRouter(tags=["clip-stacker-chunked-upload"])
    staging_root = Path(files_dir) / "clip-stacker" / "uploads"
    media_root = Path(files_dir) / "clip-stacker" / "media"
    staging_root.mkdir(parents=True, exist_ok=True)
    media_root.mkdir(parents=True, exist_ok=True)

    def _upload_dir(upload_id: str) -> Path:
        # UUID hex only — reject path traversal.
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", upload_id):
            raise HTTPException(status_code=400, detail="Invalid uploadId")
        return staging_root / upload_id

    def _read_meta(upload_dir: Path) -> dict:
        meta_path = upload_dir / UPLOAD_META_NAME
        if not meta_path.is_file():
            raise HTTPException(status_code=404, detail="Upload session not found")
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.error("Corrupt upload meta at %s: %s", meta_path, exc)
            raise HTTPException(status_code=500, detail="Corrupt upload session") from exc

    def _write_meta(upload_dir: Path, meta: dict) -> None:
        meta_path = upload_dir / UPLOAD_META_NAME
        tmp = meta_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta), encoding="utf-8")
        tmp.replace(meta_path)

    def _gc_abandoned() -> None:
        now = time.time()
        try:
            for child in staging_root.iterdir():
                if not child.is_dir():
                    continue
                meta_path = child / UPLOAD_META_NAME
                try:
                    if meta_path.is_file():
                        meta = json.loads(meta_path.read_text(encoding="utf-8"))
                        created = float(meta.get("createdAt", 0))
                    else:
                        created = child.stat().st_mtime
                except (OSError, json.JSONDecodeError, TypeError, ValueError):
                    created = child.stat().st_mtime
                if now - created > ttl_seconds:
                    shutil.rmtree(child, ignore_errors=True)
                    logger.info("Garbage-collected abandoned upload %s", child.name)
        except OSError as exc:
            logger.warning("Upload GC failed: %s", exc)

    def _cors_headers() -> dict[str, str]:
        return {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": (
                "Content-Type, Authorization, Content-Range, Content-Length"
            ),
            "Access-Control-Max-Age": "86400",
            "Cross-Origin-Resource-Policy": "cross-origin",
        }

    @router.options("/media/upload/init")
    @router.options("/media/upload/{upload_id}/status")
    @router.options("/media/upload/{upload_id}/complete")
    @router.options("/media/upload/{upload_id}/{chunk_index}")
    async def upload_options() -> Response:
        return Response(status_code=204, headers=_cors_headers())

    @router.post("/media/upload/init")
    async def init_upload(body: InitUploadRequest) -> JSONResponse:
        _gc_abandoned()
        if body.size > max_upload_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File exceeds max upload size ({max_upload_bytes} bytes)",
            )

        upload_id = str(uuid.uuid4())
        upload_dir = _upload_dir(upload_id)
        upload_dir.mkdir(parents=True, exist_ok=False)
        (upload_dir / "chunks").mkdir()

        meta = {
            "uploadId": upload_id,
            "name": _safe_filename(body.name),
            "originalName": body.name,
            "size": body.size,
            "contentType": body.contentType or "application/octet-stream",
            "chunkSize": chunk_size,
            "createdAt": time.time(),
            "receivedChunks": [],
        }
        _write_meta(upload_dir, meta)

        return JSONResponse(
            {"uploadId": upload_id, "chunkSize": chunk_size},
            headers=_cors_headers(),
        )

    @router.get("/media/upload/{upload_id}/status")
    async def upload_status(upload_id: str) -> JSONResponse:
        _gc_abandoned()
        upload_dir = _upload_dir(upload_id)
        if not upload_dir.is_dir():
            raise HTTPException(status_code=404, detail="Upload session not found")
        meta = _read_meta(upload_dir)
        received = sorted(int(i) for i in meta.get("receivedChunks", []))
        return JSONResponse(
            {
                "uploadId": upload_id,
                "receivedChunks": received,
                "chunkSize": meta.get("chunkSize", chunk_size),
                "totalSize": meta.get("size"),
                "name": meta.get("name"),
            },
            headers=_cors_headers(),
        )

    @router.put("/media/upload/{upload_id}/{chunk_index}")
    async def upload_chunk(
        upload_id: str,
        chunk_index: int,
        request: Request,
    ) -> JSONResponse:
        if chunk_index < 0:
            raise HTTPException(status_code=400, detail="Invalid chunkIndex")

        upload_dir = _upload_dir(upload_id)
        if not upload_dir.is_dir():
            raise HTTPException(status_code=404, detail="Upload session not found")
        meta = _read_meta(upload_dir)

        total_size = int(meta["size"])
        session_chunk_size = int(meta.get("chunkSize", chunk_size))
        expected_chunks = (total_size + session_chunk_size - 1) // session_chunk_size
        if chunk_index >= expected_chunks:
            raise HTTPException(status_code=400, detail="chunkIndex out of range")

        start = chunk_index * session_chunk_size
        end = min(start + session_chunk_size, total_size) - 1
        expected_len = end - start + 1

        content_range = request.headers.get("content-range")
        if content_range:
            match = re.fullmatch(
                r"bytes\s+(\d+)-(\d+)/(\d+|\*)",
                content_range.strip(),
                flags=re.IGNORECASE,
            )
            if not match:
                raise HTTPException(status_code=400, detail="Invalid Content-Range")
            range_start = int(match.group(1))
            range_end = int(match.group(2))
            range_total = match.group(3)
            if range_start != start or range_end != end:
                raise HTTPException(
                    status_code=400,
                    detail=f"Content-Range mismatch; expected bytes {start}-{end}/{total_size}",
                )
            if range_total != "*" and int(range_total) != total_size:
                raise HTTPException(status_code=400, detail="Content-Range total mismatch")

        body = await request.body()
        if len(body) != expected_len:
            raise HTTPException(
                status_code=400,
                detail=f"Chunk length mismatch; expected {expected_len} bytes",
            )
        if len(body) > session_chunk_size:
            raise HTTPException(status_code=413, detail="Chunk exceeds configured chunkSize")

        chunk_path = upload_dir / "chunks" / f"{chunk_index:08d}.part"
        tmp_path = chunk_path.with_suffix(".tmp")
        tmp_path.write_bytes(body)
        tmp_path.replace(chunk_path)

        received = set(int(i) for i in meta.get("receivedChunks", []))
        received.add(chunk_index)
        meta["receivedChunks"] = sorted(received)
        meta["updatedAt"] = time.time()
        _write_meta(upload_dir, meta)

        return JSONResponse(
            {"received": end + 1, "chunkIndex": chunk_index},
            headers=_cors_headers(),
        )

    @router.post("/media/upload/{upload_id}/complete")
    async def complete_upload(upload_id: str) -> JSONResponse:
        upload_dir = _upload_dir(upload_id)
        if not upload_dir.is_dir():
            raise HTTPException(status_code=404, detail="Upload session not found")
        meta = _read_meta(upload_dir)

        total_size = int(meta["size"])
        session_chunk_size = int(meta.get("chunkSize", chunk_size))
        expected_chunks = (total_size + session_chunk_size - 1) // session_chunk_size
        received = set(int(i) for i in meta.get("receivedChunks", []))
        missing = [i for i in range(expected_chunks) if i not in received]
        if missing:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "Upload incomplete",
                    "missingChunks": missing[:50],
                    "missingCount": len(missing),
                },
            )

        safe_name = _safe_filename(str(meta.get("name") or "file"))
        final_name = f"{_ts_slug()}_{safe_name}"
        final_path = media_root / final_name

        # Assemble chunks in order.
        with open(final_path, "wb") as out:
            for index in range(expected_chunks):
                part = upload_dir / "chunks" / f"{index:08d}.part"
                if not part.is_file():
                    final_path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=409,
                        detail=f"Missing chunk file for index {index}",
                    )
                out.write(part.read_bytes())

        assembled_size = final_path.stat().st_size
        if assembled_size != total_size:
            final_path.unlink(missing_ok=True)
            raise HTTPException(
                status_code=500,
                detail=f"Assembled size mismatch ({assembled_size} != {total_size})",
            )

        local_rel_path = f"clip-stacker/media/{final_name}"
        if ftp_upload is not None:
            try:
                await ftp_upload(final_path, local_rel_path)
            except Exception as exc:  # noqa: BLE001 — non-fatal, file is local
                logger.warning("FTP upload failed for %s (non-fatal): %s", local_rel_path, exc)

        shutil.rmtree(upload_dir, ignore_errors=True)

        base_url = str(static_base_url).rstrip("/")
        # Prefer /files/ prefix used by contabo_storage_manager static serving.
        public_url = f"{base_url}/files/{local_rel_path}"

        return JSONResponse(
            {
                "url": public_url,
                "local_path": local_rel_path,
                "size_bytes": assembled_size,
            },
            headers=_cors_headers(),
        )

    return router
