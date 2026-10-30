"""Stream a blob as an HTTP response, with single byte ranges (video seeking, tile pyramids)."""

from __future__ import annotations

import re

from fastapi import Request, Response
from fastapi.responses import StreamingResponse

from .blobstore import BlobNotFound, BlobStore

_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def blob_response(store: BlobStore, key: str, media_type: str, request: Request, *, cache_control: str | None = None) -> Response:
    info = store.stat(key)
    if info is None:
        return Response(status_code=404)
    size = info.size
    headers = {"Accept-Ranges": "bytes"}
    if info.etag:
        headers["ETag"] = f'"{info.etag}"'
    if cache_control:
        headers["Cache-Control"] = cache_control
    start, end, status = 0, size - 1, 200
    m = _RANGE.fullmatch((request.headers.get("range") or "").strip())
    if m and (m.group(1) or m.group(2)):
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        else:
            start, end = max(0, size - int(m.group(2))), size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}", **headers})
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(max(0, end - start + 1))
    if request.method == "HEAD" or size == 0:
        return Response(status_code=status, headers=headers, media_type=media_type)
    try:
        body = store.iter_range(key, start, end)
        first = next(body, b"")  # surfaces a missing object as a 404 before headers go out
    except BlobNotFound:
        return Response(status_code=404)

    def chunks():
        yield first
        yield from body

    return StreamingResponse(chunks(), status_code=status, headers=headers, media_type=media_type)
