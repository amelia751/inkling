"""BlobStore: where asset bytes and derived data live (todo/todo3.md E.2, E.3).

Two namespaces, both behind the same interface:

- `assets()`: seed and uploaded assets. Keys are seed-data relative paths, exactly the
  `path`s in `manifest.json` (plus `manifest.json` itself and `<project>/workspace.json`).
  Local: files under `API_SEED_ROOT` (seed-data/). S3: the `S3_BUCKET` bucket
  (`tools/fetch-seeds.py --upload` fills it).
- `data()`: what the kernel writes (derived artifacts). Local: `API_DATA_DIR`. S3: the same
  bucket under `.data/`; dot-prefixed keys are never served by `/seed/*`.

Replicas therefore share nothing on local disk; only `/tmp` is scratch.
"""

from __future__ import annotations

import hashlib
import os
import posixpath
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .config import Settings, settings

CHUNK = 256 * 1024


class BlobNotFound(KeyError):
    pass


@dataclass(frozen=True)
class BlobInfo:
    size: int
    etag: str | None = None


def safe_key(key: str) -> str:
    """A normalised relative key; rejects traversal, absolute paths and empty segments."""
    if not key or "\x00" in key or "\\" in key or key.startswith("/"):
        raise BlobNotFound(key)
    norm = posixpath.normpath(key)
    if norm in (".", "") or norm.startswith("../") or norm == ".." or norm != key.rstrip("/"):
        raise BlobNotFound(key)
    return norm


class BlobStore(Protocol):
    kind: str

    def stat(self, key: str) -> BlobInfo | None: ...
    def read(self, key: str) -> bytes: ...
    def iter_range(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]: ...
    def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...
    def delete(self, key: str) -> None: ...
    def ping(self) -> None: ...
    def presign(self, key: str, ttl_s: int) -> str | None: ...


class LocalBlobStore:
    """Files under a root directory (dev and tests). Seed folders may be symlinks into a
    shared data checkout, so containment is checked lexically, not after resolving links."""

    kind = "local"

    def __init__(self, root: Path, *, create: bool = False):
        self.root = Path(os.path.normpath(root))
        self.create = create

    def _path(self, key: str) -> Path:
        p = Path(os.path.normpath(self.root / safe_key(key)))
        if self.root not in p.parents:
            raise BlobNotFound(key)
        return p

    def stat(self, key: str) -> BlobInfo | None:
        try:
            p = self._path(key)
        except BlobNotFound:
            return None
        if not p.is_file():
            return None
        st = p.stat()
        return BlobInfo(st.st_size, f"{st.st_mtime_ns:x}-{st.st_size:x}")

    def read(self, key: str) -> bytes:
        p = self._path(key)
        if not p.is_file():
            raise BlobNotFound(key)
        return p.read_bytes()

    def iter_range(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
        p = self._path(key)
        if not p.is_file():
            raise BlobNotFound(key)
        remaining = None if end is None else end - start + 1
        with p.open("rb") as f:
            f.seek(start)
            while remaining is None or remaining > 0:
                chunk = f.read(CHUNK if remaining is None else min(CHUNK, remaining))
                if not chunk:
                    break
                if remaining is not None:
                    remaining -= len(chunk)
                yield chunk

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink(missing_ok=True)
        except BlobNotFound:
            pass

    def ping(self) -> None:
        if self.create:
            self.root.mkdir(parents=True, exist_ok=True)
        if not self.root.is_dir():
            raise RuntimeError("blob store root is missing")

    def presign(self, key: str, ttl_s: int) -> str | None:
        return None


class S3BlobStore:
    """Any S3-compatible store (AWS S3, MinIO, R2…) through boto3."""

    kind = "s3"

    def __init__(self, bucket: str, prefix: str = "", *, endpoint: str | None = None, region: str | None = None, access_key_id: str | None = None, secret_access_key: str | None = None, client: Any = None):
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        if client is None:
            import boto3
            from botocore.config import Config

            cfg = Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}, s3={"addressing_style": "path" if endpoint else "auto"})
            kw: dict = {"endpoint_url": endpoint, "region_name": region, "config": cfg}
            if access_key_id and secret_access_key:
                kw |= {"aws_access_key_id": access_key_id, "aws_secret_access_key": secret_access_key}
            client = boto3.client("s3", **kw)
        self.client = client

    def _k(self, key: str) -> str:
        return self.prefix + safe_key(key)

    @staticmethod
    def _missing(e: Exception) -> bool:
        code = str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
        return code in ("404", "NoSuchKey", "NotFound")

    def stat(self, key: str) -> BlobInfo | None:
        from botocore.exceptions import ClientError

        try:
            h = self.client.head_object(Bucket=self.bucket, Key=self._k(key))
        except BlobNotFound:
            return None
        except ClientError as e:
            if self._missing(e):
                return None
            raise
        return BlobInfo(int(h["ContentLength"]), (h.get("ETag") or "").strip('"') or None)

    def read(self, key: str) -> bytes:
        from botocore.exceptions import ClientError

        try:
            return self.client.get_object(Bucket=self.bucket, Key=self._k(key))["Body"].read()
        except ClientError as e:
            if self._missing(e):
                raise BlobNotFound(key) from None
            raise

    def iter_range(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
        from botocore.exceptions import ClientError

        kw: dict = {"Bucket": self.bucket, "Key": self._k(key)}
        if start or end is not None:
            kw["Range"] = f"bytes={start}-{'' if end is None else end}"
        try:
            body = self.client.get_object(**kw)["Body"]
        except ClientError as e:
            if self._missing(e):
                raise BlobNotFound(key) from None
            raise
        try:
            yield from body.iter_chunks(CHUNK)
        finally:
            body.close()

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        kw: dict = {"Bucket": self.bucket, "Key": self._k(key), "Body": data, "Metadata": {"sha256": hashlib.sha256(data).hexdigest()}}
        if content_type:
            kw["ContentType"] = content_type
        self.client.put_object(**kw)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._k(key))

    def ping(self) -> None:
        self.client.head_bucket(Bucket=self.bucket)

    def presign(self, key: str, ttl_s: int) -> str | None:
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": self._k(key)}, ExpiresIn=ttl_s)


DATA_PREFIX = ".data"

_cache: dict[str, tuple[Settings, BlobStore]] = {}


def _s3(s: Settings, prefix: str) -> S3BlobStore:
    return S3BlobStore(s.s3_bucket, prefix, endpoint=s.s3_endpoint, region=s.s3_region, access_key_id=s.s3_access_key_id, secret_access_key=s.s3_secret_access_key)


def _store(name: str) -> BlobStore:
    s = settings()
    hit = _cache.get(name)
    if hit is None or hit[0] is not s:
        if name == "assets":
            store: BlobStore = _s3(s, s.s3_prefix) if s.blob_store == "s3" else LocalBlobStore(s.seed_root)
        else:
            store = _s3(s, posixpath.join(s.s3_prefix, DATA_PREFIX)) if s.blob_store == "s3" else LocalBlobStore(s.data_dir, create=True)
        hit = _cache[name] = (s, store)
    return hit[1]


def assets() -> BlobStore:
    """Seed / uploaded assets (keys = seed-data relative paths)."""
    return _store("assets")


def data() -> BlobStore:
    """Kernel-written data (derived artifacts)."""
    return _store("data")


def reset() -> None:
    _cache.clear()
