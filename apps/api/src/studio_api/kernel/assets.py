"""Asset API (docs/plugins.md §6): metadata, short-lived signed URLs, derived artifacts.

In dev the assets of a workspace are the files of the seed project with the same id
(seed-data/manifest.json). Bytes live in the BlobStore (`blobstore.assets()`: seed-data/ in
dev, the `assets` bucket in a cluster); derived artifacts in `blobstore.data()`. Signed URLs are HMAC'd with the kernel
key; a URL works for one workspace until it expires, whoever holds it, and nothing else.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import blobstore
from ..config import settings
from ..context import RequestContext
from ..dbutil import insert_ignore
from ..models import Artifact, Asset, new_id, now

MEDIA_TYPES = [
    (".nii.gz", "application/x-nifti"),
    (".nii", "application/x-nifti"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".webp", "image/webp"),
    (".tif", "image/tiff"),
    (".tiff", "image/tiff"),
    (".svs", "image/tiff"),
    (".dzi", "application/x-dzi"),
    (".dcm", "application/dicom"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".hea", "application/x-wfdb"),
    (".dat", "application/x-wfdb"),
    (".csv", "text/csv"),
    (".json", "application/json"),
    (".txt", "text/plain"),
    (".md", "text/markdown"),
]


def media_type_of(path: str) -> str:
    """Same table as packages/contracts/src/media-types.ts."""
    p = path.lower()
    for ext, t in MEDIA_TYPES:
        if p.endswith(ext):
            return t
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def asset_dict(a: Asset) -> dict:
    return {"id": a.id, "path": a.path, "mediaType": a.media_type, "role": a.role, "size": a.size}


def seed_manifest() -> dict | None:
    """seed-data/manifest.json, read through the BlobStore (None when there is none)."""
    try:
        return json.loads(blobstore.assets().read("manifest.json"))
    except blobstore.BlobNotFound:
        return None


def _seed_project(workspace_id: str) -> dict | None:
    for p in (seed_manifest() or {}).get("projects", []):
        if p.get("id") == workspace_id:
            return p
    return None


def ensure_seed_assets(db: Session, ctx: RequestContext) -> None:
    """Register the workspace's seed files as assets the first time they're asked for."""
    if db.scalar(select(Asset.id).where(Asset.workspace_id == ctx.workspace_id).limit(1)):
        return
    project = _seed_project(ctx.workspace_id)
    rows = []
    for a in (project or {}).get("assets", []):
        path = a.get("path")
        if not path:
            continue
        size = a.get("bytes")
        if not isinstance(size, int):
            info = blobstore.assets().stat(path) if ".." not in Path(path).parts else None
            size = info.size if info else None
        rows.append({"id": new_id(), "workspace_id": ctx.workspace_id, "path": path, "media_type": media_type_of(path), "role": a.get("role"), "size": size, "created_at": now()})
    # Concurrent first requests race to register the same rows: insert … on conflict do nothing.
    insert_ignore(db, Asset, rows)
    db.flush()


def list_assets(db: Session, ctx: RequestContext, limit: int = 1000) -> list[dict]:
    ensure_seed_assets(db, ctx)
    rows = db.scalars(select(Asset).where(Asset.workspace_id == ctx.workspace_id).order_by(Asset.path).limit(limit)).all()
    return [asset_dict(a) for a in rows]


def get_asset(db: Session, ctx: RequestContext, asset_id: str) -> Asset:
    """By id or (dev) by seed path, always inside the caller's workspace."""
    ensure_seed_assets(db, ctx)
    a = db.scalar(select(Asset).where(Asset.workspace_id == ctx.workspace_id, (Asset.id == asset_id) | (Asset.path == asset_id)))
    if a is None:
        raise HTTPException(404, f"no asset {asset_id!r} in this workspace")
    return a


def companion_key(db: Session, ctx: RequestContext, path: str) -> str | None:
    """A file that belongs to a registered asset without being one: the tiles of a Deep Zoom
    image (`<name>_files/<level>/<x>_<y>.jpeg` next to the asset `<name>.dzi`). Its key, or None."""
    head, sep, _ = path.partition("_files/")
    if not sep or ".." in Path(path).parts:
        return None
    ensure_seed_assets(db, ctx)
    if db.scalar(select(Asset.id).where(Asset.workspace_id == ctx.workspace_id, Asset.path == f"{head}.dzi")) is None:
        return None
    try:
        key = blobstore.safe_key(path)
    except blobstore.BlobNotFound:
        return None
    return key if blobstore.assets().stat(key) is not None else None


# Uploaded files (todo6 Phase 4) are content-addressed in the data store under this prefix:
# `sources/<project>/<sha256><ext>`. Seed paths start with a seed folder name instead.
UPLOAD_PREFIX = "sources/"


def store_of(path: str) -> blobstore.BlobStore:
    """Which BlobStore holds an asset's bytes: uploads in `data()`, seeds in `assets()`."""
    return blobstore.data() if path.startswith(UPLOAD_PREFIX) else blobstore.assets()


def asset_key(a: Asset) -> str:
    """The asset's BlobStore key (its seed or upload path), checked: no traversal, and the object exists."""
    try:
        key = blobstore.safe_key(a.path)
    except blobstore.BlobNotFound:
        raise HTTPException(404, "asset file missing") from None
    if store_of(key).stat(key) is None:
        raise HTTPException(404, "asset file missing")
    return key


def asset_file(a: Asset) -> Path:
    """Local-store only (dev tools); services stream through `asset_key` + the BlobStore."""
    # Lexical containment (seed folders may be symlinks into a shared data checkout).
    root = Path(os.path.normpath(settings().seed_root))
    f = Path(os.path.normpath(root / a.path))
    if ".." in Path(a.path).parts or root not in f.parents or not f.is_file():
        raise HTTPException(404, "asset file missing")
    return f


# ---- Signed URLs ---------------------------------------------------------------------------


def _sig(*parts: str) -> str:
    return hmac.new(settings().secret_key.encode(), "\x1f".join(parts).encode(), hashlib.sha256).hexdigest()[:40]


def sign_path(workspace_id: str, path: str, ttl_s: int | None = None) -> str:
    exp = str(int(time.time()) + (ttl_s or settings().signed_url_ttl_s))
    return f"/api/v1/assets/{quote(workspace_id)}/files/{quote(path)}?exp={exp}&sig={_sig('path', workspace_id, path, exp)}"


def workspace_url_token(workspace_id: str, ttl_s: int | None = None) -> dict:
    """A token valid for every asset of one workspace (the web's assetUrl builds URLs with it)."""
    exp = int(time.time()) + (ttl_s or settings().signed_url_ttl_s)
    return {"workspaceId": workspace_id, "exp": exp, "sig": _sig("workspace", workspace_id, str(exp)), "base": f"/api/v1/assets/{quote(workspace_id)}/files/"}


def verify(workspace_id: str, path: str, exp: str, sig: str) -> None:
    if not exp.isdigit() or int(exp) < time.time():
        raise HTTPException(403, "signed URL expired")
    ok = hmac.compare_digest(sig, _sig("path", workspace_id, path, exp)) or hmac.compare_digest(sig, _sig("workspace", workspace_id, exp))
    if not ok:
        raise HTTPException(403, "bad signature")


# ---- Derived artifacts ---------------------------------------------------------------------


def create_artifact(db: Session, ctx: RequestContext, data: bytes, media_type: str, source_asset_id: str | None = None) -> Artifact:
    art = Artifact(workspace_id=ctx.workspace_id, media_type=media_type, path="", source_asset_id=source_asset_id, created_by=ctx.principal)
    db.add(art)
    db.flush()
    ext = mimetypes.guess_extension(media_type) or ".bin"
    # `path` is the key in the data BlobStore (shared by every replica), not a local file.
    art.path = f"artifacts/{ctx.workspace_id}/{art.id}{ext}"
    blobstore.data().put(art.path, data, media_type)
    return art


def read_artifact(db: Session, ctx: RequestContext, artifact_id: str) -> tuple[Artifact, bytes]:
    art = db.get(Artifact, artifact_id)
    if art is None or art.workspace_id != ctx.workspace_id:
        raise HTTPException(404, "no such artifact in this workspace")
    return art, artifact_bytes(art)


def artifact_bytes(art: Artifact) -> bytes:
    if Path(art.path).is_absolute():  # written by an older kernel straight to its data dir
        return Path(art.path).read_bytes()
    try:
        return blobstore.data().read(art.path)
    except blobstore.BlobNotFound:
        raise HTTPException(404, "artifact content missing") from None


def asset_head(a: Asset, n: int = 65536) -> bytes:
    """The first `n` bytes of an asset (enough for image headers)."""
    key = asset_key(a)
    size = store_of(key).stat(key)
    end = min(n, size.size if size else n) - 1
    return b"".join(store_of(key).iter_range(key, 0, end)) if end >= 0 else b""
