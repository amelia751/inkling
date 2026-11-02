"""Sample template bytes on Google Cloud (todo14 §3, §5.2): `tools/fetch-seeds.py` copies the
public sample set into the phi bucket's `samples/` prefix, and the api reads seed assets there
when `API_SAMPLES_PREFIX` is set. Never touches real Cloud Storage: the in-memory stand-in from
test_blobstore_gcs.py plays the bucket."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from studio_api import blobstore, config, db
from studio_api.models import Asset, new_id, now

from .conftest import png, ws
from .test_blobstore_gcs import FakeClient as _BaseClient
from .test_blobstore_gcs import _Blob, _Bucket

REPO = Path(__file__).resolve().parents[3]


def _load_tool():
    spec = importlib.util.spec_from_file_location("fetch_seeds", REPO / "tools" / "fetch-seeds.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["fetch_seeds"] = mod  # dataclasses resolve the module by name
    spec.loader.exec_module(mod)
    return mod


fs = _load_tool()


@pytest.fixture
def seeds(tmp_path: Path) -> tuple[Path, dict]:
    """A seed-data folder with one public and one restricted template (plus a Deep Zoom
    pyramid on the restricted one, so tiles are covered too)."""
    root = tmp_path / "seed-data"

    def put(rel: str, data: bytes) -> dict:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return {"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    xray = [put("2d-xray/normal/a.jpeg", png(40, 30)), put("2d-xray/pneumonia/b.jpeg", png(20, 20))]
    (root / "2d-xray" / "workspace.json").write_text(json.dumps({"plugins": []}))
    put("pathology-wsi/s_files/0/0_0.jpeg", b"tile")
    wsi = [put("pathology-wsi/s.dzi", b"<Image/>"), put("pathology-wsi/s_thumb.jpeg", b"thumb")]
    manifest = {
        "version": 2,
        "projects": [
            {"id": "2d-xray", "status": "available", "license": "CC BY 4.0", "assets": xray},
            {"id": "pathology-wsi", "status": "available", "restricted": True, "license": "Local development only", "assets": wsi},
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root, manifest


class _MetaBlob(_Blob):
    def upload_from_string(self, data, content_type=None):
        super().upload_from_string(data, content_type)
        self.bucket.meta[self.name] = dict(self.metadata or {})

    def upload_from_filename(self, path, content_type=None):
        super().upload_from_filename(path, content_type)
        self.bucket.meta[self.name] = dict(self.metadata or {})


class _MetaBucket(_Bucket):
    """The GCS stand-in, keeping custom metadata (the tool compares its `sha256`)."""

    def __init__(self, name):
        super().__init__(name)
        self.meta: dict[str, dict] = {}

    def blob(self, name, generation=None):
        return _MetaBlob(self, name, generation)

    def get_blob(self, name):
        b = super().get_blob(name)
        if b is not None:
            b.metadata = self.meta.get(name)
        return b


class FakeClient(_BaseClient):
    def bucket(self, name):
        return self.buckets.setdefault(name, _MetaBucket(name))


class RecordingRemote:
    """The tool's remote interface over the fake GCS bucket, counting puts."""

    def __init__(self, target, client: FakeClient):
        self.inner = fs.GCSRemote(target, client=client)
        self.puts: list[str] = []

    def head(self, name):
        return self.inner.head(name)

    def put(self, name, item, content_type):
        self.puts.append(name)
        self.inner.put(name, item, content_type)


def test_parse_target():
    t = fs.parse_target("gs://spurby-phi-objects/samples/")
    assert (t.scheme, t.bucket, t.prefix, t.public_only) == ("gs", "spurby-phi-objects", "samples", True)
    assert t.key("2d-xray/a.jpeg") == "samples/2d-xray/a.jpeg"
    assert fs.parse_target("s3://assets").prefix == "" and not fs.parse_target("s3://assets").public_only
    for bad in ("ftp://b/x", "gs:///x", "gs://b/../x", "spurby-phi-objects/samples"):
        with pytest.raises(ValueError):
            fs.parse_target(bad)


def test_gs_upload_skips_restricted_templates_and_filters_the_manifest(seeds):
    root, manifest = seeds
    client = FakeClient()
    target = fs.parse_target("gs://objects/samples/")
    remote = RecordingRemote(target, client)
    plan = fs.plan_upload(target, manifest, remote, seed=root)
    assert plan.skipped_restricted == ["pathology-wsi"]
    keys = {i.key for i in plan.items}
    assert keys == {"manifest.json", "2d-xray/workspace.json", "2d-xray/normal/a.jpeg", "2d-xray/pneumonia/b.jpeg"}
    assert not any(k.startswith("pathology-wsi/") for k in keys)
    assert fs.run_plan(plan, remote) == 0
    bucket = client.buckets["objects"]
    assert set(bucket.objects) == {f"samples/{k}" for k in keys}
    # The manifest the api reads lists only what was uploaded, and goes up last.
    sent = json.loads(bucket.objects["samples/manifest.json"][-1][0])
    assert [p["id"] for p in sent["projects"]] == ["2d-xray"]
    assert remote.puts[-1] == "samples/manifest.json"
    assert bucket.objects["samples/2d-xray/normal/a.jpeg"][-1][0] == png(40, 30)


def test_gs_upload_never_includes_restricted_even_when_named(seeds):
    root, manifest = seeds
    target = fs.parse_target("gs://objects/samples")
    plan = fs.plan_upload(target, manifest, RecordingRemote(target, FakeClient()), only={"pathology-wsi"}, seed=root)
    assert plan.skipped_restricted == ["pathology-wsi"] and [i.key for i in plan.items] == ["manifest.json"]


def test_s3_dev_upload_keeps_restricted_templates(seeds):
    """Dev object storage (MinIO / RustFS) mirrors seed-data/ as before, tiles included."""
    root, manifest = seeds
    target = fs.parse_target("s3://assets")
    plan = fs.plan_upload(target, manifest, RecordingRemote(fs.parse_target("gs://x"), FakeClient()), seed=root)
    keys = [i.key for i in plan.items]
    assert "pathology-wsi/s.dzi" in keys and "pathology-wsi/s_files/0/0_0.jpeg" in keys and not plan.skipped_restricted
    assert next(i for i in plan.items if i.key == "manifest.json").path == root / "manifest.json"


def test_upload_is_idempotent_and_dry_run_writes_nothing(seeds, capsys):
    root, manifest = seeds
    client = FakeClient()
    target = fs.parse_target("gs://objects/samples/")
    remote = RecordingRemote(target, client)

    dry = fs.plan_upload(target, manifest, remote, seed=root)
    assert fs.run_plan(dry, remote, dry_run=True) == 0
    assert remote.puts == [] and client.buckets["objects"].objects == {}
    assert "would upload 2d-xray/normal/a.jpeg" in capsys.readouterr().out

    fs.run_plan(fs.plan_upload(target, manifest, remote, seed=root), remote)
    first = len(remote.puts)
    again = fs.plan_upload(target, manifest, remote, seed=root)
    assert again.count("upload") == 0 and again.count("skip") == first
    fs.run_plan(again, remote)
    assert len(remote.puts) == first

    # A changed file (new bytes, new sha256 in the manifest) is uploaded again, alone with the manifest.
    changed = png(41, 30)
    (root / "2d-xray" / "normal" / "a.jpeg").write_bytes(changed)
    manifest["projects"][0]["assets"][0] |= {"sha256": hashlib.sha256(changed).hexdigest(), "bytes": len(changed)}
    third = fs.plan_upload(target, manifest, remote, seed=root)
    assert sorted(i.key for i in third.items if i.action == "upload") == ["2d-xray/normal/a.jpeg", "manifest.json"]


def test_missing_local_files_are_reported(seeds):
    root, manifest = seeds
    (root / "2d-xray" / "pneumonia" / "b.jpeg").unlink()
    target = fs.parse_target("gs://objects/samples/")
    remote = RecordingRemote(target, FakeClient())
    plan = fs.plan_upload(target, manifest, remote, seed=root)
    assert [i.key for i in plan.items if i.action == "missing"] == ["2d-xray/pneumonia/b.jpeg"]
    assert fs.run_plan(plan, remote) == 1


def test_cli_refuses_create_bucket_and_bad_targets_for_gs(seeds, monkeypatch, capsys):
    root, _ = seeds
    monkeypatch.setattr(fs, "SEED", root)
    assert fs.main(["--upload-only=gs://objects/samples/", "--create-bucket"]) == 2
    assert fs.main(["--upload-only=ftp://objects/samples/"]) == 2
    assert fs.main(["--bogus"]) == 2


# ---- The api reads seed assets under API_SAMPLES_PREFIX ---------------------------------------


def test_assets_prefix_joins_the_bucket_prefix_and_the_samples_prefix(tmp_path):
    s = config.load_settings(data_dir=tmp_path, secret_key="k")
    assert blobstore.assets_prefix("", s) == ""
    assert blobstore.assets_prefix("/env/", s) == "env"
    s = config.load_settings(data_dir=tmp_path, secret_key="k", samples_prefix="samples/")
    assert blobstore.assets_prefix("", s) == "samples"
    assert blobstore.assets_prefix("env", s) == "env/samples"


def test_samples_prefix_is_read_from_the_env(monkeypatch, tmp_path):
    from studio_api.naming import naming

    monkeypatch.setenv(f"{naming()['envPrefix']}API_SAMPLES_PREFIX", "samples")
    assert config.load_settings(data_dir=tmp_path, secret_key="k").samples_prefix == "samples"
    assert config.key_name("samples_prefix") == f"{naming()['envPrefix']}API_SAMPLES_PREFIX"


def test_the_api_serves_template_and_copy_assets_from_the_samples_prefix(make_client, seeds, monkeypatch):
    """End to end on the fake bucket: the tool uploads, the api reads `samples/…` for the seed
    manifest, `/seed/*`, a template's assets and a copy's asset rows sharing the template's keys,
    while derived data stays under `.data/` at the bucket root."""
    root, manifest = seeds
    client = FakeClient()
    target = fs.parse_target("gs://objects/samples/")
    remote = fs.GCSRemote(target, client=client)
    assert fs.run_plan(fs.plan_upload(target, manifest, remote, seed=root), remote) == 0
    # Something at the bucket root under the same key must not be what the api serves.
    client.bucket("objects")._write("2d-xray/normal/a.jpeg", b"wrong", None)

    real = blobstore.GCSBlobStore
    monkeypatch.setattr(blobstore, "GCSBlobStore", lambda bucket, prefix="", project=None: real(bucket, prefix, client=client))
    blobstore.reset()
    try:
        c = make_client(blob_store="gcs", gcs_bucket="objects", samples_prefix="samples", seed_root=root.parent / "not-used")
        assert blobstore.assets().prefix == "samples/" and blobstore.data().prefix == ".data/"
        assert c.get("/readyz").json()["checks"]["blobstore"] == "ok"
        assert c.get("/seed/2d-xray/normal/a.jpeg").content == png(40, 30)
        assert c.get("/seed/pathology-wsi/s.dzi").status_code == 404  # restricted: never uploaded

        listed = c.get("/api/v1/assets", headers=ws("2d-xray")).json()["assets"]
        assert {a["path"] for a in listed} == {"2d-xray/normal/a.jpeg", "2d-xray/pneumonia/b.jpeg"}
        a = next(x for x in listed if x["path"] == "2d-xray/normal/a.jpeg")
        assert c.get(c.get(f"/api/v1/assets/{a['id']}/url", headers=ws("2d-xray")).json()["url"]).content == png(40, 30)

        # A sample copy (todo14 D2): its own asset row, the template's key, no copied bytes.
        assert c.get("/api/v1/assets", headers=ws("copy-1")).json()["assets"] == []  # the workspace exists, empty
        with db.session_scope() as s:
            s.add(Asset(id=new_id(), workspace_id="copy-1", path="2d-xray/normal/a.jpeg", media_type="image/jpeg", size=len(png(40, 30)), created_at=now()))
        copy = c.get("/api/v1/assets", headers=ws("copy-1")).json()["assets"]
        assert [x["path"] for x in copy] == ["2d-xray/normal/a.jpeg"]
        assert c.get(c.get(f"/api/v1/assets/{copy[0]['id']}/url", headers=ws("copy-1")).json()["url"]).content == png(40, 30)

        art = c.post("/api/v1/artifacts", content=b"mask", headers=ws("copy-1", **{"Content-Type": "image/png"})).json()["artifactId"]
        assert client.buckets["objects"].objects[f".data/artifacts/copy-1/{art}.png"][-1][0] == b"mask"
    finally:
        blobstore.reset()
