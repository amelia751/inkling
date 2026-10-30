"""Project Overview, the review queue and the activity feed (todo6 Phases 1, 3 and 8).

Every block is computed from real rows; a block with nothing to show is left out, so the
UI never shows a number the API didn't return (docs/ux.md §4: verified project state only).
The Overview's "Needs your attention" is the top of the same queue the Review page shows.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import AnnotationDocumentRow, DatasetRow, ImportSession, PluginAudit, ProjectRow, Proposal, Source, SourceNode, TaskRow, UploadFile, WorkspaceEnvironmentRevision
from . import projects, tree

SEVERITY = {"high": 0, "medium": 1, "low": 2}

# Plain words for detected kinds (docs/ux.md: "Table", "MRI series", never "MIME").
KIND_LABELS = {
    "image": ("Image", "Images"),
    "dicom": ("DICOM image", "DICOM images"),
    "dicom-series": ("DICOM series", "DICOM series"),
    "volume": ("3D volume", "3D volumes"),
    "video": ("Video", "Videos"),
    "waveform": ("Waveform", "Waveforms"),
    "slide": ("Whole-slide image", "Whole-slide images"),
    "table": ("Table", "Tables"),
    "document": ("Document", "Documents"),
    "mask": ("Mask", "Masks"),
    "annotations": ("Annotations", "Annotation files"),
    "archive": ("Archive", "Archives"),
    "unknown": ("Can't read yet", "Can't read yet"),
}


def kind_label(kind: str | None, n: int = 1) -> str:
    one, many = KIND_LABELS.get(kind or "", ("File", "Files"))
    return one if n == 1 else many


# ---- Data cards --------------------------------------------------------------------------------


def data_cards(db: Session, p: ProjectRow, limit: int = 4) -> list[dict]:
    """Confirmed collections (datasets made by a person) first, else sources by detected kind."""
    cards: list[dict] = []
    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at)):
        if (d.definition or {}).get("seed"):
            continue
        files = tree.files_under(db, (d.definition or {}).get("nodeIds") or [])
        kinds = Counter(n.detected_kind for n in files)
        main = kinds.most_common(1)[0][0] if kinds else None
        cards.append({"type": "dataset", "id": d.id, "title": d.title, "count": len(files), "kind": main, "kindLabel": kind_label(main, len(files)), "datasetId": d.id})
    if cards:
        return cards[:limit]
    for s in db.scalars(select(Source).where(Source.project_id == p.id).order_by(Source.created_at)):
        rows = db.execute(select(SourceNode.detected_kind, SourceNode.parent_id).where(SourceNode.source_id == s.id, SourceNode.is_dir.is_(False))).all()
        by_kind: dict[str | None, list[str | None]] = {}
        for kind, parent in rows:
            by_kind.setdefault(kind, []).append(parent)
        for kind, parents in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
            if kind is None:
                continue
            # Open the folder that holds this kind when it's one folder, else the source root.
            folder = parents[0] if len(set(parents)) == 1 else s.root_node_id
            node = db.get(SourceNode, folder) if folder else None
            title = node.name if node is not None and node.parent_id is not None else s.title
            cards.append({"type": "source", "id": f"{s.id}:{kind}", "title": title, "count": len(parents), "kind": kind, "kindLabel": kind_label(kind, len(parents)), "sourceId": s.id, "nodeId": folder})
    cards.sort(key=lambda c: -c["count"])
    return cards[:limit]


# ---- Review queue ------------------------------------------------------------------------------


def _proposal_item(pr: Proposal) -> dict:
    ev = pr.evidence or {}
    payload = pr.payload or {}
    tab = {"relationship": "relationships", "mapping": "mappings"}.get(pr.kind, "summary")
    if pr.kind == "relationship":
        open_rows = int(ev.get("unmatched") or 0) + int(ev.get("ambiguous") or 0)
        title = f"{open_rows} {'record needs' if open_rows == 1 else 'records need'} matching" if open_rows else "Confirm how your files are linked"
    elif pr.kind == "mapping":
        title = "Confirm how a table column becomes labels"
    elif pr.kind in ("dataset", "task"):
        title = "A dataset is ready to create"
    else:
        title = "Confirm a group of files"
    return {
        "id": f"proposal:{pr.id}",
        "type": "proposal",
        "severity": "medium",
        "title": title,
        "detail": payload.get("summary") or ev.get("summary") or "",
        "strength": pr.strength,
        "target": {"section": "explore", "tab": tab, "proposalId": pr.id},
        "createdBy": pr.created_by,
        "at": projects.iso(pr.created_at),
    }


def review_queue(db: Session, p: ProjectRow) -> list[dict]:
    items: list[dict[str, Any]] = []
    # Privacy holds: always first, one row per held file.
    for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False))):
        priv = (n.flags or {}).get("privacy")
        if priv and not priv.get("clearedBy"):
            items.append({"id": f"privacy:{n.id}", "type": "privacy", "severity": "high", "title": "Held for privacy review", "detail": f"{n.name}: {priv.get('reason') or 'may contain patient identifiers'}", "target": {"section": "sources", "nodeId": n.id}, "at": projects.iso(n.created_at)})
    # Imports that failed or only partly arrived.
    for s in db.scalars(select(ImportSession).where(ImportSession.project_id == p.id)):
        failed = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state.in_(("failed", "rejected")))))
        if s.state == "failed" or failed:
            n = len(failed)
            title = f"{n} {'file' if n == 1 else 'files'} didn't upload" if n else "An import failed"
            items.append({"id": f"import:{s.id}", "type": "import", "severity": "high", "title": title, "detail": s.error or (failed[0].reason if failed else ""), "target": {"section": "sources", "importId": s.id}, "at": projects.iso(s.started_at)})
    # Files nobody can open yet, as one row.
    unknown = [n for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.detected_kind == "unknown"))]
    if unknown:
        items.append({"id": "quality:unsupported", "type": "quality", "severity": "low", "title": f"{len(unknown)} {'file' if len(unknown) == 1 else 'files'} we can't read yet", "detail": ", ".join(n.name for n in unknown[:3]), "target": {"section": "sources", "status": "unsupported", "nodeId": unknown[0].id}, "at": projects.iso(unknown[0].created_at)})
    for pr in db.scalars(select(Proposal).where(Proposal.project_id == p.id, Proposal.status == "proposed").order_by(Proposal.created_at)):
        items.append(_proposal_item(pr))
    # Annotation review: assistant or plugin suggestions nobody has accepted yet, per task.
    for t in db.scalars(select(TaskRow).where(TaskRow.project_id == p.id)):
        doc = db.get(AnnotationDocumentRow, (p.id, t.id))
        pending = [a for a in (doc.annotations if doc else []) if a.get("provenance") in ("ai-suggested", "imported") and (a.get("attributes") or {}).get("review_status", "pending") == "pending"]
        if pending:
            n = len(pending)
            items.append({"id": f"annotations:{t.id}", "type": "annotations", "severity": "low", "title": f"{n} {'annotation' if n == 1 else 'annotations'} to review", "detail": t.title, "target": {"section": "studio", "taskId": t.id}, "datasetId": t.dataset_id, "at": projects.iso(doc.saved_at if doc else None)})
    items.sort(key=lambda i: (SEVERITY[i["severity"]], i.get("at") or ""))
    return items


# ---- Overview ----------------------------------------------------------------------------------


def overview(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    out: dict[str, Any] = {"project": projects.project_dict(db, ctx, p)}
    resume = out["project"]["resume"]
    if resume:
        out["resume"] = resume
    tasks = list(db.scalars(select(TaskRow).where(TaskRow.project_id == p.id).order_by(TaskRow.created_at)))
    out["tasks"] = [{"id": t.id, "title": t.title, "kind": t.kind, "datasetId": t.dataset_id} for t in tasks]
    cards = data_cards(db, p)
    if cards:
        out["data"] = cards
    queue = review_queue(db, p)
    if queue:
        out["attention"] = queue[:5]
        out["attentionTotal"] = len(queue)
    out["empty"] = not db.scalar(select(SourceNode.id).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False)).limit(1))
    imports = [s for s in db.scalars(select(ImportSession).where(ImportSession.project_id == p.id, ImportSession.state.in_(("uploading", "inspecting", "needs_review", "ready"))).order_by(ImportSession.started_at.desc()).limit(1))]
    if imports:
        out["latestImport"] = {"id": imports[0].id, "state": imports[0].state}
    return out


# ---- Activity ----------------------------------------------------------------------------------

ACTIVITY_LABELS = {
    "project.created": "created the project",
    "project.updated": "changed the project's details",
    "import.started": "started adding files",
    "import.completed": "added files",
    "import.cancelled": "cancelled an upload",
    "proposal.confirmed": "confirmed a proposal",
    "proposal.dismissed": "dismissed a proposal",
    "privacy.cleared": "cleared a privacy hold",
    "dataset.created": "created a dataset",
    "task.created": "created a task",
    "workspace.environment": "changed the Studio setup",
}


def activity(db: Session, p: ProjectRow, cursor: int | None = None, limit: int = 100) -> dict:
    """Newest first: the audit log of the project's workspace plus environment revisions.
    `cursor` is the audit id to continue below."""
    q = select(PluginAudit).where(PluginAudit.workspace_id == p.id)
    if cursor:
        q = q.where(PluginAudit.id < cursor)
    rows = list(db.scalars(q.order_by(PluginAudit.id.desc()).limit(limit)))
    entries = []
    for r in rows:
        if r.action.startswith(("jobs.", "sessions.", "annotations.commit")) and r.action not in ACTIVITY_LABELS:
            continue
        after = r.after_ref if isinstance(r.after_ref, dict) else {}
        entries.append({"id": f"audit:{r.id}", "action": r.action, "label": ACTIVITY_LABELS.get(r.action) or r.action.replace(".", " "), "actor": r.actor_id, "onBehalfOf": r.on_behalf_of, "target": r.target, "details": after, "at": projects.iso(r.timestamp), "link": _link(r)})
    if not cursor:
        for e in db.scalars(select(WorkspaceEnvironmentRevision).where(WorkspaceEnvironmentRevision.workspace_id == p.id).order_by(WorkspaceEnvironmentRevision.id.desc()).limit(limit)):
            entries.append({"id": f"env:{e.id}", "action": "environment.saved", "label": f"saved Studio setup revision {e.revision}", "actor": f"user:{e.author}" if e.author and ":" not in e.author else e.author, "target": e.task_id, "details": {"revision": e.revision}, "at": projects.iso(e.saved_at), "link": {"section": "studio", "taskId": e.task_id}})
    entries.sort(key=lambda e: e["at"] or "", reverse=True)
    return {"entries": entries[:limit], "nextCursor": str(rows[-1].id) if len(rows) == limit else None}


def _link(r: PluginAudit) -> dict | None:
    a, t = r.action, r.target
    if a.startswith("import."):
        return {"section": "sources", "importId": t}
    if a.startswith("proposal."):
        return {"section": "explore", "proposalId": t}
    if a == "dataset.created":
        return {"section": "datasets", "datasetId": t}
    if a == "task.created":
        return {"section": "studio", "taskId": t}
    if a == "privacy.cleared":
        return {"section": "sources", "nodeId": t}
    if a.startswith("versioning."):
        return {"section": "datasets"}
    return None

