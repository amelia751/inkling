"""Item derivatives (todo11 D8): images dropped into a Studio are probed, get a ThumbHash, a
256 px WebP thumbnail and a ~1600 px preview through the kernel, and report each stage."""

from __future__ import annotations

import base64
import hashlib
import io

import httpx

from studio_worker.inspect import thumbhash
from studio_worker.main import Worker


def _png(w: int, h: int, color=(200, 40, 40)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def test_thumbhash_header_carries_aspect_and_colour():
    from PIL import Image

    h = base64.b64decode(thumbhash.of_image(Image.new("RGB", (200, 100), (255, 0, 0))))
    assert 5 <= len(h) <= 30
    # The reference decoder's approximate aspect ratio (thumbHashToApproximateAspectRatio).
    landscape, has_alpha = h[4] & 0x80, h[2] & 0x80
    lx = (5 if has_alpha else 7) if landscape else h[3] & 7
    ly = h[3] & 7 if landscape else (5 if has_alpha else 7)
    assert landscape and not has_alpha and abs(lx / ly - 2) < 0.5
    # Luminance DC of pure red is ~1/3.
    assert abs((h[0] & 63) / 63 - 1 / 3) < 0.05


def test_dropped_images_get_derivatives_visible_first(stack, tmp_path):
    url = stack["url"]
    p = httpx.post(f"{url}/api/v1/projects", json={"title": "Items"}).json()["id"]
    task = httpx.post(f"{url}/api/v1/projects/{p}/boots", json={"bootId": "boot-items-01", "preset": "preset:image-2d"}).json()["taskIds"][0]
    files = {"big.png": _png(2400, 1200), "small.png": _png(300, 200, (10, 200, 10)), "broken.png": b"\x89PNG not really"}
    body = {"attested": True, "taskId": task, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = httpx.post(f"{url}/api/v1/projects/{p}/imports", json=body).json()
    for f in s["files"]:
        httpx.put(f"{url}{f['uploadUrl']}", content=files[f["relPath"]])
    small = next(i for i in s["items"] if i["name"] == "small.png")
    httpx.post(f"{url}/api/v1/tasks/{task}/items/visible", json={"itemIds": [small["path"]]})

    w = Worker(url, stack["token"], tmp_path, "w-items")
    first = w.items.http.post("/api/v1/worker/items/claim", json={"limit": 1}).json()["items"]
    assert [x["name"] for x in first] == ["small.png"]  # on screen: first
    assert w.items.process(first[0]) == "ready"
    for _ in range(5):
        w.items.tick()

    items = {i["name"]: i for i in httpx.get(f"{url}/api/v1/tasks/{task}/items").json()["items"]}
    big, sm, broken = items["big.png"], items["small.png"], items["broken.png"]
    assert big["ingest"]["state"] == "ready" and (big["width"], big["height"]) == (2400, 1200)
    assert big["ingest"]["thumb"].endswith(".webp") and big["ingest"]["preview"].endswith(".webp") and big["ingest"]["thumbhash"]
    # A small web image is its own preview.
    assert sm["ingest"]["state"] == "ready" and sm["ingest"]["preview"] == sm["path"]
    assert broken["ingest"]["state"] == "failed" and "read" in broken["ingest"]["error"]

    # The derivatives are real WebP files of the promised sizes, served like any asset.
    from PIL import Image

    tok = httpx.post(f"{url}/api/v1/assets/url-token", headers={"X-Workspace-Id": task}).json()

    def fetch(path: str) -> Image.Image:
        r = httpx.get(f"{url}{tok['base']}{path}", params={"exp": tok["exp"], "sig": tok["sig"]})
        assert r.status_code == 200, r.text
        return Image.open(io.BytesIO(r.content))

    t, pv = fetch(big["ingest"]["thumb"]), fetch(big["ingest"]["preview"])
    assert t.format == "WEBP" and t.size == (256, 128)
    assert pv.format == "WEBP" and pv.size == (1600, 800)
