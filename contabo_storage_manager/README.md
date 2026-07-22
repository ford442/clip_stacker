# Chunked / resumable media uploads for clip-stacker
#
# Merge `python/chunked_media_upload.py` into the deployed
# [contabo_storage_manager](https://github.com/ford442/contabo_storage_manager)
# FastAPI app, then reload nginx with the config below.
#
# Client paths (relative to the clip-stacker webhook base, e.g.
# `https://storage.noahcohn.com/webhook/clip-stacker`):
#
#   POST /media/upload/init
#   PUT  /media/upload/{uploadId}/{chunkIndex}
#   POST /media/upload/{uploadId}/complete
#   GET  /media/upload/{uploadId}/status
#
# Defaults: 5 MiB chunks, 10 GiB max file, 24 h staging TTL.
# Small files (< 10 MiB) still use the legacy single-request POST /media.

## Wiring the router

```python
from chunked_media_upload import create_chunked_upload_router

app.include_router(
    create_chunked_upload_router(
        files_dir=settings.files_dir,
        static_base_url=settings.static_base_url,
        ftp_upload=ftp_client.upload,  # optional
    ),
    prefix="/webhook/clip-stacker",
)
```

## Tests

```bash
pip install fastapi httpx pydantic pytest
python -m pytest contabo_storage_manager/python/test_chunked_media_upload.py -q
```
