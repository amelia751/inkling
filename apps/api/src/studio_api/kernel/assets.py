"""Asset API (docs/plugins.md §6): metadata, short-lived signed URLs, derived artifacts.

In dev the assets of a workspace are the files of the seed project with the same id
(seed-data/manifest.json), served from seed-data/. Signed URLs are HMAC'd with the kernel
key; a URL works for one workspace until it expires, whoever holds it, and nothing else.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import Artifact, Asset

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
    """Same table as packages/plugin-contracts/src/media-types.ts."""
    p = path.lower()
    for ext, t in MEDIA_TYPES:
        if p.endswith(ext):
            return t
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def asset_dict(a: Asset) -> dict:
    return {"id": a.id, "path": a.path, "mediaType": a.media_type, "role": a.role, "size": a.size}


def _seed_project(workspace_id: str) -> dict | None:
    manifest = settings().seed_root / "manifest.json"
    if not manifest.is_file():
        return None
    for p in json.loads(manifest.read_text()).get("projects", []):
        if p.get("id") == workspace_id:
            return p
    return None


def ensure_seed_assets(db: Session, ctx: RequestContext) -> None:
    """Register the workspace's seed files as assets the first time they're asked for."""
    if db.scalar(select(Asset.id).where(Asset.workspace_id == ctx.workspace_id).limit(1)):
        return
    project = _seed_project(ctx.workspace_id)
    for a in (project or {}).get("assets", []):
        path = a.get("path")
        if not path:
            continue
        f = settings().seed_root / path
        db.add(Asset(workspace_id=ctx.workspace_id, path=path, media_type=media_type_of(path), role=a.get("role"), size=f.stat().st_size if f.is_file() else None))
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


def asset_file(a: Asset) -> Path:
    root = settings().seed_root.resolve()
    f = (root / a.path).resolve()
    if not str(f).startswith(str(root)) or not f.is_file():
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
    d = settings().data_dir / "artifacts" / ctx.workspace_id
    d.mkdir(parents=True, exist_ok=True)
    ext = mimetypes.guess_extension(media_type) or ".bin"
    f = d / f"{art.id}{ext}"
    f.write_bytes(data)
    art.path = str(f)
    return art


def read_artifact(db: Session, ctx: RequestContext, artifact_id: str) -> tuple[Artifact, bytes]:
    art = db.get(Artifact, artifact_id)
    if art is None or art.workspace_id != ctx.workspace_id:
        raise HTTPException(404, "no such artifact in this workspace")
    return art, Path(art.path).read_bytes()
