"""Item derivatives (todo11 D8, Milestone 3 Slice A): the built-in `items` processor.

Each tick claims a few uploaded items from the kernel (`POST /api/v1/worker/items/claim`; the
kernel hands out on-screen items first and leases each one), reads the bytes, and reports
every stage as soon as it is done, so the Studio upgrades the item in place:

- `probed`: width, height, format (or `failed`: not an image we can read, or a privacy hold
  from its path);
- `thumb_ready`: a ThumbHash and a 256 px WebP thumbnail;
- `preview_ready`: a ~1600 px WebP preview (the original itself when it is already a small
  web image);
- `ready`.

Derivatives go to the kernel, which stores them through the BlobStore; nothing is kept on
local disk. A crash leaves the lease to expire and the item is processed again.
"""

from __future__ import annotations

import io
import logging
import time

import httpx

from . import privacy, thumbhash

THUMB = 256
PREVIEW = 1600
WEB_FORMATS = {"PNG", "JPEG", "WEBP", "GIF"}
MAX_BYTES = 256 << 20
BATCH = 2  # small claims, so a fresh visible-items hint reorders what comes next

log = logging.getLogger("studio_worker.items")


class ItemProcessor:
    def __init__(self, http: httpx.Client):
        self.http = http

    def tick(self) -> int:
        r = self.http.post("/api/v1/worker/items/claim", json={"limit": BATCH})
        r.raise_for_status()
        items = r.json().get("items") or []
        for it in items:
            try:
                self.process(it)
            except httpx.HTTPError as e:  # the lease expires and it's claimed again
                log.warning("item processing failed", extra={"item": it.get("id"), "error": str(e)[:300]})
        return len(items)

    def _send(self, method: str, url: str, **kw) -> httpx.Response:
        """A kernel write, retried briefly on a 5xx (a dev SQLite kernel can be busy with uploads)."""
        for attempt in range(4):
            r = self.http.request(method, url, **kw)
            if r.status_code < 500 or attempt == 3:
                r.raise_for_status()
                return r
            time.sleep(0.1 * (attempt + 1))
        raise AssertionError("unreachable")

    def _report(self, iid: int, stages: list[dict]) -> None:
        self._send("POST", f"/api/v1/worker/items/{iid}/report", json={"stages": stages})

    def _put(self, iid: int, role: str, data: bytes) -> str:
        return self._send("PUT", f"/api/v1/worker/items/{iid}/derived/{role}", content=data, headers={"Content-Type": "image/webp"}).json()["path"]

    def process(self, it: dict) -> str:
        from PIL import Image

        iid = it["id"]
        started = time.monotonic()
        reasons = privacy.path_findings(it.get("relPath") or it.get("name") or "")
        if reasons:
            self._report(iid, [{"stage": "failed", "meta": {"reason": "privacy", "error": "Held: the file's path may identify a person"}}])
            return "failed"
        if int(it.get("size") or 0) > MAX_BYTES:
            self._report(iid, [{"stage": "failed", "meta": {"error": "Too large to preview"}}])
            return "failed"
        r = self.http.get(f"/api/v1/worker/items/{iid}/content", timeout=300)
        r.raise_for_status()
        try:
            img = Image.open(io.BytesIO(r.content))
            img.load()
        except Exception:  # noqa: BLE001 — not an image we can read
            self._report(iid, [{"stage": "failed", "meta": {"error": "We couldn't read this image"}}])
            return "failed"
        fmt = img.format or ""
        w, h = img.size
        self._report(iid, [{"stage": "probed", "meta": {"width": w, "height": h, "format": fmt}}])

        rgb = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
        thumb = rgb.copy()
        thumb.thumbnail((THUMB, THUMB))
        buf = io.BytesIO()
        thumb.save(buf, "WEBP", quality=78, method=2)
        tpath = self._put(iid, "thumb-webp", buf.getvalue())
        self._report(iid, [{"stage": "thumb_ready", "meta": {"thumb": tpath, "thumbhash": thumbhash.of_image(thumb)}}])

        if max(w, h) <= PREVIEW and fmt in WEB_FORMATS:
            ppath = it["itemId"]  # already small and web-decodable: the original is the preview
        else:
            prev = rgb.copy()
            prev.thumbnail((PREVIEW, PREVIEW))
            buf = io.BytesIO()
            prev.save(buf, "WEBP", quality=82, method=2)
            ppath = self._put(iid, "preview-webp", buf.getvalue())
        self._report(iid, [{"stage": "preview_ready", "meta": {"preview": ppath}}, {"stage": "ready", "meta": {"ms": int((time.monotonic() - started) * 1000)}}])
        return "ready"
