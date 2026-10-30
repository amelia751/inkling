"""BlobStore: the local store (dev/tests) always; S3 when `<envPrefix>TEST_S3_ENDPOINT` is set
(MinIO or any S3-compatible server; credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)."""

from __future__ import annotations

import os
import uuid

import pytest

from studio_api import blobstore
from studio_api.naming import env

from .conftest import png, ws


def check_store(store: blobstore.BlobStore) -> None:
    data = bytes(range(256)) * 10
    store.put("dir/sub/blob.bin", data, "application/octet-stream")
    info = store.stat("dir/sub/blob.bin")
    assert info is not None and info.size == len(data)
    assert store.read("dir/sub/blob.bin") == data
    assert b"".join(store.iter_range("dir/sub/blob.bin", 10, 19)) == data[10:20]
    assert b"".join(store.iter_range("dir/sub/blob.bin", 2550)) == data[2550:]
    assert store.stat("dir/sub/missing.bin") is None
    with pytest.raises(blobstore.BlobNotFound):
        store.read("dir/sub/missing.bin")
    for bad in ("../escape", "/abs", "a/../../b", "", "a//b"):
        with pytest.raises(blobstore.BlobNotFound):
            store.read(bad)
    store.delete("dir/sub/blob.bin")
    assert store.stat("dir/sub/blob.bin") is None
    store.ping()


def test_local_store(tmp_path):
    check_store(blobstore.LocalBlobStore(tmp_path))


def test_artifacts_go_to_the_data_store_not_a_local_path(client, tmp_path):
    r = client.post("/api/v1/artifacts", content=png(4, 4), headers=ws("ws-a", **{"Content-Type": "image/png"}))
    art_id = r.json()["artifactId"]
    from studio_api.db import session_scope
    from studio_api.models import Artifact

    with session_scope() as s:
        key = s.get(Artifact, art_id).path
    assert key == f"artifacts/ws-a/{art_id}.png"
    assert (tmp_path / "data" / key).read_bytes() == png(4, 4)


def s3_settings() -> dict | None:
    endpoint = env("TEST_S3_ENDPOINT")
    if not endpoint:
        return None
    return {"blob_store": "s3", "s3_endpoint": endpoint, "s3_bucket": env("TEST_S3_BUCKET") or "test-assets", "s3_region": "us-east-1", "s3_access_key_id": os.environ.get("AWS_ACCESS_KEY_ID"), "s3_secret_access_key": os.environ.get("AWS_SECRET_ACCESS_KEY")}


needs_s3 = pytest.mark.skipif(s3_settings() is None, reason="set <envPrefix>TEST_S3_ENDPOINT to run against S3/MinIO")


def _bucket(cfg: dict, prefix: str) -> blobstore.S3BlobStore:
    st = blobstore.S3BlobStore(cfg["s3_bucket"], prefix, endpoint=cfg["s3_endpoint"], region=cfg["s3_region"], access_key_id=cfg["s3_access_key_id"], secret_access_key=cfg["s3_secret_access_key"])
    try:
        st.client.head_bucket(Bucket=cfg["s3_bucket"])
    except Exception:  # noqa: BLE001
        st.client.create_bucket(Bucket=cfg["s3_bucket"])
    return st


@needs_s3
def test_s3_store():
    cfg = s3_settings()
    assert cfg
    st = _bucket(cfg, f"t-{uuid.uuid4().hex[:8]}")
    check_store(st)
    st.put("p.txt", b"hello", "text/plain")
    url = st.presign("p.txt", 60)
    assert url and "X-Amz-Signature" in url
    import httpx

    assert httpx.get(url).content == b"hello"


@needs_s3
def test_the_kernel_serves_seed_and_signed_assets_from_s3(make_client, seed):
    cfg = s3_settings()
    assert cfg
    prefix = f"seed-{uuid.uuid4().hex[:8]}"
    st = _bucket(cfg, prefix)
    for f in seed.rglob("*"):
        if f.is_file():
            st.put(f.relative_to(seed).as_posix(), f.read_bytes())
    c = make_client(**cfg, s3_prefix=prefix, seed_root=seed.parent / "not-used")
    assert c.get("/readyz").json()["checks"]["blobstore"] == "ok"
    assert c.get("/seed/img/a.png").content == png(40, 30)
    assert c.get("/seed/img/a.png", headers={"Range": "bytes=0-7"}).content == png(40, 30)[:8]
    assets = c.get("/api/v1/assets", headers=ws("ws-a")).json()["assets"]
    assert [a["path"] for a in assets] == ["img/a.png"] and assets[0]["size"] == len(png(40, 30))
    url = c.get(f"/api/v1/assets/{assets[0]['id']}/url", headers=ws("ws-a")).json()["url"]
    assert c.get(url).content == png(40, 30)
    art = c.post("/api/v1/artifacts", content=b"mask", headers=ws("ws-a", **{"Content-Type": "image/png"})).json()["artifactId"]
    assert st.read(f".data/artifacts/ws-a/{art}.png") == b"mask"
