"""Sample projects (todo14 D2): templates in the Samples org, and the private copies people take.

The seed manifest's projects become **templates** in the Samples org (`ensure_seeds`, on every
start). "Try a sample" makes a **copy** in the caller's organization (`copy_sample`): new
`projects`, `workspaces`, `sources`, `source_nodes` (+ drive), `datasets`, `tasks` and `assets`
rows, in one transaction. The copy's assets point at the template's blob keys (`assets.path` is
the key; seeds live in `blobstore.assets()`): bytes are never copied, and Trash never deletes a
seed key (`fs.purge_plan` deletes upload keys only, and none another asset row still uses).

Both are built by `_build`, so a copy has exactly the shape of its template: one project,
source, dataset and task sharing one id, the sample folder locked, items read from the
manifest entry (`projects.task_document`), the environment from the manifest
(`projects.base_environment`). Annotations are keyed by (workspace, task), so a copy's labels
are its own.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext, ensure_workspace
from ..dbutil import insert_ignore
from ..models import Asset, DatasetRow, Organization, ProjectMember, ProjectRow, Source, SourceNode, TaskRow, now
from . import assets, audit, fs, tree
from .kinds import kind_from_extension
from .projects import ID_RE, SAMPLES_ORG, SEED_PRINCIPAL, _seed_files, ensure_principal, new_id, person, resolve_files, role_in, seed_entry

SEED_FACT_KEYS = ("label", "subject", "sequence", "record", "fps", "frames", "duration", "width", "height", "mpp", "magnification", "role")
ORG_WRITER_ROLES = ("admin", "owner", "member", "editor")  # dev: who may add projects to an org


def _available(raw: dict) -> bool:
    pid = raw.get("id")
    return isinstance(pid, str) and bool(ID_RE.fullmatch(pid)) and raw.get("status", "available") == "available"


def dev_mode() -> bool:
    """Restricted templates (licenses for local development only) are offered only here."""
    s = settings()
    return not s.production and not s.workos


def _build(db: Session, raw: dict, *, pid: str, org_id: str, title: str, created_by: str, sample_of: str | None, visibility: str) -> ProjectRow:
    """The rows of one sample project, idempotent: a template (`sample_of` None, id = the
    manifest id) or a copy of one (a fresh id; its assets reuse the template's keys)."""
    ensure_workspace(db, pid, title)
    root_name, files = _seed_files(raw)
    root = tree.node_id(pid, "")
    insert_ignore(db, ProjectRow, [{"id": pid, "org_id": org_id, "title": title, "description": "", "visibility": visibility, "seed": sample_of is None, "sample_of": sample_of, "archived": False, "created_by": created_by, "created_at": now(), "updated_at": now()}])
    insert_ignore(db, Source, [{"id": pid, "project_id": pid, "title": root_name, "kind": "seed", "root_node_id": root, "created_by": created_by, "status": "ready", "created_at": now()}])
    project = db.get(ProjectRow, pid)
    assert project is not None
    drive = fs.ensure_drive(db, project)
    changed = False
    if db.get(SourceNode, root) is None:
        # The sample's folder sits under the project's drive, locked (todo7 D1, D2).
        name = tree.free_name(root_name, fs.taken_names(db, drive.id), is_dir=True)
        insert_ignore(db, SourceNode, [tree._row(id=root, source_id=pid, project_id=pid, project_root=drive.id, parent_id=drive.id, name=name, original_path="", is_dir=True, locked=True, created_at=now())])
        changed = True
    if not db.scalar(select(SourceNode.id).where(SourceNode.source_id == pid, SourceNode.is_dir.is_(False)).limit(1)):
        if sample_of is None:
            assets.ensure_seed_assets(db, RequestContext(pid, SEED_PRINCIPAL, ""))
        else:
            _share_assets(db, sample_of, pid)
        by_path = {a.path: a for a in db.scalars(select(Asset).where(Asset.workspace_id == pid))}
        specs = []
        for rel, a in files:
            asset = by_path.get(a["path"])
            facts = {k: a[k] for k in SEED_FACT_KEYS if a.get(k) is not None}
            specs.append(tree.FileSpec(rel, asset.id if asset else None, a.get("sha256"), a.get("bytes") if isinstance(a.get("bytes"), int) else (asset.size if asset else None), kind_from_extension(rel), {"source": "manifest", **facts}))
        tree.add_files(db, pid, pid, root, specs, stable=True, locked=True, created_by=created_by)
        changed = True
    if changed:
        tree.recount_under(db, drive.id)
    task_kind = str(raw.get("task") or (raw.get("environment") or {}).get("task") or "annotate")
    if db.get(DatasetRow, pid) is None:
        refs, followed = resolve_files(db, [root])
        definition: dict[str, Any] = {"nodeIds": [root], "seed": True, "files": refs, "followedFolders": followed}
        if sample_of is not None:
            definition["sampleOf"] = sample_of
        insert_ignore(db, DatasetRow, [{"id": pid, "project_id": pid, "title": title, "description": "", "definition": definition, "created_by": created_by, "created_at": now()}])
    insert_ignore(db, TaskRow, [{"id": pid, "dataset_id": pid, "project_id": pid, "title": title, "kind": task_kind, "revision": 0, "created_by": created_by, "created_at": now()}])
    return project


def _share_assets(db: Session, template_id: str, pid: str) -> None:
    """The template's asset rows, again under the copy's workspace: same paths (blob keys)."""
    assets.ensure_seed_assets(db, RequestContext(template_id, SEED_PRINCIPAL, ""))
    rows = [
        {"id": new_id("ast"), "workspace_id": pid, "path": a.path, "media_type": a.media_type, "role": a.role, "size": a.size, "created_at": now()}
        for a in db.scalars(select(Asset).where(Asset.workspace_id == template_id))
    ]
    insert_ignore(db, Asset, rows)
    db.flush()


def ensure_seeds(db: Session) -> int:
    """Upsert one template project, source (with its tree), dataset and task per available seed.
    Idempotent and safe to run on every start and from several replicas at once."""
    manifest = assets.seed_manifest() or {}
    insert_ignore(db, Organization, [{"id": SAMPLES_ORG, "name": "Samples", "kind": "team", "created_at": now()}])
    n = 0
    for raw in manifest.get("projects", []):
        if not _available(raw):
            continue
        _build(db, raw, pid=raw["id"], org_id=SAMPLES_ORG, title=str(raw.get("title") or raw["id"]), created_by=SEED_PRINCIPAL, sample_of=None, visibility="shared")
        n += 1
    db.flush()
    return n


# ---- Taking a sample ---------------------------------------------------------------------------


def modality(raw: dict) -> str | None:
    """The manifest's `modality`, else the preset the template boots (`image-2d`, `ecg`…):
    a key the web turns into words, so no domain vocabulary lives here."""
    if isinstance(raw.get("modality"), str):
        return raw["modality"]
    extends = (raw.get("environment") or {}).get("extends")
    if isinstance(extends, str) and extends.startswith("preset:"):
        return extends.split(":", 1)[1]
    return raw.get("viewer") if isinstance(raw.get("viewer"), str) else None


def offered(raw: dict) -> bool:
    return _available(raw) and (dev_mode() or not raw.get("restricted"))


def list_samples(db: Session) -> dict:
    """`GET /api/v1/samples`: the templates a person may copy here."""
    if not settings().samples_enabled:
        return {"enabled": False, "samples": []}
    from .projects import ensure_seeds_once

    ensure_seeds_once(db)
    out = []
    for raw in (assets.seed_manifest() or {}).get("projects", []):
        if offered(raw) and db.get(ProjectRow, raw["id"]) is not None:
            out.append({"id": raw["id"], "title": str(raw.get("title") or raw["id"]), "modality": modality(raw), "license": raw.get("license"), "restricted": bool(raw.get("restricted"))})
    return {"enabled": True, "samples": out}


def _target_org(db: Session, ctx: RequestContext, who: str, org_id: str | None) -> str:
    """Where the copy goes: the caller's current org (workos), else their personal org, or an
    org named in the body where they may add projects. Never the Samples org."""
    if org_id == SAMPLES_ORG:
        raise HTTPException(403, "samples can't be copied into the Samples organization")
    if settings().workos or ctx.org_id is not None:
        org = ctx.org_id
        if org is None or (org_id is not None and org_id != org) or not ctx.can("project:create"):
            raise HTTPException(403, "you can't create projects in this organization")
        return org
    personal = ensure_principal(db, who)
    if org_id is None or org_id == personal:
        if personal is None:
            raise HTTPException(403, "only people take samples")
        return personal
    if role_in(db, org_id, who) not in ORG_WRITER_ROLES:
        raise HTTPException(403, "you can't create projects in this organization")
    return org_id


def _free_title(db: Session, org_id: str, title: str) -> str:
    taken = {t.lower() for t in db.scalars(select(ProjectRow.title).where(ProjectRow.org_id == org_id))}
    if title.lower() not in taken:
        return title
    n = 2
    while f"{title} ({n})".lower() in taken:
        n += 1
    return f"{title} ({n})"[:256]


def copy_sample(db: Session, ctx: RequestContext, sample_id: str, org_id: str | None = None) -> ProjectRow:
    """A private copy of a Samples template in the caller's organization (todo14 D2), one
    transaction; audited `project.created` with `sampleOf`."""
    who = person(ctx)
    if ctx.scopes or not who.startswith("user:"):
        raise HTTPException(403, "only people take samples")
    if not settings().samples_enabled:
        raise HTTPException(404, "samples are turned off")
    raw = seed_entry(sample_id) if isinstance(sample_id, str) and ID_RE.fullmatch(sample_id) else None
    template = db.get(ProjectRow, sample_id) if raw is not None else None
    if raw is None or not offered(raw) or template is None or not template.seed:
        raise HTTPException(404, "no such sample")
    org = _target_org(db, ctx, who, org_id)
    pid = new_id("prj")
    title = _free_title(db, org, template.title)
    p = _build(db, raw, pid=pid, org_id=org, title=title, created_by=who, sample_of=sample_id, visibility="private")
    db.add(ProjectMember(project_id=pid, principal=who, role="owner", added_by=who, added_at=now()))
    db.flush()
    audit.record(db, ctx.for_scope(pid, None), "project.created", target=pid, after={"title": title, "sampleOf": sample_id})
    return p
