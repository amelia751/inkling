"""Blob staging for service principals (todo12 §4 M1, for the pipeline's staged outputs).

    PUT /api/v1/service/blobs/{key}   headers X-Content-SHA256, Content-Type → ArtifactRef {key, sha256, size, media_type}
    GET /api/v1/service/blobs/{key}   the bytes (Range works), with X-Content-SHA256

The pipeline has no Google identity (E6), so it stages outputs through the api's BlobStore.
Keys must be under `pipeline/` (`pipeline/<run>/<step>/<attempt>/…`, attempt-unique), so a
service can't touch anything else in the data area. The kernel hashes what it receives and
refuses a mismatch with the declared SHA-256 (422). Staged blobs are immutable: the same key
again with the same bytes returns the same ref (a retried step), with different bytes it's a
409. Each blob's ref is kept beside it under `service-refs/`, so the overwrite check and the
GET's media type need no re-read of the bytes.
"""

from __future__ import annotations

import hashlib
import json
import re

from fastapi import HTTPException

from .. import blobstore

PREFIX = "pipeline/"
REFS = "service-refs/"
SHA_RE = re.compile(r"^(sha256:)?[0-9a-f]{64}$")


def _key(key: str) -> str:
    try:
        k = blobstore.safe_key(key)
    except blobstore.BlobNotFound:
        raise HTTPException(422, "bad blob key") from None
    if not k.startswith(PREFIX) or k == PREFIX.rstrip("/"):
        raise HTTPException(403, f"service blobs live under {PREFIX}")
    return k


def _ref_key(key: str) -> str:
    return f"{REFS}{key}.json"


def ref(key: str) -> dict | None:
    store = blobstore.data()
    try:
        return json.loads(store.read(_ref_key(key)))
    except (blobstore.BlobNotFound, FileNotFoundError, KeyError):
        return None


def put(key: str, data: bytes, declared_sha256: str | None, media_type: str | None) -> tuple[dict, bool]:
    """→ (ArtifactRef, created)."""
    k = _key(key)
    if not declared_sha256 or not SHA_RE.fullmatch(declared_sha256.lower()):
        raise HTTPException(422, "X-Content-SHA256 (64 hex digits) is required")
    declared = declared_sha256.lower().removeprefix("sha256:")
    actual = hashlib.sha256(data).hexdigest()
    if actual != declared:
        raise HTTPException(422, {"code": "hash_mismatch", "detail": "the body's SHA-256 isn't the declared one", "sha256": actual})
    mt = (media_type or "application/octet-stream").split(";")[0].strip() or "application/octet-stream"
    out = {"key": k, "sha256": f"sha256:{actual}", "size": len(data), "media_type": mt}
    prior = ref(k)
    store = blobstore.data()
    if prior is None and store.stat(k) is not None:
        prior = {"sha256": "sha256:" + hashlib.sha256(store.read(k)).hexdigest()}  # a ref lost after its blob was written
    if prior is not None:
        if prior.get("sha256") != out["sha256"]:
            raise HTTPException(409, {"code": "immutable", "detail": "this staging key already holds different bytes"})
        if "key" not in prior:
            store.put(_ref_key(k), json.dumps(out).encode(), "application/json")
        return {**out, **{f: prior[f] for f in ("media_type",) if f in prior}}, False
    store.put(k, data, mt)
    store.put(_ref_key(k), json.dumps(out).encode(), "application/json")
    return out, True


def lookup(key: str) -> dict:
    k = _key(key)
    r = ref(k)
    if r is None or blobstore.data().stat(k) is None:
        raise HTTPException(404, "no such blob")
    return r
