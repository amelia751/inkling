"""The kernel's side of inspection (todo6 Phase 5.1): what the worker reads and reports.

The worker (apps/worker `inspect/`) subscribes to `source.uploaded`, reads each committed
file's bytes here with the worker token, stores thumbnails and derived CSVs (an XLSX's first
sheet) as assets of the project, and reports kinds, facts and flags in one call. The report
is applied once: nodes get their detected kind (so they stop being "Checking…"), DICOM series
become `group` proposals, `explore.build_proposals` adds the relationship, label mapping and
dataset proposals, and the session moves to `needs_review` or `ready`.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import blobstore
from ..config import settings
from ..context import RequestContext
from ..models import Asset, ImportSession, ProjectRow, Proposal, SourceNode, UploadFile
from . import assets, audit, derivatives, drops, events, explore, imports, projects

INSPECTOR = "worker:inspect"
KINDS = {"image", "dicom", "volume", "video", "waveform", "slide", "table", "document", "mask", "annotations", "archive", "unknown"}
FLAG_KEYS = {"privacy", "unsupported", "quality", "pair"}
MAX_FACTS_BYTES = 64 * 1024
DERIVED = {"thumbnail": (".png", {"image/png"}), "table-csv": (".csv", {"text/csv"})}
MAX_DERIVED_BYTES = 64 * 1024 * 1024


def service_context(project_id: str) -> RequestContext:
    return RequestContext(project_id, INSPECTOR, uuid.uuid4().hex)


def _session(db: Session, import_id: str) -> ImportSession:
    s = db.get(ImportSession, import_id)
    if s is None:
        raise HTTPException(404, "no such import")
    return s


def import_for_worker(db: Session, import_id: str) -> dict:
    """The files an import committed, for the worker to inspect (ids, paths, sizes). The path
    is the one the file arrived with (`original_path`): the privacy check reads what was
    uploaded; renames re-run it in the kernel (todo7 Phase 7)."""
    s = _session(db, import_id)
    if s.state == "inspecting":
        # todo18 D6: each read is one delivery of the import to an inspector. One that keeps
        # crashing the worker (never reports) is dead-lettered here, kernel side: after
        # `API_INSPECT_MAX_ATTEMPTS` its files are marked unsupported with the reason, and the
        # listing answers a settled state so the worker acks and moves on.
        attempts = int((s.totals or {}).get("inspectAttempts") or 0) + 1
        s.totals = {**(s.totals or {}), "inspectAttempts": attempts}
        if attempts > settings().inspect_max_attempts:
            report(db, s.id, {"nodes": [], "inspector": "kernel"}, unreported_reason=POISON_REASON)
    files = list(db.scalars(select(SourceNode).where(SourceNode.import_session_id == s.id, SourceNode.is_dir.is_(False)).order_by(SourceNode.original_path)))
    uploaded: dict[str, str] = {}
    if (s.totals or {}).get("mode") == "replace":
        # A new version: check the name the new file arrived with, not the first upload's.
        uploaded = {f.node_id: f.rel_path for f in db.scalars(select(UploadFile).where(UploadFile.session_id == s.id)) if f.node_id}
    out = {
        "importId": s.id,
        "projectId": s.project_id,
        "sourceId": s.source_id,
        "state": s.state,
        "files": [{"nodeId": n.id, "relPath": uploaded.get(n.id) or n.original_path or n.name, "name": n.name, "size": n.size, "sha256": n.sha256} for n in files],
    }
    if any(TABLE_EXT.search(n.name or "") for n in files):
        known = _dataset_names(db, s)
        if known:
            out["knownNames"] = known
    return out


POISON_REASON = "Checking this file kept failing, so it was set aside. It may be damaged or in a format we can't read yet"

TABLE_EXT = re.compile(r"\.(csv|tsv|xlsx|parquet)$", re.IGNORECASE)
MAX_KNOWN_NAMES = 20_000


def _dataset_names(db: Session, s: ImportSession) -> list[str]:
    """todo13 §3.3: a table dropped into a dataset may be keyed by the names of files already in
    it, not only by names in the same drop. The worker (in the same project, inside the
    perimeter) gets the file names of the drop's dataset so its name-column check sees them;
    nothing leaves the worker but the count of matching columns."""
    from ..models import DatasetRow, Drop, TaskRow

    drop_id = s.drop_id or (s.totals or {}).get("dropId")
    d = db.get(Drop, drop_id) if drop_id else None
    if d is None and drop_id and "-u" in str(drop_id):
        d = db.get(Drop, str(drop_id).split("-u")[0])
    if d is None:
        return []
    dataset_id = d.dataset_id
    if not dataset_id and d.task_id:
        t = db.get(TaskRow, d.task_id)
        dataset_id = t.dataset_id if t is not None else None
    ds = db.get(DatasetRow, dataset_id) if dataset_id else None
    if ds is None or ds.project_id != s.project_id:
        return []
    ids = [str(r.get("nodeId")) for r in (ds.definition or {}).get("files") or [] if isinstance(r, dict) and r.get("nodeId")][:MAX_KNOWN_NAMES]
    names: list[str] = []
    for i in range(0, len(ids), 500):
        names += [n for (n,) in db.execute(select(SourceNode.name).where(SourceNode.id.in_(ids[i : i + 500]))) if n]
    return names


def node_asset(db: Session, node_id: str) -> tuple[SourceNode, Asset]:
    n = db.get(SourceNode, node_id)
    if n is None or n.is_dir or n.asset_id is None:
        raise HTTPException(404, "no such file")
    a = db.get(Asset, n.asset_id)
    if a is None:
        raise HTTPException(404, "the file's bytes are missing")
    return n, a


def put_derived(db: Session, node_id: str, role: str, data: bytes, media_type: str) -> dict:
    """A thumbnail or derived CSV for a node, content-addressed under the project's uploads."""
    if role not in DERIVED:
        raise HTTPException(422, f"role is one of {sorted(DERIVED)}")
    ext, types = DERIVED[role]
    if media_type.split(";")[0].strip() not in types:
        raise HTTPException(415, f"{role} must be {' or '.join(sorted(types))}")
    if not data or len(data) > MAX_DERIVED_BYTES:
        raise HTTPException(413, "derived files are 1 byte to 64 MB")
    n = db.get(SourceNode, node_id)
    if n is None:
        raise HTTPException(404, "no such file")
    key = f"{assets.UPLOAD_PREFIX}{n.project_id}/derived/{hashlib.sha256(data).hexdigest()}{ext}"
    store = blobstore.data()
    if store.stat(key) is None:
        store.put(key, data, media_type)
    if db.scalar(select(Asset.id).where(Asset.workspace_id == n.project_id, Asset.path == key)) is None:
        db.add(Asset(workspace_id=n.project_id, path=key, media_type=media_type, role=role, size=len(data)))
        db.flush()
    return {"path": key}


def _clean_flags(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, v in raw.items():
        if k not in FLAG_KEYS:
            continue
        if k == "quality":
            if isinstance(v, list):
                out[k] = [str(x)[:300] for x in v[:20]]
        elif k == "privacy":
            if isinstance(v, dict) and v.get("reason"):
                out[k] = {kk: vv for kk, vv in v.items() if kk in ("reason", "source", "findings", "fields", "checker")}
        elif v:
            out[k] = str(v)[:300]
    return out


def report(db: Session, import_id: str, body: dict, *, unreported_reason: str = "We couldn't check this file") -> dict:
    """Apply the worker's findings once; a report for a session that already left `inspecting`
    answers 409 (the worker acks the event and moves on)."""
    s = _session(db, import_id)
    if s.state != "inspecting":
        raise HTTPException(409, f"this import is {s.state}")
    p = db.get(ProjectRow, s.project_id)
    assert p is not None
    ctx = service_context(p.id)
    nodes = {n.id: n for n in db.scalars(select(SourceNode).where(SourceNode.import_session_id == s.id, SourceNode.is_dir.is_(False)))}
    raw_nodes = body.get("nodes")
    reported: list = raw_nodes if isinstance(raw_nodes, list) else []
    updated: list[str] = []
    for r in reported:
        if not isinstance(r, dict) or r.get("nodeId") not in nodes:
            continue
        n = nodes[r["nodeId"]]
        kind = r.get("detectedKind")
        n.detected_kind = kind if kind in KINDS else "unknown"
        raw_facts = r.get("facts")
        facts: dict = raw_facts if isinstance(raw_facts, dict) else {}
        if len(json.dumps(facts, default=str)) > MAX_FACTS_BYTES:
            facts = {k: v for k, v in facts.items() if k in ("format", "width", "height", "frames", "dicom", "series", "thumbnail")} | {"truncated": True}
        n.facts = {**(n.facts or {}), **facts, "inspector": str(body.get("inspector") or "worker")[:64]}
        flags = dict(n.flags or {})
        for k, v in _clean_flags(r.get("flags")).items():
            if k == "privacy" and flags.get("privacy"):
                continue  # never overwrite a hold (or a person's clearance) already on the node
            flags[k] = v
        n.flags = flags
        need = facts.get("derivative") if isinstance(facts.get("derivative"), dict) else None
        if need and need.get("kind"):
            derivatives.request(db, n, str(need["kind"]))  # todo18 D4: the worker converts it
        updated.append(n.id)
    # Files the worker didn't report (it crashed on them, or they arrived after it read the list).
    for nid, n in nodes.items():
        if n.detected_kind is None and nid not in updated:
            n.detected_kind = "unknown"
            n.flags = {**(n.flags or {}), "unsupported": unreported_reason}
    db.flush()
    created: list[Proposal] = []
    raw_groups = body.get("groups")
    for g in raw_groups if isinstance(raw_groups, list) else []:
        if not isinstance(g, dict):
            continue
        ids = [i for i in g.get("nodeIds") or [] if i in nodes]
        if not ids:
            continue
        payload = {
            "summary": str(g.get("summary") or f"{len(ids)} DICOM files form 1 series")[:300],
            "type": "dicom-series",
            "nodeIds": ids,
            **{k: g.get(k) for k in ("seriesUidHash", "studyUidHash", "modality", "modalityLabel", "seriesDescription", "rows", "columns", "spacing", "sliceCount")},
        }
        quality = [str(q)[:300] for q in g.get("quality") or []][:10]
        evidence = {"files": len(ids), "quality": quality, "missingInstances": (g.get("missingInstances") or [])[:200], "duplicateInstances": (g.get("duplicateInstances") or [])[:200], "orientationConsistent": bool(g.get("orientationConsistent", True)), "summary": payload["summary"]}
        created.append(projects.create_proposal(db, ctx, p, "group", payload, evidence, "possible" if quality else "strong", INSPECTOR, import_session_id=s.id))
    if (s.totals or {}).get("mode") != "replace":  # a new version of one file proposes nothing new
        created += explore.build_proposals(db, ctx, p, s)
    flagged = any((n.flags or {}).get(k) for n in nodes.values() for k in FLAG_KEYS)
    needs = flagged or any(pr.kind != "dataset" for pr in created)
    imports.finish_inspection(db, s, needs)
    db.flush()
    audit.record(db, ctx, "import.inspected", target=s.id, after={"files": len(updated), "proposals": [pr.id for pr in created], "state": s.state})
    if updated:
        events.publish(db, ctx, "source.node.inspected", {"projectId": p.id, "nodeIds": updated[:1000]}, source="kernel")
    if s.drop_id:
        drops.session_inspected(db, ctx, s, list(nodes))
    events.publish(db, ctx, "import.updated", {"projectId": p.id, "importId": s.id, "state": s.state}, source="kernel")
    # todo13 M2: a drop is classified (and maybe applied) once its last session is inspected.
    from . import drops_plan

    drops_plan.after_inspection(db, s)
    return {"state": s.state, "inspected": len(updated), "proposals": [pr.id for pr in created]}
