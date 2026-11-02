"""Files: the project's drive (todo7, docs/files-api.md).

    GET    /api/v1/projects/{id}/fs                         DriveInfo (creates the root lazily)
    GET    /api/v1/projects/{id}/fs/children?node=&cursor=&limit=&sort=&dir=
    POST   /api/v1/projects/{id}/fs/ops                     FsOpsRequest → FsOpsResult (all or nothing)
    POST   /api/v1/projects/{id}/fs/undo | fs/redo          { batchId? } → FsUndoResult
    GET    /api/v1/projects/{id}/fs/history                 { undo, redo } hints
    POST   /api/v1/projects/{id}/fs/zip                     { nodeIds } → streamed application/zip
    (Trash: routes/trash.py)
    GET    /api/v1/projects/{id}/starred | recent           { items: FsShortcut[] }
    POST   /api/v1/source-nodes/{id}/star   DELETE …/star   { starred }
    GET    /api/v1/source-nodes/{id}/versions               { versions }
    POST   /api/v1/source-nodes/{id}/versions               a replace-mode upload session (D6)
    POST   /api/v1/source-nodes/{id}/versions/{v}/restore   FsOpsResult
    GET    /api/v1/source-nodes/{id}/download               the bytes (attachment), audited
    GET    /api/v1/source-nodes/{id}/versions/{v}/download  an older version's bytes, audited
    GET    /api/v1/source-nodes/{id}/activity               { items: FsActivityEntry[] }
    POST   /api/v1/projects/{id}/datasets/{ds}/update-versions      (GET …/preview)
    POST   /api/v1/projects/{id}/datasets/{ds}/add-followed

Writes are people only: an agent token (`ctx.scopes` set) gets 403 (Phase 8 goes through a
proposal the person applies).
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import assets, audit, fs, imports, name_screen, projects, tree, write_doors, zipstream
from ..kernel.admission.http import WriteParams, declares, write_params
from ..models import Asset, DatasetRow, NodeVersion, ProjectRow, SourceNode
from ..streaming import blob_response

router = APIRouter(prefix="/api/v1")


def _project(db: Session, ctx: RequestContext, project_id: str, *, write: bool = False) -> ProjectRow:
    projects.ensure_seeds_once(db)
    if write:
        fs.only_people(ctx)
    return projects.require_project(db, ctx, project_id, write=write)


def _node(db: Session, ctx: RequestContext, node_id: str, *, write: bool = False) -> tuple[SourceNode, ProjectRow]:
    n, p = projects.require_node(db, ctx, node_id)
    if write:
        fs.only_people(ctx)
        projects.require_project(db, ctx, p.id, write=True)
    return n, p


@router.get("/projects/{project_id}/fs")
def drive(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return fs.drive_info(db, _project(db, ctx, project_id))


@router.get("/projects/{project_id}/fs/children")
def children(project_id: str, node: str | None = None, cursor: str | None = None, limit: int = tree.PAGE, sort: str = "name", dir: str = "asc", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = _project(db, ctx, project_id)
    root = fs.ensure_drive(db, p)
    parent = node or root.id
    if sort not in tree.SORTS:
        raise HTTPException(422, f"sort is one of {', '.join(tree.SORTS)}")
    if dir not in ("asc", "desc"):
        raise HTTPException(422, "dir is asc or desc")
    if not parent.startswith("seq:"):
        n = db.get(SourceNode, parent)
        if n is None or n.project_id != p.id or not n.is_dir:
            raise HTTPException(404, "no such folder in this project")
    try:
        start = int(cursor or 0)
    except ValueError:
        raise HTTPException(422, "bad cursor") from None
    stars = fs.starred_ids(db, p.id, fs.person(ctx))
    return tree.children(db, p.id, parent, max(0, start), max(1, min(limit, tree.PAGE)), sort=sort, direction=dir, starred=stars)


def _raced(fn, *args):
    """Two people naming things in one folder at once: the unique (parent, lower(name)) index
    stops the second; it gets a 409 to retry, and the transaction rolls back whole."""
    try:
        out = fn(*args)
    except IntegrityError:
        raise HTTPException(409, "Someone else just changed this folder. Reload and try again") from None
    # todo13 D13: new and renamed names are screened before an agent can read them.
    name_screen.screen_pending(args[0], args[2].id)
    return out


@router.post("/projects/{project_id}/fs/ops", openapi_extra=declares(write_doors.FILES_OPS.id))
def ops(project_id: str, body: dict = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """todo17: every path the batch leaves behind runs the layout rules (layout.*, name.*):
    an enforced error rejects the whole batch with every violation (422 problem JSON); warnings
    come back as `findings`. `?dryRun=true` applies it, reports, and saves nothing."""
    p = _project(db, ctx, project_id, write=True)

    def check(b: fs.Batch):
        paths, folders = write_doors.batch_paths(db, set(b.touched) | b.moved | b.renamed)
        return write_doors.check_paths(db, ctx, p, write_doors.FILES_OPS, paths, folders, dry_run=w.dry_run)

    if w.dry_run:
        try:
            out = fs.apply(db, ctx, p, body, check=check, dry_run=True)
        except IntegrityError:
            raise HTTPException(409, "Someone else just changed this folder. Reload and try again") from None
        return write_doors.dry_run_reply(db, out)
    return write_doors.idempotent(db, ctx, w, write_doors.FILES_OPS, {"project": p.id, **body}, lambda: _raced(lambda *a: fs.apply(*a, check=check), db, ctx, p, body))


@router.post("/projects/{project_id}/fs/undo", openapi_extra=declares(write_doors.FILES_UNDO.id))
def undo(project_id: str, body: dict = Body(default={}), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Undo restores names that were already admitted, so no layout check; retries are safe
    with an Idempotency-Key."""
    p = _project(db, ctx, project_id, write=True)
    write_doors.admit_plain(db, ctx, p, write_doors.FILES_UNDO, dry_run=w.dry_run)
    if w.dry_run:
        return write_doors.dry_run_reply(db, fs.undo(db, ctx, p, body.get("batchId") or None))
    return write_doors.idempotent(db, ctx, w, write_doors.FILES_UNDO, {"project": p.id, **body}, lambda: _raced(fs.undo, db, ctx, p, body.get("batchId") or None))


@router.post("/projects/{project_id}/fs/redo", openapi_extra=declares(write_doors.FILES_REDO.id))
def redo(project_id: str, body: dict = Body(default={}), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = _project(db, ctx, project_id, write=True)
    write_doors.admit_plain(db, ctx, p, write_doors.FILES_REDO, dry_run=w.dry_run)
    if w.dry_run:
        return write_doors.dry_run_reply(db, fs.redo(db, ctx, p, body.get("batchId") or None))
    return write_doors.idempotent(db, ctx, w, write_doors.FILES_REDO, {"project": p.id, **body}, lambda: _raced(fs.redo, db, ctx, p, body.get("batchId") or None))


@router.get("/projects/{project_id}/fs/history")
def history(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return fs.history(db, ctx, _project(db, ctx, project_id))


# ---- Trash -------------------------------------------------------------------------------------


# Trash listing and emptying moved to routes/trash.py (todo16: every kind, not only files).


@router.get("/projects/{project_id}/starred")
def starred(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return fs.shortcuts(db, ctx, _project(db, ctx, project_id), "starred")


@router.get("/projects/{project_id}/recent")
def recent(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return fs.shortcuts(db, ctx, _project(db, ctx, project_id), "recent")


@router.post("/source-nodes/{node_id}/star")
def star(node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, _ = _node(db, ctx, node_id)
    return fs.star(db, ctx, n, True)


@router.delete("/source-nodes/{node_id}/star")
def unstar(node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, _ = _node(db, ctx, node_id)
    return fs.star(db, ctx, n, False)


# ---- Versions ----------------------------------------------------------------------------------


@router.get("/source-nodes/{node_id}/versions")
def versions(node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, _ = _node(db, ctx, node_id)
    return {"versions": fs.versions(db, n)}


@router.post("/source-nodes/{node_id}/versions", status_code=201)
def new_version(node_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, p = _node(db, ctx, node_id, write=True)
    return imports.create_replace_session(db, ctx, p, n, body)


@router.post("/source-nodes/{node_id}/versions/{version}/restore")
def restore_version(node_id: str, version: int, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, p = _node(db, ctx, node_id, write=True)
    return fs.restore_version(db, ctx, p, n, version)


# ---- Download ----------------------------------------------------------------------------------


def _held(n: SourceNode | dict | None) -> str | None:
    """The privacy hold's reason, if `n` (a node, or a version's flags) is held."""
    flags = n if isinstance(n, dict) or n is None else n.flags
    priv = (flags or {}).get("privacy")
    if priv and not priv.get("clearedBy"):
        return str(priv.get("reason") or "Held for privacy review")
    return None


def _disposition(name: str) -> str:
    ascii_name = "".join(ch if 32 <= ord(ch) < 127 and ch not in '"\\' else "_" for ch in name) or "download"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


@router.get("/source-nodes/{node_id}/download")
def download(node_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, p = _node(db, ctx, node_id)
    if n.is_dir:
        raise HTTPException(422, "Download a folder as a ZIP: POST /v1/projects/:id/fs/zip")
    if _held(n):
        raise HTTPException(423, "This file is held for privacy review: clear the hold before downloading it")
    a = db.get(Asset, n.asset_id) if n.asset_id else None
    if a is None:
        raise HTTPException(404, "the file's bytes are missing")
    key = assets.asset_key(a)
    audit.record(db, ctx.for_scope(p.id, None), "files.downloaded", target=n.id, after={"files": 1, "nodeIds": [n.id]})
    db.commit()
    resp = blob_response(assets.store_of(key), key, a.media_type or "application/octet-stream", request)
    resp.headers["Content-Disposition"] = _disposition(n.name)
    return resp


@router.get("/source-nodes/{node_id}/versions/{version}/download")
def download_version(node_id: str, version: int, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """One version's bytes (D6), named `name (v1).ext` unless it's the current one. Audited like
    a download; refused while the file, or that version, is held for privacy review."""
    n, p = _node(db, ctx, node_id)
    if n.is_dir:
        raise HTTPException(422, "Folders have no versions")
    v = db.get(NodeVersion, (n.id, version))
    if v is None and version == (n.version or 1):
        asset_id, flags = n.asset_id, n.flags
    elif v is None:
        raise HTTPException(404, f"{n.name} has no version {version}")
    else:
        asset_id, flags = v.asset_id, v.flags
    if _held(n) or _held(flags):
        raise HTTPException(423, "This file is held for privacy review: clear the hold before downloading it")
    a = db.get(Asset, asset_id) if asset_id else None
    if a is None:
        raise HTTPException(404, "the version's bytes are missing")
    key = assets.asset_key(a)
    audit.record(db, ctx.for_scope(p.id, None), "files.downloaded", target=n.id, after={"files": 1, "nodeIds": [n.id], "version": version})
    db.commit()
    stem, ext = tree.split_ext(n.name)
    name = n.name if version == (n.version or 1) else f"{stem} (v{version}){ext}"
    resp = blob_response(assets.store_of(key), key, a.media_type or "application/octet-stream", request)
    resp.headers["Content-Disposition"] = _disposition(name)
    return resp


@router.post("/projects/{project_id}/fs/zip")
def zip_download(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """A folder or a selection as one ZIP, streamed (stored entries, constant memory). Entry
    names are current paths, never the names files arrived with. Files held for privacy
    review are left out and listed in `_held_files.txt`. Imaging checks (todo17 D11) are queued
    for what is exported; open error-severity imaging findings answer 422 problem JSON with
    `findings` unless a person sends `force: true`; others are counted in `X-Imaging-Findings`."""
    p = _project(db, ctx, project_id)
    ids = body.get("nodeIds")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(422, "nodeIds must list at least one file or folder")
    entries: list[tuple[str, str, int | None]] = []
    held: list[tuple[str, str]] = []
    used: set[str] = set()
    selected: list[SourceNode] = []
    for nid in dict.fromkeys(str(x) for x in ids):
        n = db.get(SourceNode, nid)
        if n is None or n.project_id != p.id:
            raise HTTPException(404, "No such file or folder in this project")
        if tree.is_hidden(db, n):
            raise HTTPException(422, f"{n.name} is in the Trash")
        selected.append(n)

    def unique(path: str) -> str:
        cand, i = path, 2
        while cand.lower() in used:
            stem, ext = tree.split_ext(path)
            cand = f"{stem} ({i}){ext}"
            i += 1
        used.add(cand.lower())
        return cand

    asset_ids: dict[str, str] = {}
    files: list[tuple[str, SourceNode]] = []
    for n in selected:
        if not n.is_dir:
            files.append((n.name, n))
            continue
        base = n.name if n.parent_id is not None else ""
        rows = tree.subtree(db, n.id)
        by_id = {r.id: r for r in rows}
        file_ids = [r.id for r in rows if not r.is_dir]
        nodes: dict[str, SourceNode] = {}
        for i in range(0, len(file_ids), 500):
            for x in db.scalars(select(SourceNode).where(SourceNode.id.in_(file_ids[i : i + 500]))):
                nodes[x.id] = x
        for fid in file_ids:
            names = []
            cur = by_id.get(fid)
            while cur is not None and cur.id != n.id:
                names.append(cur.name)
                cur = by_id.get(cur.parent_id)
            rel = "/".join(reversed(names))
            files.append((f"{base}/{rel}" if base else rel, nodes[fid]))
    files.sort(key=lambda pf: tree.natural_key(pf[0]))
    for path, f in files:
        reason = _held(f)
        if reason:
            held.append((path, reason))
            continue
        if not f.asset_id:
            continue
        asset_ids[path] = f.asset_id
    # todo17 D11: a fresh imaging check of what leaves, and a gate on what is already known.
    from ..kernel import imaging_findings

    exported = {f.id: f for path, f in files if path in asset_ids}
    try:
        imaging = imaging_findings.export_gate(db, ctx, p, list(exported.values()), force=body.get("force") is True)
    except imaging_findings.ExportBlocked as e:
        db.commit()  # keep the queued check
        return e.response()
    by_asset = {a.id: a for a in db.scalars(select(Asset).where(Asset.id.in_(list(set(asset_ids.values())))))} if asset_ids else {}
    for path, aid in asset_ids.items():
        a = by_asset.get(aid)
        if a is None:
            continue
        entries.append((unique(path), a.path, a.size))
    audit.record(db, ctx.for_scope(p.id, None), "files.downloaded", target=p.id, after={"files": len(entries), "held": len(held), "nodeIds": [n.id for n in selected][:50], "zip": True})
    db.commit()
    note = None
    if held:
        lines = ["These files were left out because they are held for privacy review.", "Clear the hold in Sources (or rename the file) to include them.", ""]
        lines += [f"{path}\t{reason}" for path, reason in held]
        note = ("\n".join(lines) + "\n").encode()
    name = selected[0].name if len(selected) == 1 and selected[0].is_dir and selected[0].parent_id is not None else "Sources"
    stamp = datetime.fromtimestamp(time.time(), UTC)
    return StreamingResponse(zipstream.stream(entries, note, stamp), media_type="application/zip", headers={"Content-Disposition": _disposition(f"{name}.zip"), "Cache-Control": "no-store", "X-Held-Files": str(len(held)), "X-Imaging-Findings": str(len(imaging))})


# ---- Activity ----------------------------------------------------------------------------------


@router.get("/source-nodes/{node_id}/activity")
def activity(node_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    n, _ = _node(db, ctx, node_id)
    return fs.activity(db, ctx, n)


# ---- Datasets: versions and followed folders (D6, D7) ------------------------------------------


def _dataset(db: Session, ctx: RequestContext, project_id: str, dataset_id: str, *, write: bool = False) -> DatasetRow:
    d, p = projects.require_dataset(db, ctx, dataset_id)
    if p.id != project_id:
        raise HTTPException(404, "no such dataset in this project")
    if write:
        fs.only_people(ctx)
        projects.require_project(db, ctx, p.id, write=True)
    return d


@router.get("/projects/{project_id}/datasets/{dataset_id}/update-versions/preview")
def update_versions_preview(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return projects.update_versions_preview(db, _dataset(db, ctx, project_id, dataset_id))


@router.post("/projects/{project_id}/datasets/{dataset_id}/update-versions")
def update_versions(project_id: str, dataset_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d = _dataset(db, ctx, project_id, dataset_id, write=True)
    ids = body.get("nodeIds")
    return projects.dataset_dict(db, projects.update_versions(db, ctx, d, [str(x) for x in ids] if isinstance(ids, list) else None))


@router.post("/projects/{project_id}/datasets/{dataset_id}/add-followed")
def add_followed(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d = _dataset(db, ctx, project_id, dataset_id, write=True)
    return projects.dataset_dict(db, projects.add_followed(db, ctx, d))
