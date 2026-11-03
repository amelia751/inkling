"""Deep Zoom tiles are served with the workspace token as companions of their `.dzi` asset."""

from __future__ import annotations

import json

from studio_api import blobstore
from studio_api import db as kdb
from studio_api.models import Asset

from .conftest import ws


def test_dzi_tiles_are_served_as_companions_of_the_dzi_asset(make_client, seed):
    (seed / "wsi" / "slide_files" / "8").mkdir(parents=True)
    (seed / "wsi" / "slide.dzi").write_text("<Image/>")
    (seed / "wsi" / "slide_files" / "8" / "0_0.jpeg").write_bytes(b"\xff\xd8tile")
    (seed / "wsi" / "other_files").mkdir()
    (seed / "wsi" / "other_files" / "x.jpeg").write_bytes(b"\xff\xd8")
    manifest = json.loads((seed / "manifest.json").read_text())
    manifest["projects"].append({"id": "ws-wsi", "title": "WSI", "assets": [{"path": "wsi/slide.dzi"}]})
    (seed / "manifest.json").write_text(json.dumps(manifest))
    client = make_client()

    tok = client.post("/api/v1/assets/url-token", headers=ws("ws-wsi")).json()
    q = f"exp={tok['exp']}&sig={tok['sig']}"
    r = client.get(f"/api/v1/assets/ws-wsi/files/wsi/slide_files/8/0_0.jpeg?{q}")
    assert r.status_code == 200 and r.content == b"\xff\xd8tile"
    assert r.headers["content-type"] == "image/jpeg"
    # Only tiles of a registered .dzi; no traversal; nothing from another workspace's token.
    assert client.get(f"/api/v1/assets/ws-wsi/files/wsi/other_files/x.jpeg?{q}").status_code == 404
    assert client.get(f"/api/v1/assets/ws-wsi/files/wsi/slide_files/../../img/a.png?{q}").status_code in (403, 404)
    assert client.get(f"/api/v1/assets/ws-a/files/wsi/slide_files/8/0_0.jpeg?{q}").status_code == 403


def test_tiles_of_a_converted_upload_come_from_the_data_store(make_client):
    client = make_client()
    tok = client.post("/api/v1/assets/url-token", headers=ws("ws-a")).json()
    q = f"exp={tok['exp']}&sig={tok['sig']}"
    base = "sources/ws-a/derived/abc"
    with kdb.session_scope() as db:
        db.add(Asset(workspace_id="ws-a", path=f"{base}.dzi", media_type="application/xml", role="derivative", size=8))
    blobstore.data().put(f"{base}.dzi", b"<Image/>")
    blobstore.data().put(f"{base}_files/11/6_0.jpeg", b"\xff\xd8tile")
    r = client.get(f"/api/v1/assets/ws-a/files/{base}_files/11/6_0.jpeg?{q}")
    assert r.status_code == 200 and r.content == b"\xff\xd8tile"
