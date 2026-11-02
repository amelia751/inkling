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
from . import projects
from .kinds import wfdb_parts

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
        files = [n for n, _ in projects.dataset_files(db, d)]
        kinds = Counter(n.detected_kind for n in files)
        main = kinds.most_common(1)[0][0] if kinds else None
        cards.append({"type": "dataset", "id": d.id, "title": d.title, "count": len(files), "kind": main, "kindLabel": kind_label(main, len(files)), "datasetId": d.id})
    if cards:
        return cards[:limit]
    visible = projects.visible_files(db, p.id)
    for s in db.scalars(select(Source).where(Source.project_id == p.id).order_by(Source.created_at)):
        rows = [(n.detected_kind, n.parent_id) for n in visible if n.source_id == s.id]
        by_kind: dict[str | None, list[str | None]] = {}
        for kind, parent in rows:
            by_kind.setdefault(kind, []).append(parent)
        for kind, parents in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
            if kind is None:
                continue
            # Open the folder that holds this kind when it's one folder, else the source root.
            folder = parents[0] if len(set(parents)) == 1 else s.root_node_id
            node = db.get(SourceNode, folder) if folder else None
            title = node.name if node is not None and node.id != s.root_node_id else (root.name if s.root_node_id and (root := db.get(SourceNode, s.root_node_id)) is not None else s.title)
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


def _version_reviews(db: Session, p: ProjectRow, titles: dict[str, str]) -> list[dict]:
    """Open version review requests, read from the audit log the kernel writes for every
    versioning call (`versioning.review.open`, closed by `versioning.merge`): no call to
    apps/versioning per page view, and it works the same with the service down."""
    rows = list(db.scalars(select(PluginAudit).where(PluginAudit.workspace_id == p.id, PluginAudit.action.in_(("versioning.review.open", "versioning.merge"))).order_by(PluginAudit.id)))
    opened: dict[str, PluginAudit] = {}
    for r in rows:
        rid = str((r.after_ref or {}).get("reviewId") or "") if isinstance(r.after_ref, dict) else ""
        if not rid:
            continue
        if r.action == "versioning.review.open":
            opened[rid] = r
        else:
            opened.pop(rid, None)
    out = []
    for rid, r in opened.items():
        dataset = (r.target or "").removeprefix("dataset:")
        after = r.after_ref or {}
        out.append(
            {
                "id": f"version-review:{rid}",
                "type": "version-review",
                "severity": "medium",
                "title": "A version is waiting for review",
                "detail": f"{titles.get(dataset, dataset)}: {after.get('source') or 'a work branch'} → {after.get('target') or 'main'}",
                "target": {"section": "datasets", "datasetId": dataset, "tab": "versions", "reviewId": rid},
                "datasetId": dataset,
                "createdBy": r.on_behalf_of or r.actor_id,
                "at": projects.iso(r.timestamp),
            }
        )
    return out


QUEUE_TYPES = ("privacy", "import", "quality", "proposal", "version-review", "annotations")


def review_queue(db: Session, p: ProjectRow) -> list[dict]:
    """The project's review queue, most severe first. The Review page shows all of it
    (`filter_queue`); the Overview's "Needs your attention" is its top 5."""
    items: list[dict[str, Any]] = []
    datasets = list(db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id)))
    titles = {d.id: d.title for d in datasets}
    # Privacy holds: always first, one row per held file, tagged with the dataset it's in.
    files = projects.visible_files(db, p.id)
    held = [n for n in files if (pv := (n.flags or {}).get("privacy")) and not pv.get("clearedBy")]
    held_in: dict[str, str] = {}
    if held:
        ids = {n.id for n in held}
        for d in datasets:
            for f, _ in projects.dataset_files(db, d):
                if f.id in ids:
                    held_in.setdefault(f.id, d.id)
    for n in held:
        priv = (n.flags or {}).get("privacy")
        if priv:
            row = {"id": f"privacy:{n.id}", "type": "privacy", "severity": "high", "title": "Held for privacy review", "detail": f"{n.name}: {priv.get('reason') or 'may contain patient identifiers'}", "target": {"section": "sources", "nodeId": n.id}, "at": projects.iso(n.created_at)}
            if n.id in held_in:
                row["datasetId"] = held_in[n.id]
            items.append(row)
    # Imports that failed or only partly arrived.
    for s in db.scalars(select(ImportSession).where(ImportSession.project_id == p.id)):
        failed = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id, UploadFile.state.in_(("failed", "rejected")))))
        if s.state == "failed" or failed:
            n = len(failed)
            title = f"{n} {'file' if n == 1 else 'files'} didn't upload" if n else "An import failed"
            items.append({"id": f"import:{s.id}", "type": "import", "severity": "high", "title": title, "detail": s.error or (failed[0].reason if failed else ""), "target": {"section": "sources", "importId": s.id}, "at": projects.iso(s.started_at)})
    # Files nobody can open yet, as one row.
    signal_of = wfdb_parts([(n.id, n.parent_id, n.name) for n in files])  # WFDB signal files are part of their recording
    unknown = [n for n in files if n.detected_kind == "unknown" and n.id not in signal_of]
    if unknown:
        items.append({"id": "quality:unsupported", "type": "quality", "severity": "low", "title": f"{len(unknown)} {'file' if len(unknown) == 1 else 'files'} we can't read yet", "detail": ", ".join(n.name for n in unknown[:3]), "target": {"section": "sources", "status": "unsupported", "nodeId": unknown[0].id}, "at": projects.iso(unknown[0].created_at)})
    for pr in db.scalars(select(Proposal).where(Proposal.project_id == p.id, Proposal.status == "proposed").order_by(Proposal.created_at)):
        items.append(_proposal_item(pr))
    items.extend(_version_reviews(db, p, titles))
    # Annotation review: assistant or plugin suggestions nobody has accepted yet, per task.
    for t in db.scalars(select(TaskRow).where(TaskRow.project_id == p.id)):
        doc = db.get(AnnotationDocumentRow, (p.id, t.id))
        pending = [a for a in (doc.annotations if doc else []) if a.get("provenance") in ("ai-suggested", "imported") and (a.get("attributes") or {}).get("review_status", "pending") == "pending"]
        if pending:
            n = len(pending)
            items.append({"id": f"annotations:{t.id}", "type": "annotations", "severity": "low", "title": f"{n} {'annotation' if n == 1 else 'annotations'} to review", "detail": t.title, "target": {"section": "studio", "taskId": t.id}, "datasetId": t.dataset_id, "at": projects.iso(doc.saved_at if doc else None)})
    items.sort(key=lambda i: (SEVERITY[i["severity"]], i.get("at") or ""))
    return items


def filter_queue(items: list[dict], type: str | None = None, severity: str | None = None, dataset: str | None = None) -> list[dict]:
    if type:
        items = [i for i in items if i["type"] == type]
    if severity:
        items = [i for i in items if i["severity"] == severity]
    if dataset:
        items = [i for i in items if i.get("datasetId") == dataset]
    return items


def review_facets(db: Session, p: ProjectRow, items: list[dict]) -> dict:
    """Counts for the Review page's filters, from the unfiltered queue."""
    titles = {d.id: d.title for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id))}
    by_ds = Counter(i["datasetId"] for i in items if i.get("datasetId"))
    return {
        "types": dict(Counter(i["type"] for i in items)),
        "severities": dict(Counter(i["severity"] for i in items)),
        "datasets": [{"id": d, "title": titles.get(d, d), "count": n} for d, n in sorted(by_ds.items(), key=lambda kv: (titles.get(kv[0]) or kv[0]).lower())],
    }


# ---- Overview ----------------------------------------------------------------------------------


def overview(db: Session, ctx: RequestContext, p: ProjectRow) -> dict:
    out: dict[str, Any] = {"project": projects.project_dict(db, ctx, p)}
    resume = out["project"]["resume"]
    if resume:
        out["resume"] = resume
    tasks = list(db.scalars(select(TaskRow).where(TaskRow.project_id == p.id).order_by(TaskRow.created_at)))
    out["tasks"] = [{"id": t.id, "title": t.title, "kind": t.kind, "datasetId": t.dataset_id, "state": t.state or "published"} for t in tasks]
    cards = data_cards(db, p)
    if cards:
        out["data"] = cards
    queue = review_queue(db, p)
    if queue:
        out["attention"] = queue[:5]
        out["attentionTotal"] = len(queue)
    out["empty"] = not db.scalar(select(SourceNode.id).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None)).limit(1))
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
    "source.removed": "removed a source",
    "proposal.created": "proposed a change",
    "proposal.confirmed": "confirmed a proposal",
    "proposal.dismissed": "dismissed a proposal",
    "privacy.cleared": "cleared a privacy hold",
    "dataset.created": "created a dataset",
    "dataset.versions_updated": "moved a dataset to newer file versions",
    "dataset.files_added": "added new files to a dataset",
    "files.created": "made a folder",
    "files.renamed": "renamed a file",
    "files.moved": "moved files",
    "files.copied": "copied files",
    "files.trashed": "moved files to the Trash",
    "files.restored": "restored files from the Trash",
    "files.purged": "deleted files forever",
    "files.version_added": "added a new version of a file",
    "files.version_restored": "restored an earlier version of a file",
    "files.changed": "changed files",
    "files.undone": "undid a change to files",
    "files.redone": "redid a change to files",
    "files.downloaded": "downloaded files",
    "privacy.held": "held a file for privacy review again",
    "task.created": "created a task",
    "workspace.environment": "changed the Studio setup",
    "versioning.dataset.create": "turned on versioning",
    "versioning.commit": "committed a version",
    "versioning.revert": "reverted to an earlier version",
    "versioning.branch": "started a branch",
    "versioning.review.open": "asked for a version review",
    "versioning.review.approve": "approved a version review",
    "versioning.review.resolve": "resolved review conflicts",
    "versioning.merge": "merged a version",
    "versioning.release": "released a version",
    "plugins.active": "turned on a plugin",
    "plugins.disabled": "turned off a plugin",
    "plugins.rolled_back": "rolled back a plugin",
}

# Plumbing, not project history: tool calls, jobs, sessions, reads and denials stay in the
# audit log (and its API) but not in the feed.
_QUIET_PREFIXES = ("jobs.", "sessions.", "gateway.", "secrets.", "annotations.commit", "plugins.plan", "plugins.stage", "plugins.validate", "plugins.grant", "plugins.artifact", "plugins.reject")
_QUIET = {"versioning.artifact", "versioning.document", "versioning.checkout", "versioning.denied", "versioning.failed", "versioning.review.check"}
_SMALL_DETAILS = {"workspace.environment"}  # whole environments: the revision entry links to them

PROPOSAL_WORDS = {"relationship": "a link between files", "mapping": "a table mapping", "group": "a group of files", "dataset": "a dataset", "task": "a task"}


def who(actor: str | None, on_behalf_of: str | None = None) -> dict:
    """Who did it, in words: a person, the assistant for a person (SessionDelegation), or
    Inkling itself (the inspection worker, the sample loader)."""
    actor = actor or ""
    kind, _, name = actor.partition(":") if ":" in actor else ("user", "", actor)
    person = (on_behalf_of or "").partition(":")[2] or on_behalf_of or None
    if kind == "agent":
        return {"kind": "assistant", "name": "Assistant", "onBehalfOf": person}
    if kind in ("worker", "system", "plugin", "service"):
        return {"kind": "system", "name": {"worker:inspect": "Inspection", "system:seed": "Sample data"}.get(actor, name or kind), "onBehalfOf": person}
    return {"kind": "person", "name": name or actor or "someone", "onBehalfOf": None}


def activity(db: Session, p: ProjectRow, cursor: int | None = None, limit: int = 100) -> dict:
    """Newest first: the project's audit log (imports, proposals, datasets, tasks, versions,
    plugins) plus Studio setup revisions. `cursor` is the audit id to continue below; setup
    revisions come on the first page only."""
    q = select(PluginAudit).where(PluginAudit.workspace_id == p.id)
    if cursor:
        q = q.where(PluginAudit.id < cursor)
    rows = list(db.scalars(q.order_by(PluginAudit.id.desc()).limit(limit)))
    titles = {d.id: d.title for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id))}
    tasks = {t.id: t.title for t in db.scalars(select(TaskRow).where(TaskRow.project_id == p.id))}
    entries = []
    for r in rows:
        if r.action not in ACTIVITY_LABELS and (r.action.startswith(_QUIET_PREFIXES) or r.action in _QUIET):
            continue
        after = r.after_ref if isinstance(r.after_ref, dict) else {}
        if r.action in _SMALL_DETAILS:
            after = {}
        entries.append(
            {
                "id": f"audit:{r.id}",
                "action": r.action,
                "label": _label(r, after),
                "actor": r.actor_id,
                "onBehalfOf": r.on_behalf_of,
                "who": who(r.actor_id, r.on_behalf_of),
                "target": r.target,
                "subject": _subject(r, after, titles, tasks),
                "details": after,
                "at": projects.iso(r.timestamp),
                "link": _link(r, after),
            }
        )
    if not cursor:
        for e in db.scalars(select(WorkspaceEnvironmentRevision).where(WorkspaceEnvironmentRevision.workspace_id == p.id).order_by(WorkspaceEnvironmentRevision.id.desc()).limit(limit)):
            actor = f"user:{e.author}" if e.author and ":" not in e.author else e.author
            entries.append({"id": f"env:{e.id}", "action": "environment.saved", "label": "set up the Studio" if e.revision == 1 else f"saved Studio setup revision {e.revision}", "actor": actor, "onBehalfOf": None, "who": who(actor), "target": e.task_id, "subject": tasks.get(e.task_id or "", e.task_id), "details": {"revision": e.revision}, "at": projects.iso(e.saved_at), "link": {"section": "studio", "taskId": e.task_id}})
    # Newest first; within the same instant, the later write first (audit ids increase).
    entries.sort(key=lambda e: (e["at"] or "", int(e["id"].split(":")[1]) if e["id"].startswith("audit:") else 0), reverse=True)
    return {"entries": entries[:limit], "nextCursor": str(rows[-1].id) if len(rows) == limit else None}


def _label(r: PluginAudit, after: dict) -> str:
    if r.action.startswith("files.") and r.action != "files.downloaded" and after.get("items") is not None:
        n = int(after.get("items") or 0)
        noun = "item" if n == 1 else "items"
        verb = {"files.created": "made {n} folder" if n == 1 else "made {n} folders", "files.renamed": "renamed {n} " + noun, "files.moved": "moved {n} " + noun, "files.copied": "copied {n} " + noun, "files.trashed": "moved {n} " + noun + " to the Trash", "files.restored": "restored {n} " + noun, "files.purged": "deleted {n} " + noun + " forever"}.get(r.action)
        if verb:
            return verb.format(n=n)
        if r.action in ("files.undone", "files.redone") and after.get("label"):
            return f"{'undid' if r.action == 'files.undone' else 'redid'} {after['label']}"
    if r.action == "import.completed":
        n = int(after.get("files") or 0)
        return f"added {n} {'file' if n == 1 else 'files'}" + (" (some still missing)" if after.get("incomplete") else "")
    if r.action == "import.started":
        n = int(after.get("files") or 0)
        return f"started adding {n} {'file' if n == 1 else 'files'}"
    if r.action.startswith("proposal.") and after.get("kind") in PROPOSAL_WORDS:
        verb = {"proposal.created": "proposed", "proposal.confirmed": "confirmed", "proposal.dismissed": "dismissed"}.get(r.action)
        if verb:
            return f"{verb} {PROPOSAL_WORDS[after['kind']]}"
    return ACTIVITY_LABELS.get(r.action) or r.action.replace(".", " ").replace("_", " ")


def _subject(r: PluginAudit, after: dict, titles: dict[str, str], tasks: dict[str, str]) -> str | None:
    """The thing acted on, by name (never a file path: paths can hold patient identifiers)."""
    t = r.target or ""
    if r.action.startswith("versioning."):
        d = t.removeprefix("dataset:")
        return titles.get(d, d) or None
    if r.action.startswith("dataset."):
        return after.get("title") or titles.get(t)
    if r.action == "task.created":
        return after.get("title") or tasks.get(t)
    if r.action.startswith("project."):
        return after.get("title")
    if r.action.startswith("plugins."):
        return t.split("@")[0] or None
    return None


def _link(r: PluginAudit, after: dict | None = None) -> dict | None:
    a, t = r.action, r.target or ""
    after = after or {}
    if a.startswith("import."):
        return {"section": "sources", "importId": t}
    if a.startswith("proposal."):
        return {"section": "explore", "proposalId": t}
    if a == "dataset.created":
        return {"section": "datasets", "datasetId": t}
    if a == "task.created":
        return {"section": "studio", "taskId": t}
    if a in ("privacy.cleared", "privacy.held"):
        return {"section": "sources", "nodeId": t}
    if a.startswith("files."):
        ids = after.get("nodeIds") or []
        return {"section": "sources", "nodeId": str(ids[0])} if ids else {"section": "sources"}
    if a.startswith("dataset."):
        return {"section": "datasets", "datasetId": t}
    if a.startswith("project."):
        return {"section": "settings"}
    if a.startswith("plugins."):
        return {"section": "settings", "tab": "plugins"}
    if a.startswith("versioning."):
        d = t.removeprefix("dataset:")
        if after.get("reviewId"):
            return {"section": "datasets", "datasetId": d, "tab": "versions", "reviewId": str(after["reviewId"])}
        return {"section": "datasets", "datasetId": d, "tab": "versions"} if d else {"section": "datasets"}
    return None
