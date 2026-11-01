"""Cloud Storage BlobStore (BLOB_STORE=gcs). Always: against an in-memory stand-in for the
google-cloud-storage client (the calls the backend makes, with the library's 404 type). Against
real Cloud Storage when `<envPrefix>TEST_GCS_BUCKET` is set and Application Default Credentials
can write to it (synthetic bytes only)."""

from __future__ import annotations

import uuid

import pytest
from google.api_core.exceptions import NotFound

from studio_api import blobstore
from studio_api.config import env

from .conftest import png, ws
from .test_blobstore import check_store


class _Blob:
    def __init__(self, bucket: _Bucket, name: str, generation: int | None = None):
        self.bucket, self.name, self.generation = bucket, name, generation
        self.metadata: dict | None = None
        self.size = self.etag = None

    def _obj(self) -> tuple[bytes, int, str | None]:
        versions = self.bucket.objects.get(self.name)
        if not versions:
            raise NotFound(self.name)
        if self.generation is None:
            return versions[-1]
        for v in versions:
            if v[1] == self.generation:
                return v
        raise NotFound(self.name)

    def download_as_bytes(self, start: int | None = None, end: int | None = None) -> bytes:
        data = self._obj()[0]
        self.bucket.downloads += 1
        if start is None:
            return data
        return data[start : None if end is None else end + 1]

    def upload_from_string(self, data: bytes, content_type: str | None = None) -> None:
        self.bucket._write(self.name, data, content_type)

    def upload_from_filename(self, path: str, content_type: str | None = None) -> None:
        with open(path, "rb") as f:
            self.bucket._write(self.name, f.read(), content_type)

    def delete(self) -> None:
        if not self.bucket.objects.pop(self.name, None):
            raise NotFound(self.name)

    def generate_signed_url(self, **kw) -> str:
        return f"https://storage.googleapis.com/{self.bucket.name}/{self.name}?X-Goog-Signature=fake&sa={kw['service_account_email']}"


class _Bucket:
    def __init__(self, name: str):
        self.name = name
        self.objects: dict[str, list[tuple[bytes, int, str | None]]] = {}
        self.generation = 0
        self.downloads = 0

    def _write(self, name: str, data: bytes, content_type: str | None) -> None:
        self.generation += 1
        self.objects.setdefault(name, []).append((data, self.generation, content_type))

    def blob(self, name: str, generation: int | None = None) -> _Blob:
        return _Blob(self, name, generation)

    def get_blob(self, name: str) -> _Blob | None:
        if not self.objects.get(name):
            return None
        data, gen, _ = self.objects[name][-1]
        b = _Blob(self, name, gen)
        b.size, b.etag = len(data), f"etag-{gen}"
        return b


class _Creds:
    valid, token, service_account_email = True, "token", "studio-api@example.iam.gserviceaccount.com"


class FakeClient:
    def __init__(self):
        self.buckets: dict[str, _Bucket] = {}
        self._credentials = _Creds()

    def bucket(self, name: str) -> _Bucket:
        return self.buckets.setdefault(name, _Bucket(name))

    def list_blobs(self, bucket: _Bucket, prefix: str | None = None, max_results: int | None = None):
        names = [n for n in bucket.objects if not prefix or n.startswith(prefix)]
        return iter(names[:max_results])


def test_gcs_store_contract():
    client = FakeClient()
    st = blobstore.GCSBlobStore("b", "pre", client=client)
    check_store(st)
    st.put("x.bin", b"abc")
    assert set(client.buckets["b"].objects) == {"pre/x.bin"}
    assert st.presign("x.bin", 60).startswith("https://storage.googleapis.com/b/pre/x.bin?")


def test_gcs_ranged_reads_stream_in_windows_and_pin_the_generation():
    client = FakeClient()
    st = blobstore.GCSBlobStore("b", client=client)
    big = bytes(range(256)) * (16 * blobstore.CHUNK // 256 + 4)  # one window (16 chunks) + 1 KiB
    st.put("big.bin", big)
    assert b"".join(st.iter_range("big.bin", 5)) == big[5:]
    assert b"".join(st.iter_range("big.bin", 10, 100_000_000)) == big[10:]
    before = client.buckets["b"].downloads
    it = st.iter_range("big.bin")
    first = next(it)
    st.put("big.bin", b"replaced")  # a new generation mid-stream doesn't leak into this read
    assert first + b"".join(it) == big
    assert client.buckets["b"].downloads - before == 2  # two ranged requests, not one per chunk
    assert b"".join(st.iter_range("big.bin")) == b"replaced"
    st.put("empty.bin", b"")
    assert b"".join(st.iter_range("empty.bin")) == b""
    with pytest.raises(blobstore.BlobNotFound):
        list(st.iter_range("missing.bin"))


def test_gcs_presign_is_none_without_a_service_account():
    client = FakeClient()
    client._credentials.service_account_email = None
    st = blobstore.GCSBlobStore("b", client=client)
    st.put("p.txt", b"hello")
    assert st.presign("p.txt", 60) is None


def test_gcs_requires_a_bucket(seed, tmp_path):
    from studio_api import config

    with pytest.raises(config.SettingsError) as e:
        config.load_settings(blob_store="gcs", seed_root=seed, data_dir=tmp_path / "data")
    assert any("GCS_BUCKET" in k for k in e.value.missing)


def test_the_kernel_serves_seed_assets_and_artifacts_from_gcs(make_client, seed, monkeypatch):
    client = FakeClient()
    real = blobstore.GCSBlobStore
    monkeypatch.setattr(blobstore, "GCSBlobStore", lambda bucket, prefix="", project=None: real(bucket, prefix, client=client))
    seeded = real("assets", "seed", client=client)
    for f in seed.rglob("*"):
        if f.is_file():
            seeded.put(f.relative_to(seed).as_posix(), f.read_bytes())
    blobstore.reset()
    c = make_client(blob_store="gcs", gcs_bucket="assets", gcs_prefix="seed", seed_root=seed.parent / "not-used")
    assert c.get("/readyz").json()["checks"]["blobstore"] == "ok"
    assert c.get("/seed/img/a.png").content == png(40, 30)
    assert c.get("/seed/img/a.png", headers={"Range": "bytes=0-7"}).content == png(40, 30)[:8]
    art = c.post("/api/v1/artifacts", content=b"mask", headers=ws("ws-a", **{"Content-Type": "image/png"})).json()["artifactId"]
    assert seeded.read(f".data/artifacts/ws-a/{art}.png") == b"mask"
    blobstore.reset()


needs_gcs = pytest.mark.skipif(not env("TEST_GCS_BUCKET"), reason="set <envPrefix>TEST_GCS_BUCKET (and ADC) to run against Cloud Storage")


@needs_gcs
def test_real_gcs_store():
    bucket = env("TEST_GCS_BUCKET")
    assert bucket
    st = blobstore.GCSBlobStore(bucket, f"t-{uuid.uuid4().hex[:8]}")
    check_store(st)


def test_artifacts_go_to_their_own_bucket(monkeypatch, tmp_path):
    """INKLING_API_ARTIFACTS_BUCKET: content-addressed bundles land in the retention-locked bucket."""
    from studio_api import config

    built: list[str] = []

    class Client:
        def bucket(self, name):
            built.append(name)
            return FakeClient().bucket(name)

    import google.cloud.storage as gstorage

    monkeypatch.setattr(gstorage, "Client", lambda project=None: Client())
    s = config.load_settings(blob_store="gcs", gcs_bucket="objects", artifacts_bucket="artifacts", data_dir=tmp_path, secret_key="k")
    config.set_settings(s)
    blobstore.reset()
    try:
        assert isinstance(blobstore.artifacts(), blobstore.GCSBlobStore) and built[-1] == "artifacts" and blobstore.artifacts().prefix == ""
        blobstore.data()
        assert built[-1] == "objects"
        config.set_settings(config.load_settings(blob_store="gcs", gcs_bucket="objects", data_dir=tmp_path, secret_key="k"))
        assert blobstore.artifacts() is blobstore.data()
    finally:
        blobstore.reset()
