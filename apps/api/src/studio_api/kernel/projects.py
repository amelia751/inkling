"""Projects, datasets, tasks, proposals and resume state (todo6 Phase 1, docs/ux.md §2).

Organization ⊃ Project ⊃ Dataset ⊃ Task, plus Sources. Every function takes the request
context and checks membership through `require_project`; ids in bodies are never trusted.

Seeds: each entry of seed-data/manifest.json becomes one project, source, dataset and task
with the seed's id (todo6 D2), in the shared samples organization every person belongs to.
So everything keyed by the old id (annotations, environments, DatasetRepo) keeps working.
"""

from __future__ import annotations

import hashlib
import logging
from collections import Counter
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..context import RequestContext, ensure_workspace
from ..dbutil import insert_ignore
from ..models import (
    AnnotationDocumentRow,
    Asset,
    DatasetRow,
    ImportSession,
    NodeVersion,
    Organization,
    OrganizationMember,
    ProjectResume,
    ProjectRow,
    Proposal,
    Source,
    SourceNode,
    TaskRow,
    WorkspaceEnvironment,
    now,
)
from . import assets, audit, events, fs, tree
from .kinds import VIEWABLE, kind_from_extension

log = logging.getLogger(__name__)

SAMPLES_ORG = "org-samples"
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
SEED_PRINCIPAL = "system:seed"

# ---- Ids, organizations and membership ---------------------------------------------------------


def new_id(prefix: str) -> str:
    """Opaque ids are slugs (`prj-…`), so every route that takes a project or task id keeps
    its `[a-z0-9-]` check."""
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    d = d if d.tzinfo else d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def person(ctx: RequestContext) -> str:
    """Who membership is checked for: the person an agent session acts for, else the caller."""
    return ctx.on_behalf_of or ctx.principal


def personal_org_id(principal: str) -> str:
    return "org-" + hashlib.sha256(principal.encode()).hexdigest()[:16]


def ensure_principal(db: Session, principal: str) -> str | None:
    """A person's personal organization (dev creates one per `user:` principal), plus
    editor access to the samples. Returns the personal org id."""
    if not principal.startswith("user:"):
        return None
    org = personal_org_id(principal)
    if db.get(OrganizationMember, (org, principal)) is None:
        insert_ignore(db, Organization, [{"id": org, "name": "Personal", "kind": "personal", "created_at": now()}, {"id": SAMPLES_ORG, "name": "Samples", "kind": "team", "created_at": now()}])
        insert_ignore(db, OrganizationMember, [{"org_id": org, "principal": principal, "role": "owner"}, {"org_id": SAMPLES_ORG, "principal": principal, "role": "editor"}])
    return org


def role_in(db: Session, org_id: str, principal: str) -> str | None:
    m = db.get(OrganizationMember, (org_id, principal))
    return m.role if m else None


def require_project(db: Session, ctx: RequestContext, project_id: str, *, write: bool = False) -> ProjectRow:
    """The project, if the caller may see it (404 otherwise, so ids don't leak). Session tokens
    are bound to one workspace, which is one project."""
    p = db.get(ProjectRow, project_id) if ID_RE.fullmatch(project_id or "") else None
    if p is None:
        raise HTTPException(404, "no such project")
    if ctx.scopes and ctx.workspace_id != p.id:
        raise HTTPException(404, "no such project")
    who = person(ctx)
    if who.startswith("user:"):
        ensure_principal(db, who)
        role = role_in(db, p.org_id, who)
        if role is None:
            raise HTTPException(404, "no such project")
        if write and role == "viewer":
            raise HTTPException(403, "you can view this project but not change it")
    elif not ctx.scopes:
        raise HTTPException(404, "no such project")
    return p


def project_of_scope(db: Session, ctx: RequestContext) -> ProjectRow | None:
    """The project behind a legacy workspace/task route, membership-checked when it exists."""
    p = db.get(ProjectRow, ctx.workspace_id)
    return require_project(db, ctx, p.id) if p is not None else None


# ---- Seeds -------------------------------------------------------------------------------------

LEGACY_PRESETS = {
    "image-2d": "preset:image-2d",
    "volume-3d": "preset:volume-3d",
    "signal": "preset:ecg",
    "temporal": "preset:video",
    "cine-4d": "preset:cine-4d",
    "pathology": "preset:pathology",
}


def label_groups(labels: list[str], task: str | None) -> list[dict]:
    """String labels as label groups. A classification task gets only its `Choices` group, no
    region copy of the same classes (todo8 D4; `labelGroupsFrom` in apps/web/src/studio/lib/api.ts
    and `with_environment` in tools/fetch-seeds.py do the same)."""
    classes = [{"id": label} for label in labels]
    if task == "classification":
        return [{"name": "class", "control": "Choices", "classes": classes}]
    return [{"name": "labels", "control": "Labels", "classes": classes}]


def seed_entry(project_id: str) -> dict | None:
    return next((p for p in (assets.seed_manifest() or {}).get("projects", []) if p.get("id") == project_id), None)


def manifest_environment(project_id: str) -> dict | None:
    """The environment a manifest project boots with: `normalizeProject` in
    apps/web/src/studio/lib/api.ts (v1 `viewer` + string labels are migrated)."""
    raw = seed_entry(project_id)
    if raw is None:
        return None
    labels = raw.get("labels")
    string_labels = labels if isinstance(labels, list) and all(isinstance(x, str) for x in labels) else None
    env: dict[str, Any] = dict(raw["environment"]) if raw.get("environment") else {"extends": LEGACY_PRESETS.get(raw.get("viewer") or "", f"preset:{raw.get('viewer')}")}
    if env.get("task") is None and raw.get("task") is not None:
        env["task"] = raw["task"]
    if env.get("labels") is None:
        groups = label_groups(string_labels, raw.get("task")) if string_labels is not None else labels
        if groups is not None:
            env["labels"] = groups
    return env


def _seed_files(raw: dict) -> tuple[str, list[tuple[str, dict]]]:
    """(root folder name, [(path relative to it, manifest asset)])."""
    entries = [a for a in raw.get("assets") or [] if isinstance(a.get("path"), str) and ".." not in a["path"].split("/")]
    tops = {a["path"].split("/", 1)[0] for a in entries if "/" in a["path"]}
    if len(tops) == 1 and all("/" in a["path"] for a in entries):
        top = tops.pop()
        return top, [(a["path"][len(top) + 1 :], a) for a in entries]
    return raw["id"], [(a["path"], a) for a in entries]


SEED_FACT_KEYS = ("label", "subject", "sequence", "record", "fps", "frames", "duration", "width", "height", "mpp", "magnification", "role")


def ensure_seeds(db: Session) -> int:
    """Upsert one project, source (with its tree), dataset and task per available seed.
    Idempotent and safe to run on every start and from several replicas at once."""
    manifest = assets.seed_manifest() or {}
    insert_ignore(db, Organization, [{"id": SAMPLES_ORG, "name": "Samples", "kind": "team", "created_at": now()}])
    n = 0
    for raw in manifest.get("projects", []):
        pid = raw.get("id")
        if not isinstance(pid, str) or not ID_RE.fullmatch(pid) or raw.get("status", "available") != "available":
            continue
        title = str(raw.get("title") or pid)
        ensure_workspace(db, pid, title)
        root_name, files = _seed_files(raw)
        root = tree.node_id(pid, "")
        insert_ignore(db, ProjectRow, [{"id": pid, "org_id": SAMPLES_ORG, "title": title, "description": "", "visibility": "shared", "seed": True, "archived": False, "created_by": SEED_PRINCIPAL, "created_at": now(), "updated_at": now()}])
        insert_ignore(db, Source, [{"id": pid, "project_id": pid, "title": root_name, "kind": "seed", "root_node_id": root, "created_by": SEED_PRINCIPAL, "status": "ready", "created_at": now()}])
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
            assets.ensure_seed_assets(db, RequestContext(pid, SEED_PRINCIPAL, ""))
            by_path = {a.path: a for a in db.scalars(select(Asset).where(Asset.workspace_id == pid))}
            specs = []
            for rel, a in files:
                asset = by_path.get(a["path"])
                facts = {k: a[k] for k in SEED_FACT_KEYS if a.get(k) is not None}
                specs.append(tree.FileSpec(rel, asset.id if asset else None, a.get("sha256"), a.get("bytes") if isinstance(a.get("bytes"), int) else (asset.size if asset else None), kind_from_extension(rel), {"source": "manifest", **facts}))
            tree.add_files(db, pid, pid, root, specs, stable=True, locked=True, created_by=SEED_PRINCIPAL)
            changed = True
        if changed:
            tree.recount_under(db, drive.id)
        task_kind = str(raw.get("task") or (raw.get("environment") or {}).get("task") or "annotate")
        if db.get(DatasetRow, pid) is None:
            refs, followed = resolve_files(db, [root])
            insert_ignore(db, DatasetRow, [{"id": pid, "project_id": pid, "title": title, "description": "", "definition": {"nodeIds": [root], "seed": True, "files": refs, "followedFolders": followed}, "created_by": SEED_PRINCIPAL, "created_at": now()}])
        insert_ignore(db, TaskRow, [{"id": pid, "dataset_id": pid, "project_id": pid, "title": title, "kind": task_kind, "revision": 0, "created_by": SEED_PRINCIPAL, "created_at": now()}])
        n += 1
    db.flush()
    return n


_seeded: set[int] = set()


def ensure_seeds_once(db: Session) -> None:
    """Per process and settings object: a cache of work already done, not request state."""
    from ..config import settings

    key = id(settings())
    if key not in _seeded:
        ensure_seeds(db)
        _seeded.add(key)


# ---- Projects ----------------------------------------------------------------------------------


def _resume_row(db: Session, project_id: str, principal: str) -> ProjectResume | None:
    return db.get(ProjectResume, (project_id, principal))


def resume_dict(db: Session, r: ProjectResume | None) -> dict | None:
    if r is None:
        return None
    t = db.get(TaskRow, r.task_id)
    if t is None:
        return None
    return {"taskId": t.id, "taskTitle": t.title, "taskKind": t.kind, "datasetId": t.dataset_id, "itemId": r.item_id, "placement": r.placement, "tool": r.tool, "at": iso(r.at)}


def last_activity(db: Session, p: ProjectRow) -> datetime:
    times: list[datetime | None] = [
        p.updated_at or p.created_at,
        db.scalar(select(func.max(AnnotationDocumentRow.saved_at)).where(AnnotationDocumentRow.workspace_id == p.id)),
        db.scalar(select(func.max(ImportSession.started_at)).where(ImportSession.project_id == p.id)),
        db.scalar(select(func.max(ProjectResume.at)).where(ProjectResume.project_id == p.id)),
    ]
    vals = [t if t.tzinfo else t.replace(tzinfo=UTC) for t in times if t is not None]
    return max(vals)


def project_dict(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    out = {
        "id": p.id,
        "orgId": p.org_id,
        "title": p.title,
        "description": p.description or "",
        "visibility": p.visibility,
        "sample": p.seed,
        "archived": p.archived,
        "createdBy": p.created_by,
        "createdAt": iso(p.created_at),
        "updatedAt": iso(p.updated_at),
        "lastActivityAt": iso(last_activity(db, p)),
        "resume": resume_dict(db, _resume_row(db, p.id, person(ctx))),
        "attested": db.scalar(select(ImportSession.id).where(ImportSession.project_id == p.id, ImportSession.attested_by == person(ctx)).limit(1)) is not None,
    }
    if p.seed and (raw := seed_entry(p.id)):
        out["license"] = raw.get("license")
        out["restricted"] = bool(raw.get("restricted"))
    return out


def list_projects(db: Session, ctx: RequestContext, q: str | None = None, sort: str = "recent", include_archived: bool = False) -> list[dict]:
    ensure_seeds_once(db)
    who = person(ctx)
    ensure_principal(db, who)
    orgs = select(OrganizationMember.org_id).where(OrganizationMember.principal == who)
    query = select(ProjectRow).where(ProjectRow.org_id.in_(orgs))
    if ctx.scopes:
        query = query.where(ProjectRow.id == ctx.workspace_id)
    if not include_archived:
        query = query.where(ProjectRow.archived.is_(False))
    rows = list(db.scalars(query))
    if q:
        needle = q.lower()
        rows = [p for p in rows if needle in p.title.lower() or needle in (p.description or "").lower()]
    out = [project_dict(db, ctx, p) for p in rows]
    if sort == "title":
        out.sort(key=lambda d: d["title"].lower())
    else:
        out.sort(key=lambda d: d["lastActivityAt"] or "", reverse=True)
    return out


def create_project(db: Session, ctx: RequestContext, title: str, description: str = "", visibility: str = "private") -> ProjectRow:
    who = person(ctx)
    org = ensure_principal(db, who)
    if org is None or ctx.scopes:
        raise HTTPException(403, "only people create projects")
    title = (title or "").strip()[:256]
    if not title:
        raise HTTPException(422, "a project needs a name")
    if visibility not in ("private", "shared"):
        raise HTTPException(422, "visibility is private or shared")
    p = ProjectRow(id=new_id("prj"), org_id=org, title=title, description=(description or "")[:4000], visibility=visibility, seed=False, archived=False, created_by=who)
    # The kernel workspace (plugin activation) is the project (todo6 D1), in the same transaction.
    ensure_workspace(db, p.id, title)
    db.add(p)
    db.flush()
    audit.record(db, ctx.for_scope(p.id, None), "project.created", target=p.id, after={"title": title})
    return p


def patch_project(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> ProjectRow:
    before = {"title": p.title, "description": p.description, "visibility": p.visibility, "archived": p.archived}
    if "title" in body:
        title = str(body["title"] or "").strip()[:256]
        if not title:
            raise HTTPException(422, "a project needs a name")
        p.title = title
    if "description" in body:
        p.description = str(body["description"] or "")[:4000]
    if "visibility" in body:
        if body["visibility"] not in ("private", "shared"):
            raise HTTPException(422, "visibility is private or shared")
        p.visibility = body["visibility"]
    if "archived" in body:
        p.archived = bool(body["archived"])
    p.updated_at = now()
    after = {"title": p.title, "description": p.description, "visibility": p.visibility, "archived": p.archived}
    if after != before:
        audit.record(db, ctx.for_scope(p.id, None), "project.updated", target=p.id, before=before, after=after)
    return p


# ---- Sources -----------------------------------------------------------------------------------


def source_dict(db: Session, s: Source) -> dict:
    root = db.get(SourceNode, s.root_node_id) if s.root_node_id else None
    used = [d.id for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == s.project_id)) if _uses_source(db, d, s)]
    return {
        "id": s.id,
        "projectId": s.project_id,
        "title": s.title,
        "kind": s.kind,
        "status": s.status,
        "rootNodeId": s.root_node_id,
        "fileCount": root.descendant_count if root else 0,
        "createdBy": s.created_by,
        "createdAt": iso(s.created_at),
        "usedInDatasets": used,
    }


def _uses_source(db: Session, d: DatasetRow, s: Source) -> bool:
    """A dataset uses an import when one of its files came from it (todo7 D7: the frozen
    file list), or, for an older definition, when it names one of its nodes."""
    definition = d.definition or {}
    refs = definition.get("files")
    ids = [str(r.get("nodeId")) for r in refs if isinstance(r, dict)] if isinstance(refs, list) else list(definition.get("nodeIds") or [])
    for i in range(0, len(ids), 500):
        if db.scalar(select(SourceNode.id).where(SourceNode.id.in_(ids[i : i + 500]), SourceNode.source_id == s.id).limit(1)) is not None:
            return True
    return False


def container_ids(db: Session, p_id: str) -> set[str]:
    """The drive root and the imports' top folders: containers, never records or items."""
    return {tree.drive_root_id(p_id), *(x for x in db.scalars(select(Source.root_node_id).where(Source.project_id == p_id)) if x)}


def visible_files(db: Session, p_id: str) -> list[SourceNode]:
    """The project's files that are not in Trash (nor inside a trashed folder)."""
    dirs = {r.id: r for r in db.execute(select(SourceNode.id, SourceNode.parent_id, SourceNode.trashed_at).where(SourceNode.project_id == p_id, SourceNode.is_dir.is_(True)))}
    ok: dict[str, bool] = {}

    def visible(fid: str | None) -> bool:
        path = []
        cur = fid
        result = False
        while cur is not None:
            if cur in ok:
                result = ok[cur]
                break
            d = dirs.get(cur)
            if d is None or d.trashed_at is not None:
                result = False
                path.append(cur)
                break
            path.append(cur)
            if d.parent_id is None:
                result = True
                break
            cur = d.parent_id
        for x in path:
            ok[x] = result
        return result

    return [n for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p_id, SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None))) if visible(n.parent_id)]


def list_sources(db: Session, p: ProjectRow) -> list[dict]:
    """Imports whose folder is still in Files (an import moved to Trash leaves the list)."""
    rows = list(db.scalars(select(Source).where(Source.project_id == p.id).order_by(Source.created_at)))
    ch = tree.chains(db, [s.root_node_id for s in rows if s.root_node_id])
    return [source_dict(db, s) for s in rows if not (s.root_node_id and s.root_node_id in ch and ch[s.root_node_id].hidden)]


def require_source(db: Session, ctx: RequestContext, source_id: str) -> tuple[Source, ProjectRow]:
    s = db.get(Source, source_id)
    if s is None:
        raise HTTPException(404, "no such source")
    return s, require_project(db, ctx, s.project_id)


def require_node(db: Session, ctx: RequestContext, node_id: str) -> tuple[SourceNode, ProjectRow]:
    n = db.get(SourceNode, node_id)
    if n is None:
        raise HTTPException(404, "no such file or folder")
    return n, require_project(db, ctx, n.project_id)


def datasets_using(db: Session, n: SourceNode) -> list[dict]:
    chain = {n.id, *(a.id for a in tree.ancestors(db, n))}
    out = []
    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == n.project_id)):
        definition = d.definition or {}
        refs = definition.get("files")
        if isinstance(refs, list):
            hit = (not n.is_dir and any(isinstance(r, dict) and r.get("nodeId") == n.id for r in refs)) or bool(chain & set(definition.get("followedFolders") or []))
            if n.is_dir and not hit:
                files = {str(r.get("nodeId")) for r in refs if isinstance(r, dict)}
                hit = any(f.id in files for f in tree.files_under(db, [n.id])) if files and n.descendant_count <= 5000 else False
        else:
            hit = bool(chain & set(definition.get("nodeIds") or []))
        if hit:
            tasks = [{"id": t.id, "title": t.title} for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id))]
            out.append({"id": d.id, "title": d.title, "tasks": tasks})
    return out


def is_member(ctx: RequestContext | None) -> bool:
    """A person (not an agent token): may see original names (todo7 Phase 7)."""
    return ctx is not None and not ctx.scopes and person(ctx).startswith("user:")


def describe_node(db: Session, n: SourceNode, ctx: RequestContext | None = None) -> dict:
    stars = fs.starred_ids(db, n.project_id, person(ctx)) if ctx is not None else None
    out = tree.node_dict(n, starred=stars)
    out["path"] = [{"id": a.id, "name": a.name} for a in tree.ancestors(db, n)]
    chain = tree.chain_of(db, n)
    out["pathText"] = chain.path
    if is_member(ctx):
        out["originalPath"] = n.original_path or None
    out["usedIn"] = datasets_using(db, n)
    out["runId"] = tree.run_of(db, n)
    src = db.get(Source, n.source_id) if n.source_id else None
    session = db.get(ImportSession, n.import_session_id) if n.import_session_id else None
    out["provenance"] = {
        "sourceId": n.source_id,
        "sourceTitle": src.title if src else None,
        "importSessionId": n.import_session_id,
        "addedBy": (session.created_by if session else src.created_by if src else None),
        "addedAt": iso(n.created_at),
        "sha256": n.sha256,
    }
    if n.trashed_at is not None:
        parent_ok = len(chain.ids) >= 2 and not any(t is not None for t in chain.trashed[:-1])
        out["trash"] = {"trashedAt": iso(n.trashed_at), "trashedBy": n.trashed_by or "", "originalParentId": n.parent_id, "originalLocation": (chain.folder or tree.ROOT_NAME) if parent_ok else None}
    else:
        out["trash"] = None
    return out


def search_nodes(db: Session, p: ProjectRow, q: str, kind: str | None = None, status: str | None = None, limit: int = 200) -> list[dict]:
    query = select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.parent_id.is_not(None), SourceNode.trashed_at.is_(None))
    if q:
        query = query.where(func.lower(SourceNode.name).contains(q.lower()))
    if kind:
        query = query.where(SourceNode.detected_kind == kind)
    rows = list(db.scalars(query.limit(limit * 4)))
    ch = tree.chains(db, [n.id for n in rows])
    out = []
    for n in rows:
        c = ch.get(n.id)
        if c is not None and c.hidden:
            continue
        d = tree.node_dict(n)
        if status == "attention" and d["status"] not in ("attention", "privacy"):
            continue
        if status == "unsupported" and d["status"] != "unsupported":
            continue
        d["folderPath"] = c.folder if c is not None else ""
        out.append(d)
        if len(out) >= limit:
            break
    out.sort(key=lambda d: tree.natural_key(d["name"]))
    return out


def preview(db: Session, ctx: RequestContext, n: SourceNode) -> dict:
    """Type-specific preview JSON. Never patient identifiers: DICOM facts are the stored,
    already filtered ones (the worker drops PHI tags before reporting)."""
    kind = n.detected_kind
    out: dict[str, Any] = {"nodeId": n.id, "kind": kind}
    asset = db.get(Asset, n.asset_id) if n.asset_id else None
    if n.is_dir:
        out["kind"] = "folder"
        return out
    if asset is not None and kind in ("image", "mask") and not (n.flags or {}).get("privacy"):
        out["url"] = assets.sign_path(n.project_id, asset.path)
    thumb = (n.facts or {}).get("thumbnail")
    if isinstance(thumb, str) and not (n.flags or {}).get("privacy"):
        out["thumbnailUrl"] = assets.sign_path(n.project_id, thumb)
    if kind == "table" and asset is not None:
        out["table"] = table_head(asset)
    if (n.facts or {}).get("dicom"):
        out["dicom"] = n.facts["dicom"]
    if (n.facts or {}).get("video"):
        out["video"] = n.facts["video"]
    out["facts"] = n.facts or {}
    return out


def table_head(asset: Asset, rows: int = 50) -> dict:
    """The first rows of a CSV/TSV with a per-column type and fill profile."""
    import csv
    import io

    try:
        raw = assets.asset_head(asset, 1024 * 1024)
    except HTTPException:
        return {"columns": [], "rows": []}
    text = raw.decode("utf-8-sig", errors="replace")
    if len(raw) == 1024 * 1024:
        text = text.rsplit("\n", 1)[0]
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = list(csv.reader(io.StringIO(text), dialect))
    if not reader:
        return {"columns": [], "rows": []}
    header, body = reader[0], reader[1:]
    columns = []
    for i, name in enumerate(header):
        vals = [r[i] for r in body if i < len(r)]
        filled = [v for v in vals if v.strip()]
        columns.append({"name": name, "type": column_type(filled), "filled": len(filled), "total": len(vals)})
    return {"columns": columns, "rows": body[:rows], "rowCount": len(body), "truncated": len(raw) == 1024 * 1024}


def column_type(values: list[str]) -> str:
    if not values:
        return "empty"

    def num(v: str) -> bool:
        try:
            float(v)
            return True
        except ValueError:
            return False

    if all(num(v) for v in values):
        return "number"
    if len(set(values)) <= max(2, len(values) // 5) and len(set(values)) <= 50:
        return "category"
    return "text"


# ---- Datasets and tasks ------------------------------------------------------------------------


def resolve_files(db: Session, node_ids: list[str]) -> tuple[list[dict], list[str]]:
    """todo7 D7: a dataset's folders and files become a frozen list of files at their current
    versions; the folders are kept only as `followedFolders`, for the "new files" banner."""
    files = [{"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1} for n in tree.files_under(db, node_ids)]
    folders = set(db.scalars(select(SourceNode.id).where(SourceNode.id.in_(list(node_ids)), SourceNode.is_dir.is_(True)))) if node_ids else set()
    return files, [i for i in node_ids if i in folders]


def dataset_files(db: Session, d: DatasetRow, *, include_hidden: bool = True) -> list[tuple[SourceNode, dict]]:
    """(node, pinned ref) for every file of a dataset that still exists. An older definition
    without `files` resolves its `nodeIds` live."""
    definition = d.definition or {}
    refs = definition.get("files")
    if not isinstance(refs, list):
        return [(n, {"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1}) for n in tree.files_under(db, definition.get("nodeIds") or [])]
    ids = [str(r.get("nodeId")) for r in refs if isinstance(r, dict)]
    nodes: dict[str, SourceNode] = {}
    for i in range(0, len(ids), 500):
        for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(ids[i : i + 500]))):
            nodes[n.id] = n
    out = [(nodes[str(r["nodeId"])], r) for r in refs if isinstance(r, dict) and str(r.get("nodeId")) in nodes]
    if not include_hidden:
        ch = tree.chains(db, [n.id for n, _ in out])
        out = [(n, r) for n, r in out if not (ch.get(n.id) and ch[n.id].hidden)]
    return out


def pinned_view(db: Session, n: SourceNode, ref: dict) -> tuple[str | None, dict, dict, str | None, str | None, int | None]:
    """(kind, facts, flags, asset id, sha256, size) of the version a dataset pinned (D6)."""
    version = int(ref.get("version") or 1)
    if version != (n.version or 1):
        v = db.get(NodeVersion, (n.id, version))
        if v is not None:
            return v.detected_kind, v.facts or {}, v.flags or {}, v.asset_id, v.sha256, v.size
    return n.detected_kind, n.facts or {}, n.flags or {}, ref.get("assetId") or n.asset_id, n.sha256, n.size


def staleness(db: Session, d: DatasetRow, pairs: list[tuple[SourceNode, dict]] | None = None) -> dict:
    definition = d.definition or {}
    pairs = dataset_files(db, d) if pairs is None else pairs
    newer = sum(1 for n, r in pairs if (n.version or 1) > int(r.get("version") or 1))
    followed = [str(x) for x in definition.get("followedFolders") or []]
    have = {n.id for n, _ in pairs} | {str(r.get("nodeId")) for r in definition.get("files") or [] if isinstance(r, dict)}
    new = [n for n in tree.files_under(db, followed) if n.id not in have] if followed and isinstance(definition.get("files"), list) else []
    names = [n.name for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(followed)))] if followed else []
    return {"newerVersions": newer, "newFilesInFollowed": len(new), "followedFolderNames": names}


def dataset_dict(db: Session, d: DatasetRow) -> dict:
    tasks = [task_dict(db, t) for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id).order_by(TaskRow.created_at))]
    pairs = dataset_files(db, d)
    from . import collections

    return {"id": d.id, "projectId": d.project_id, "title": d.title, "description": d.description or "", "definition": d.definition or {}, "fileCount": len(pairs), "tasks": tasks, "createdFromProposalId": d.created_from_proposal_id, "createdBy": d.created_by, "createdAt": iso(d.created_at), "staleness": staleness(db, d, pairs),
            "collections": collections.list_dicts(db, d), "draft": is_draft_dataset(db, d)}


def is_draft_dataset(db: Session, d: DatasetRow) -> bool:
    """todo13 D6: a dataset is a draft while it was made as one (a boot or a drop: `definition.draft`)
    or all its tasks are drafts, and no task of it was published."""
    states = list(db.scalars(select(TaskRow.state).where(TaskRow.dataset_id == d.id)))
    if any((st or "published") == "published" for st in states):
        return False
    return bool((d.definition or {}).get("draft")) or (bool(states) and all(st == "draft" for st in states))


def _annotation_counts(db: Session, d: DatasetRow) -> Counter:
    """Annotations per item (asset path) across the dataset's tasks."""
    out: Counter = Counter()
    for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id)):
        doc = db.get(AnnotationDocumentRow, (t.project_id, t.id))
        for a in (doc.annotations if doc else []) or []:
            if isinstance(a, dict) and a.get("itemId"):
                out[a["itemId"]] += 1
    return out


def update_versions_preview(db: Session, d: DatasetRow, node_ids: list[str] | None = None) -> dict:
    counts = _annotation_counts(db, d)
    files = []
    for n, r in dataset_files(db, d):
        if (n.version or 1) <= int(r.get("version") or 1) or (node_ids is not None and n.id not in node_ids):
            continue
        old = db.get(Asset, r.get("assetId")) if r.get("assetId") else None
        files.append({"nodeId": n.id, "name": n.name, "from": int(r.get("version") or 1), "to": n.version or 1, "annotations": counts.get(old.path, 0) if old else 0})
    return {"files": files}


def update_versions(db: Session, ctx: RequestContext, d: DatasetRow, node_ids: list[str] | None = None) -> DatasetRow:
    """Move pinned files to their current versions. Annotations stay on the version they
    were drawn on (their items are asset paths)."""
    definition = dict(d.definition or {})
    if not isinstance(definition.get("files"), list):
        refs, followed = resolve_files(db, definition.get("nodeIds") or [])
        definition["files"] = refs
        definition.setdefault("followedFolders", followed)
    nodes = {n.id: n for n, _ in dataset_files(db, DatasetRow(definition=definition))}
    changed = []
    files = []
    for r in definition["files"]:
        n = nodes.get(str(r.get("nodeId"))) if isinstance(r, dict) else None
        if n is not None and (n.version or 1) > int(r.get("version") or 1) and (node_ids is None or n.id in node_ids):
            changed.append({"nodeId": n.id, "from": int(r.get("version") or 1), "to": n.version or 1})
            r = {"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1}
        files.append(r)
    definition["files"] = files
    d.definition = definition
    if changed:
        audit.record(db, ctx.for_scope(d.project_id, None), "dataset.versions_updated", target=d.id, after={"title": d.title, "files": len(changed), "changes": changed[:200]})
    db.flush()
    return d


def add_followed(db: Session, ctx: RequestContext, d: DatasetRow) -> DatasetRow:
    """Add the files that appeared in followed folders since the dataset was made."""
    definition = dict(d.definition or {})
    refs = list(definition.get("files") or [])
    have = {str(r.get("nodeId")) for r in refs if isinstance(r, dict)}
    new = [n for n in tree.files_under(db, [str(x) for x in definition.get("followedFolders") or []]) if n.id not in have]
    if new:
        refs.extend({"nodeId": n.id, "assetId": n.asset_id, "version": n.version or 1} for n in new)
        definition["files"] = refs
        held = [n.id for n in new if tree.status_of(n) == "privacy"]
        if held:
            definition["heldNodeIds"] = list(dict.fromkeys([*(definition.get("heldNodeIds") or []), *held]))
        d.definition = definition
        audit.record(db, ctx.for_scope(d.project_id, None), "dataset.files_added", target=d.id, after={"title": d.title, "files": len(new)})
        db.flush()
    return d


def task_dict(db: Session, t: TaskRow) -> dict:
    doc = db.get(AnnotationDocumentRow, (t.project_id, t.id))
    anns = doc.annotations if doc else []
    return {"id": t.id, "datasetId": t.dataset_id, "projectId": t.project_id, "title": t.title, "kind": t.kind, "revision": t.revision, "annotationCount": len(anns), "annotatedItems": len({a.get("itemId") for a in anns}), "createdAt": iso(t.created_at), "state": t.state or "published", "bootId": t.boot_id, "collectionId": t.collection_id}


def require_dataset(db: Session, ctx: RequestContext, dataset_id: str) -> tuple[DatasetRow, ProjectRow]:
    d = db.get(DatasetRow, dataset_id)
    if d is None:
        raise HTTPException(404, "no such dataset")
    return d, require_project(db, ctx, d.project_id)


def require_task(db: Session, ctx: RequestContext, task_id: str) -> tuple[TaskRow, ProjectRow]:
    t = db.get(TaskRow, task_id)
    if t is None:
        raise HTTPException(404, "no such task")
    return t, require_project(db, ctx, t.project_id)


def _check_nodes(db: Session, p: ProjectRow, node_ids: list[str]) -> list[str]:
    ids = [str(x) for x in node_ids]
    found = set(db.scalars(select(SourceNode.id).where(SourceNode.id.in_(ids), SourceNode.project_id == p.id))) if ids else set()
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(422, f"not in this project: {missing[:5]}")
    return ids


def create_dataset(db: Session, ctx: RequestContext, p: ProjectRow, title: str, definition: dict, description: str = "", proposal_id: str | None = None) -> DatasetRow:
    title = (title or "").strip()[:256]
    if not title:
        raise HTTPException(422, "a dataset needs a name")
    definition = dict(definition or {})
    definition["nodeIds"] = _check_nodes(db, p, definition.get("nodeIds") or [])
    if not definition["nodeIds"]:
        raise HTTPException(422, "pick at least one folder or file")
    files = tree.files_under(db, definition["nodeIds"])
    # todo7 D7: frozen when created; moving files in Files never changes the dataset.
    definition["files"], definition["followedFolders"] = resolve_files(db, definition["nodeIds"])
    held = [n.id for n in files if tree.status_of(n) == "privacy"]
    if held:
        definition["heldNodeIds"] = held
    d = DatasetRow(id=new_id("ds"), project_id=p.id, title=title, description=description[:4000], definition=definition, created_from_proposal_id=proposal_id, created_by=person(ctx))
    db.add(d)
    db.flush()
    audit.record(db, ctx.for_scope(p.id, None), "dataset.created", target=d.id, after={"title": title, "files": len(definition["files"]), "proposalId": proposal_id})
    return d


def create_task(db: Session, ctx: RequestContext, d: DatasetRow, title: str, kind: str, environment: dict | None) -> TaskRow:
    title = (title or "").strip()[:256]
    if not title:
        raise HTTPException(422, "a task needs a name")
    t = TaskRow(id=new_id("tsk"), dataset_id=d.id, project_id=d.project_id, title=title, kind=(kind or "annotate")[:64], revision=0, created_by=person(ctx))
    db.add(t)
    db.flush()
    if environment is not None:
        if not isinstance(environment, dict):
            raise HTTPException(422, "environment must be an object")
        at = now()
        from ..models import WorkspaceEnvironmentRevision

        author = person(ctx).removeprefix("user:")
        db.add(WorkspaceEnvironment(workspace_id=d.project_id, task_id=t.id, revision=1, environment=environment, author=author, saved_at=at))
        from .canonical import NULL_CONTENT_HASH, content_hash

        # A new task's first revision has no base (todo10 Phase 1: every revision has a parent).
        db.add(WorkspaceEnvironmentRevision(workspace_id=d.project_id, task_id=t.id, revision=1, environment=environment, author=author, saved_at=at, content_hash=content_hash(environment), parent_hash=NULL_CONTENT_HASH, author_kind="agent" if person(ctx).startswith("agent:") else "person"))
    audit.record(db, ctx.for_scope(d.project_id, t.id), "task.created", target=t.id, after={"title": t.title, "kind": t.kind, "datasetId": d.id})
    return t


def add_folders(db: Session, entries: list[dict]) -> None:
    """todo8 D3: set each entry's `folder`, its node's current Data folder (names from the
    parent chain, never `original_path`) below the task's common folder. Entries whose node
    is gone keep no `folder`."""
    found = tree.chains(db, [str(e["nodeId"]) for e in entries if e.get("nodeId")])
    folders = {i: found[str(e["nodeId"])].names[1:-1] for i, e in enumerate(entries) if e.get("nodeId") and str(e["nodeId"]) in found}
    if not folders:
        return
    common = list(next(iter(folders.values())))
    for names in folders.values():
        k = 0
        while k < len(common) and k < len(names) and common[k] == names[k]:
            k += 1
        del common[k:]
    for i, names in folders.items():
        entries[i]["folder"] = names[len(common) :]


def task_document(db: Session, t: TaskRow) -> dict:
    """A `Project`-shaped document (packages/contracts `Project`), so every data kind's
    `groupItems(project)` works unchanged for uploaded data: the compatibility seam."""
    p = db.get(ProjectRow, t.project_id)
    assert p is not None
    saved = db.get(WorkspaceEnvironment, (p.id, t.id))
    env = saved.environment if saved and saved.environment is not None else None
    if p.seed and t.id == p.id and (raw := seed_entry(p.id)):
        doc = {k: v for k, v in raw.items() if k not in ("viewer",)}
        environment = env or manifest_environment(p.id) or {}
        # The sample's files are nodes with stable ids (`ensure_seeds`): copy the manifest's
        # entries (cached, shared) and add each one's node and current folder.
        _, rels = _seed_files(raw)
        seeded = [{**a, "nodeId": tree.node_id(p.id, rel)} for rel, a in rels]
        add_folders(db, seeded)
        by_path = {a["path"]: a for a in seeded}
        doc["assets"] = [by_path.get(a.get("path"), a) for a in raw.get("assets") or []]
        return {**doc, "id": t.id, "title": t.title, "environment": environment, "labels": environment.get("labels"), "task": environment.get("task") or raw.get("task"), "status": "available"}
    d = db.get(DatasetRow, t.dataset_id)
    definition = (d.definition if d else None) or {}
    environment = env or definition.get("environment") or {}
    labels = definition.get("labels") or {}
    items = []
    from . import ingest

    ingesting = ingest.task_items(db, t.id)
    theirs = {ti.node_id for ti in ingesting}
    from . import collections

    # todo13 D7: a task on one collection sees only that collection's files.
    in_collection = collections.item_filter(db, t, d)
    if d is not None:
        for n, ref in dataset_files(db, d, include_hidden=False):
            if n.id in theirs:
                continue  # listed below, in drop order, with its ingest state
            if in_collection is not None and not in_collection(n.id):
                continue
            kind, facts, flags, asset_id, sha, size = pinned_view(db, n, ref)
            if asset_id is None or (kind or "") not in VIEWABLE or kind is None:
                continue
            if (flags.get("privacy") or {}) and not flags["privacy"].get("clearedBy"):
                continue
            a = db.get(Asset, asset_id)
            if a is None:
                continue
            # The item id is the asset's storage path, which never changes (D3): annotations
            # stay on their items whatever happens to the file's name or folder.
            entry: dict[str, Any] = {"path": a.path, "sha256": sha or "", "bytes": size or 0, "name": n.name, "nodeId": n.id}
            for k in ("width", "height", "fps", "frames", "duration"):
                if facts.get(k) is not None:
                    entry[k] = facts[k]
            if n.id in labels:
                entry["label"] = labels[n.id]
            items.append(entry)
    # Items dropped into the Studio (todo11 D8): there from `registered` on, after the rest.
    items += [ingest.entry(ti) for ti in ingesting]
    add_folders(db, items)
    return {
        "id": t.id,
        "title": t.title,
        "environment": environment,
        "labels": environment.get("labels"),
        "task": environment.get("task") or t.kind,
        "source": "Uploaded to this project",
        "license": "Your data: you confirmed you may use it for research",
        "status": "available",
        "projectId": p.id,
        "datasetId": t.dataset_id,
        "collectionId": t.collection_id,
        "assets": items,
    }


# ---- Proposals ---------------------------------------------------------------------------------

# todo13 D8: `structure`, a change to a published dataset's structure.json, confirmed by a person.
PROPOSAL_KINDS = {"group", "relationship", "mapping", "dataset", "task", "structure"}
STRENGTHS = {"strong", "possible", "weak"}


def proposal_dict(pr: Proposal) -> dict:
    return {"id": pr.id, "projectId": pr.project_id, "kind": pr.kind, "payload": pr.payload or {}, "evidence": pr.evidence or {}, "strength": pr.strength, "status": pr.status, "importSessionId": pr.import_session_id, "createdBy": pr.created_by, "createdAt": iso(pr.created_at), "decidedBy": pr.decided_by, "decidedAt": iso(pr.decided_at)}


def create_proposal(db: Session, ctx: RequestContext, p: ProjectRow, kind: str, payload: dict, evidence: dict, strength: str, created_by: str, import_session_id: str | None = None) -> Proposal:
    if kind not in PROPOSAL_KINDS:
        raise HTTPException(422, f"kind is one of {sorted(PROPOSAL_KINDS)}")
    if strength not in STRENGTHS:
        raise HTTPException(422, f"strength is one of {sorted(STRENGTHS)}")
    pr = Proposal(id=new_id("prp"), project_id=p.id, kind=kind, payload=payload or {}, evidence=evidence or {}, strength=strength, status="proposed", import_session_id=import_session_id, created_by=created_by[:256])
    db.add(pr)
    db.flush()
    events.publish(db, ctx.for_scope(p.id, None), "proposal.created", {"projectId": p.id, "proposalId": pr.id, "kind": kind}, source="kernel")
    # Activity shows who proposed what (the assistant for a person, the inspection worker).
    audit.record(db, ctx.for_scope(p.id, None), "proposal.created", target=pr.id, after={"kind": kind, "strength": strength, "importSessionId": import_session_id})
    return pr


def list_proposals(db: Session, p: ProjectRow, status: str | None = None) -> list[dict]:
    q = select(Proposal).where(Proposal.project_id == p.id)
    if status:
        q = q.where(Proposal.status.in_(status.split(",")))
    return [proposal_dict(x) for x in db.scalars(q.order_by(Proposal.created_at))]


def require_proposal(db: Session, ctx: RequestContext, proposal_id: str, *, write: bool = False) -> tuple[Proposal, ProjectRow]:
    pr = db.get(Proposal, proposal_id)
    if pr is None:
        raise HTTPException(404, "no such proposal")
    return pr, require_project(db, ctx, pr.project_id, write=write)


def _only_people(ctx: RequestContext) -> None:
    """Agents and plugins propose; only a person confirms or dismisses (docs/ux.md §9)."""
    if ctx.scopes or not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only a person can confirm or dismiss a proposal; the assistant can only propose")


# Confirming some kinds does something (a dataset proposal creates the dataset and task).
# Registered by the modules that own the effect (kernel/explore.py).
CONFIRM_EFFECTS: dict[str, Any] = {}


def decide(db: Session, ctx: RequestContext, pr: Proposal, p: ProjectRow, decision: str, payload: dict | None = None) -> dict:
    _only_people(ctx)
    if pr.status != "proposed":
        raise HTTPException(409, f"this proposal is already {pr.status}")
    before = pr.payload
    result: dict = {}
    if decision == "confirm":
        if payload is not None:
            if not isinstance(payload, dict):
                raise HTTPException(422, "payload must be an object")
            pr.payload = {**(pr.payload or {}), **payload}
        effect = CONFIRM_EFFECTS.get(pr.kind)
        if effect is not None:
            result = effect(db, ctx, p, pr) or {}
        pr.status = "confirmed"
    else:
        pr.status = "dismissed"
    pr.decided_by, pr.decided_at = ctx.principal, now()
    scoped = ctx.for_scope(p.id, None)
    audit.record(db, scoped, f"proposal.{'confirmed' if decision == 'confirm' else 'dismissed'}", target=pr.id, before={"payload": before}, after={"kind": pr.kind, "payload": pr.payload, **result})
    events.publish(db, scoped, "proposal.decided", {"projectId": p.id, "proposalId": pr.id, "status": pr.status}, source="kernel")
    return {"proposal": proposal_dict(pr), **result}


# ---- Resume ------------------------------------------------------------------------------------


def get_resume(db: Session, ctx: RequestContext, p: ProjectRow) -> dict | None:
    return resume_dict(db, _resume_row(db, p.id, person(ctx)))


def put_resume(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> dict | None:
    task_id = str(body.get("taskId") or "")
    t = db.get(TaskRow, task_id)
    if t is None or t.project_id != p.id:
        raise HTTPException(422, "taskId must name a task of this project")
    who = person(ctx)
    r = _resume_row(db, p.id, who)
    if r is None:
        r = ProjectResume(project_id=p.id, principal=who, task_id=t.id)
        db.add(r)
    item = body.get("itemId")
    placement = body.get("placement")
    tool = body.get("tool")
    r.task_id = t.id
    r.item_id = str(item)[:1024] if item is not None else None
    r.placement = placement if isinstance(placement, dict) else None
    r.tool = str(tool)[:128] if tool else None
    r.at = now()
    db.flush()
    return resume_dict(db, r)
