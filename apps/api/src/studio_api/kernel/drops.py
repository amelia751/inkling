"""Drops (todo13 D2, §5 "Drop"): one gesture of files dropped, pasted or attached.

A drop is created before any byte moves (`POST /v1/projects/:id/drops`), so the chat can show
its card at once and the message can reference it (`SendMessageRequest.drop`). The browser then
uploads through the normal import route with `origin: {kind, conversationId, messageId, dropId}`;
every session of the gesture carries `drop_id`. Chat drops land in
`Shared in chat/<conversation>` (one folder per conversation, `Source.kind = chat`).

What the agent reads of a drop is a `DropSummary` (D3): counts by kind and state, groups, and
per file its node id, its screened name (`name_screen`), its kind and technical facts only.
People read the full drop (names, upload states, reasons) for the card and Shared files.

Events (project stream): `drop.received`, `drop.file`, `drop.failed`; `drop.classified`,
`drop.planned` and `drop.applied` belong to the classifier (todo13-organize). Each transition
also logs one JSON line (`drop.*`, no names) for the log-based metrics (§7.3).
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import Drop, ImportSession, ProjectRow, SourceNode, UploadFile, now
from . import events, features, fs, name_screen, projects, tree
from .kinds import VIEWABLE, kind_from_extension

log = logging.getLogger("studio_api.drops")

ORIGINS = ("chat", "files", "studio", "home")
SHARED_FOLDER = "Shared in chat"
DELETED_SUFFIX = " (deleted chat)"
ID_RE = re.compile(r"^drp-[a-z0-9]{8,40}$")
CONV_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
SUMMARY_FILES = 50
# Technical facts an agent may see (D3): never text content, cell values or raw DICOM headers.
TECHNICAL_FACTS = ("format", "width", "height", "frames", "fps", "duration", "modality", "columns", "rows", "pages", "channels", "sampleRate", "sample_rate", "dims", "spacing", "sliceCount", "bitDepth", "signals", "leads")
KEPT_KINDS = {"document", "table", "archive", "annotations", "unknown"}


def enabled() -> bool:
    return features.enabled("chat_drops")


def require_enabled() -> None:
    """Inside kernel code paths (an import with a drop origin); routes use `features.require`."""
    if not enabled():
        raise HTTPException(404, "Not Found")


def _log(d: Drop, event: str, **extra) -> None:
    elapsed = int((now() - _aware(d.created_at)).total_seconds() * 1000) if d.created_at else 0
    log.info(event, extra={"event": event, "dropId": d.id, "state": d.state, "origin": d.origin, "elapsed_ms": elapsed, **extra})


STUCK_AFTER = timedelta(minutes=10)


def log_stuck(db: Session, at: datetime | None = None) -> int:
    """`drop.stuck` for every drop still `inspecting` 10 minutes after its last change (§7.3's
    alert). Run by the api's housekeeping about once a minute on every replica: a stuck drop
    logs once per pass, which the "any in 5 minutes" alert tolerates. Drops older than a day
    are left out (they're failures to look at, not pages)."""
    at = at or now()
    n = 0
    for d in db.scalars(select(Drop).where(Drop.state == "inspecting", Drop.updated_at < at - STUCK_AFTER, Drop.updated_at > at - timedelta(days=1)).limit(200)):
        stuck = int((at - _aware(d.updated_at)).total_seconds() * 1000)
        elapsed = int((at - _aware(d.created_at)).total_seconds() * 1000) if d.created_at else stuck
        log.warning("drop.stuck", extra={"event": "drop.stuck", "dropId": d.id, "state": d.state, "origin": d.origin, "elapsed_ms": elapsed, "stuck_ms": stuck})
        n += 1
    return n


def _aware(t: datetime) -> datetime:
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _publish(db: Session, ctx: RequestContext, d: Drop, type_: str, payload: dict) -> None:
    events.publish(db, ctx.for_scope(d.project_id, None), type_, {"projectId": d.project_id, "dropId": d.id, **payload}, source="kernel")


# ---- Create --------------------------------------------------------------------------------


def create(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> dict:
    """A new drop (or the same one again: the browser may retry with its `id`)."""
    if ctx.scopes:
        raise HTTPException(403, "only people add data to a project")
    origin = body.get("origin") or "chat"
    if origin not in ORIGINS:
        raise HTTPException(422, f"origin must be one of {', '.join(ORIGINS)}")
    asked = body.get("id")
    if asked is not None:
        if not isinstance(asked, str) or not ID_RE.fullmatch(asked):
            raise HTTPException(422, "id must look like drp-<letters and digits>")
        prior = db.get(Drop, asked)
        if prior is not None:
            if prior.project_id != p.id or prior.created_by != projects.person(ctx):
                raise HTTPException(409, "that drop id is taken")
            return person_view(db, prior)
    conv = body.get("conversationId")
    if conv is not None and (not isinstance(conv, str) or not CONV_RE.fullmatch(conv)):
        raise HTTPException(422, "conversationId must be an id")
    if origin == "chat" and not conv:
        raise HTTPException(422, "a chat drop needs its conversationId")
    msg = body.get("messageId")
    if msg is not None and (not isinstance(msg, str) or not CONV_RE.fullmatch(msg)):
        raise HTTPException(422, "messageId must be an id")
    task_id = body.get("taskId")
    if task_id is not None:
        from . import ingest

        ingest.require_task_for_drop(db, p.id, task_id)
    files, size = body.get("files"), body.get("bytes")
    if files is not None and (not isinstance(files, int) or files < 0):
        raise HTTPException(422, "files must be a count")
    if size is not None and (not isinstance(size, int) or size < 0):
        raise HTTPException(422, "bytes must be a size")
    check_limits(files or 0, size or 0)
    _rate_limit(db, projects.person(ctx))
    title = str(body.get("conversationTitle") or "").strip()[:120]
    d = Drop(
        id=asked or f"drp-{uuid.uuid4().hex[:24]}",
        project_id=p.id,
        origin=origin,
        conversation_id=conv,
        message_id=msg,
        task_id=str(task_id) if task_id else None,
        dataset_id=str(body["datasetId"])[:128] if body.get("datasetId") else None,
        state="uploading",
        declared={"files": files or 0, "bytes": size or 0, **({"conversationTitle": title} if title else {})},
        removed=[],
        created_by=projects.person(ctx),
    )
    db.add(d)
    db.flush()
    _publish(db, ctx, d, "drop.received", {"origin": d.origin, "count": files or 0})
    _log(d, "drop.received", count=files or 0)
    return person_view(db, d)


def check_limits(files: int, size: int) -> None:
    s = settings()
    if files > s.drop_max_files or size > s.drop_max_bytes:
        what = f"{s.drop_max_files:,} files" if files > s.drop_max_files else f"{_human(s.drop_max_bytes)}"
        raise HTTPException(413, f"A chat drop holds at most {what}. Use Add folder in Sources for bigger uploads.")


def _rate_limit(db: Session, who: str) -> None:
    limit = settings().drop_rate_per_minute
    since = now() - timedelta(minutes=1)
    rows = list(db.scalars(select(Drop.created_at).where(Drop.created_by == who, Drop.created_at >= since).order_by(Drop.created_at)))
    if limit > 0 and len(rows) >= limit:
        retry = max(1, int(60 - (now() - _aware(rows[0])).total_seconds()) + 1)
        raise HTTPException(429, f"Too many drops: wait {retry} s", headers={"Retry-After": str(retry)})


def _human(n: int) -> str:
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n} {unit}" if unit == "bytes" else f"{n:.0f} {unit}"
        n //= 1024  # type: ignore[assignment]
    return str(n)


def require(db: Session, ctx: RequestContext, drop_id: str, *, write: bool = False) -> tuple[Drop, ProjectRow]:
    d = db.get(Drop, drop_id) if isinstance(drop_id, str) and ID_RE.fullmatch(drop_id) else None
    if d is None:
        raise HTTPException(404, "no such drop")
    return d, projects.require_project(db, ctx, d.project_id, write=write)


# ---- Imports (kernel/imports.py calls these) ------------------------------------------------


def for_import(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> Drop | None:
    """The drop an import session joins, from `origin` / `dropId`. A chat origin without a
    `dropId` makes a drop (older clients); a `files` origin without one is a plain import."""
    origin = body.get("origin")
    drop_id = body.get("dropId") or (origin.get("dropId") if isinstance(origin, dict) else None)
    if origin is None and drop_id is None:
        return None
    require_enabled()
    if origin is not None and not isinstance(origin, dict):
        raise HTTPException(422, "origin must be {kind, conversationId?, messageId?}")
    kind = (origin or {}).get("kind")
    if drop_id is not None:
        d = db.get(Drop, drop_id) if isinstance(drop_id, str) else None
        if d is None or d.project_id != p.id or d.created_by != projects.person(ctx):
            raise HTTPException(422, "dropId must be a drop of yours in this project")
        if kind is not None and kind != d.origin:
            raise HTTPException(422, "origin.kind doesn't match the drop")
        return d
    if kind not in ORIGINS:
        raise HTTPException(422, f"origin.kind must be one of {', '.join(ORIGINS)}")
    out = create(db, ctx, p, {"origin": kind, **{k: v for k, v in (origin or {}).items() if k in ("conversationId", "messageId", "conversationTitle")}, **({"taskId": body["taskId"]} if body.get("taskId") else {})})
    d = db.get(Drop, out["id"])
    assert d is not None
    return d


def shared_in_chat(d: Drop) -> bool:
    """A drop shared in a conversation: the composer's, and Home's (D1 delivers it into the new
    project's conversation). Both land in `Shared in chat` and are `Source.kind = chat`."""
    return d.origin in ("chat", "home") and bool(d.conversation_id)


def landing_folder(db: Session, p: ProjectRow, d: Drop, forbidden: str = "") -> SourceNode | None:
    """`Shared in chat/<conversation>` for a drop shared in a conversation (made on first use);
    None otherwise. Characters in `forbidden` (the project's layout rules) become `_` in a new
    folder's name, or every file below it would fail layout.forbidden-char."""
    if not shared_in_chat(d):
        return None
    if d.folder_node_id:
        n = db.get(SourceNode, d.folder_node_id)
        if n is not None and not tree.is_hidden(db, n):
            return n
    # The conversation's folder from an earlier drop, while it's still in Files.
    for (fid,) in db.execute(select(Drop.folder_node_id).where(Drop.project_id == p.id, Drop.conversation_id == d.conversation_id, Drop.folder_node_id.is_not(None)).order_by(Drop.created_at.desc()).limit(5)):
        n = db.get(SourceNode, fid)
        if n is not None and not tree.is_hidden(db, n):
            d.folder_node_id = n.id
            return n
    drive = fs.ensure_drive(db, p)
    shared = fs.sibling(db, drive.id, SHARED_FOLDER)
    if shared is None or not shared.is_dir:
        shared = _mkdir(db, p, drive, SHARED_FOLDER)
    title = d.declared.get("conversationTitle") if isinstance(d.declared, dict) else None
    name = fs.clean_name(title) if title and title.strip(" .") else f"Chat {now():%b %-d, %H.%M}"
    if forbidden:
        name = "".join("_" if c in forbidden and c != "/" else c for c in name)
    folder = _mkdir(db, p, shared, name)
    d.folder_node_id = folder.id
    db.flush()
    return folder


def _mkdir(db: Session, p: ProjectRow, parent: SourceNode, name: str) -> SourceNode:
    name = tree.free_name(name, fs.taken_names(db, parent.id), is_dir=True)
    nid = tree.new_node_id()
    db.add(SourceNode(**tree._row(id=nid, source_id=None, project_id=p.id, project_root=parent.project_root or parent.id, parent_id=parent.id, name=name, original_path="", is_dir=True, created_at=now())))
    db.flush()
    tree.bump(db, parent.id, 0, 0, children=1)
    n = db.get(SourceNode, nid)
    assert n is not None
    return n


def session_started(db: Session, ctx: RequestContext, d: Drop, s: ImportSession) -> None:
    """A session joined the drop: the drop's totals must stay within the limits (413 rolls the
    session back with the request)."""
    s.drop_id = d.id
    db.flush()
    check_limits(_count(db, d), _bytes(db, d))
    d.updated_at = now()
    if d.state in ("failed", "ready", "partly_ready", "duplicate"):
        # Another session of the gesture (a retry, the rest of a big drop): it's open again.
        d.state = "uploading"
        d.declared = {k: v for k, v in (d.declared or {}).items() if k != "failure"}
    _log(d, "drop.session", importId=s.id)


def _sessions(db: Session, d: Drop) -> list[ImportSession]:
    return list(db.scalars(select(ImportSession).where(ImportSession.drop_id == d.id).order_by(ImportSession.started_at)))


def _count(db: Session, d: Drop) -> int:
    return int(db.scalar(select(func.count()).select_from(UploadFile).join(ImportSession, ImportSession.id == UploadFile.session_id).where(ImportSession.drop_id == d.id)) or 0)


def _bytes(db: Session, d: Drop) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(UploadFile.size), 0)).join(ImportSession, ImportSession.id == UploadFile.session_id).where(ImportSession.drop_id == d.id)) or 0)


def session_completed(db: Session, ctx: RequestContext, s: ImportSession, node_ids: list[str]) -> None:
    d = db.get(Drop, s.drop_id) if s.drop_id else None
    if d is None:
        return
    # Screen the new names before any agent can read them (D3): one call now, the rest by the backfill.
    name_screen.screen_pending(db, d.project_id)
    if node_ids:
        if d.state == "uploading":
            d.state = "inspecting"
        for nid in node_ids[:1000]:
            _publish(db, ctx, d, "drop.file", {"nodeId": nid, "state": "checking"})
    elif all(x.state in ("failed", "cancelled") for x in _sessions(db, d)):
        d.state = "failed"
        _fail_reason(d, "upload", "No file finished uploading")
        _publish(db, ctx, d, "drop.failed", {"step": "upload", "errorClass": "no_file_uploaded"})
        _log(d, "drop.failed", step="upload")
    d.updated_at = now()
    _log(d, "drop.uploaded", committed=len(node_ids))
    settle(db, ctx, d)


def session_cancelled(db: Session, ctx: RequestContext, s: ImportSession) -> None:
    d = db.get(Drop, s.drop_id) if s.drop_id else None
    if d is None:
        return
    if all(x.state in ("failed", "cancelled") for x in _sessions(db, d)) and not db.scalar(select(SourceNode.id).where(SourceNode.import_session_id.in_([x.id for x in _sessions(db, d)])).limit(1)):
        d.state = "failed"
        _fail_reason(d, "upload", "Cancelled")
        _publish(db, ctx, d, "drop.failed", {"step": "upload", "errorClass": "cancelled"})
        _log(d, "drop.failed", step="upload", errorClass="cancelled")
    settle(db, ctx, d)


def session_inspected(db: Session, ctx: RequestContext, s: ImportSession, node_ids: list[str]) -> None:
    d = db.get(Drop, s.drop_id) if s.drop_id else None
    if d is None:
        return
    for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(node_ids[:1000]))):
        _publish(db, ctx, d, "drop.file", {"nodeId": n.id, "state": _node_state(n, d)})
    d.updated_at = now()
    _log(d, "drop.inspected", files=len(node_ids))
    settle(db, ctx, d)


# ---- Settling and findings (todo20 D8) ------------------------------------------------------
#
# A drop always ends in a state: once every session of it has ended (ready, needs review,
# failed, cancelled) a drop still `uploading` or `inspecting` becomes `ready`, `partly_ready`
# (some files failed), `duplicate` (every file was already here) or `failed`. The classifier
# (drops_plan) may move it on to `planned` / `applied` afterwards.

OPEN_SESSION_STATES = ("uploading", "inspecting")
SETTLED = ("ready", "partly_ready", "duplicate", "failed", "classified", "planned", "applied")
FINDING_SAMPLE = 5


def _fail_reason(d: Drop, step: str, reason: str) -> None:
    d.declared = {**(d.declared or {}), "failure": {"step": step, "reason": reason[:300]}}


def settle(db: Session, ctx: RequestContext | None, d: Drop) -> str:
    """Move a drop whose sessions all ended out of `uploading` / `inspecting`. Idempotent."""
    if d.state not in OPEN_SESSION_STATES:
        return d.state
    sessions = _sessions(db, d)
    if not sessions or any(s.state in OPEN_SESSION_STATES for s in sessions):
        return d.state
    good = failed = dup = 0
    for s, f, n in _rows(db, d):
        st = _file_state(s, f, n, d)
        if st in ("removed", "deleted"):
            continue
        if st == "failed" or st == "uploading" or (st == "checking" and s.state == "failed"):
            failed += 1
        elif st == "duplicate":
            dup += 1
        else:
            good += 1
    if good == 0 and failed == 0 and dup > 0:
        d.state = "duplicate"
    elif good == 0:
        d.state = "failed"
        if not (d.declared or {}).get("failure"):
            reason = next((s.error for s in sessions if s.error), None) or "No file could be added"
            _fail_reason(d, "upload", reason)
    else:
        d.state = "partly_ready" if failed else "ready"
    d.updated_at = now()
    if ctx is None:
        ctx = RequestContext(d.project_id, "service:drops", f"settle-{d.id}")
    if d.state == "failed":
        _publish(db, ctx, d, "drop.failed", {"step": "upload", "errorClass": "nothing_added"})
    # Otherwise the session's own `import.updated` tells clients to read the drop again.
    _log(d, "drop.settled", ready=good, failed=failed, duplicate=dup)
    return d.state


def session_ended(db: Session, s: ImportSession) -> None:
    """A session ended outside a request about its drop (housekeeping's stall check)."""
    d = db.get(Drop, s.drop_id) if s.drop_id else None
    if d is not None:
        settle(db, None, d)


def _outcome(f: dict, refused: bool) -> str:
    if f.get("renamedTo"):
        return "renamed"
    if refused and f.get("severity") == "error" and not f.get("evaluate"):
        return "refused"
    return "reported"


_OUTCOME_WORDS = {"renamed": "renamed automatically", "refused": "refused", "reported": "reported"}


def group_findings(findings: list[dict], *, refused: bool = False) -> list[dict]:
    """Per-file findings grouped by rule and outcome, never one line per file:
    `{rule, severity, outcome, message, count, files, renamedTo?, headline}`. `files` and
    `renamedTo` (`[{from, to}]`) are samples of at most FINDING_SAMPLE; `count` is the total."""
    out: dict[tuple[str, str], dict] = {}
    for f in findings:
        outcome = _outcome(f, refused)
        key = (str(f.get("rule") or "unknown"), outcome)
        g = out.get(key)
        if g is None:
            g = out[key] = {"rule": key[0], "severity": f.get("severity") or "info", "outcome": outcome, "message": f.get("message") or "", "count": 0, "files": []}
        g["count"] += 1
        file = f.get("file")
        if file and len(g["files"]) < FINDING_SAMPLE:
            g["files"].append(file)
        if f.get("renamedTo"):
            ren = g.setdefault("renamedTo", [])
            if len(ren) < FINDING_SAMPLE:
                ren.append({"from": file, "to": f["renamedTo"]})
    for g in out.values():
        _headline(g)
    return list(out.values())


def _headline(g: dict) -> None:
    n = g["count"]
    what = g["message"].rstrip(".") or g["rule"]
    g["headline"] = f"{n} file{'s' if n != 1 else ''}: {what[:1].lower() + what[1:]}, {_OUTCOME_WORDS.get(g['outcome'], g['outcome'])}"


def merge_findings(a: list[dict], b: list[dict]) -> list[dict]:
    by = {(g["rule"], g["outcome"]): {**g, "files": list(g.get("files") or [])} for g in a}
    for g in b:
        k = (g["rule"], g["outcome"])
        if k not in by:
            by[k] = {**g, "files": list(g.get("files") or [])}
            continue
        m = by[k]
        m["count"] += g["count"]
        m["files"] = (m["files"] + list(g.get("files") or []))[:FINDING_SAMPLE]
        if g.get("renamedTo"):
            m["renamedTo"] = (list(m.get("renamedTo") or []) + g["renamedTo"])[:FINDING_SAMPLE]
        _headline(m)
    return list(by.values())


def add_findings(d: Drop, grouped: list[dict]) -> None:
    if grouped:
        d.declared = {**(d.declared or {}), "findings": merge_findings(list((d.declared or {}).get("findings") or []), grouped)}


def import_rejected(db: Session, ctx: RequestContext, drop_id: str, grouped: list[dict], title: str) -> None:
    """A refused import (422 from the project's rules): its drop fails at once with the grouped
    findings, unless an earlier session of the drop added files (then it settles as usual).
    The caller has rolled the request back and commits after."""
    d = db.get(Drop, drop_id) if isinstance(drop_id, str) else None
    if d is None:
        return
    add_findings(d, grouped)
    if _sessions(db, d):
        settle(db, ctx, d)
    else:
        d.state = "failed"
        _fail_reason(d, "import", title)
        d.updated_at = now()
        _publish(db, ctx, d, "drop.failed", {"step": "import", "errorClass": "rejected"})
        _log(d, "drop.failed", step="import", errorClass="rejected")


# ---- Views ----------------------------------------------------------------------------------


def _node_state(n: SourceNode | None, d: Drop) -> str:
    if n is None or n.trashed_at is not None:
        return "deleted"
    if n.id in (d.removed or []):
        return "removed"
    if n.detected_kind is None:
        return "checking"
    flags = n.flags or {}
    if flags.get("unsupported") or n.detected_kind in KEPT_KINDS or n.detected_kind not in VIEWABLE:
        return "kept"
    return "ready"


def _looks_like(name: str, detected: str | None) -> str | None:
    """A `.png` that's a ZIP (D14): the extension and the detected kind disagree."""
    if not detected or detected in ("unknown",):
        return None
    by_ext = kind_from_extension(name)
    if by_ext == "unknown" or by_ext == detected or {by_ext, detected} <= {"dicom", "dicom-series"} or {by_ext, detected} <= {"volume", "mask"}:
        return None
    return {"archive": "a ZIP", "image": "an image", "dicom": "DICOM", "video": "a video", "table": "a table", "document": "a document", "volume": "a volume", "waveform": "a waveform", "slide": "a slide"}.get(detected, detected)


def _rows(db: Session, d: Drop) -> list[tuple[ImportSession, UploadFile, SourceNode | None]]:
    out = []
    for s in _sessions(db, d):
        files = list(db.scalars(select(UploadFile).where(UploadFile.session_id == s.id)))
        ids = [f.node_id for f in files if f.node_id]
        nodes = {n.id: n for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(ids)))} if ids else {}
        for f in sorted(files, key=lambda f: tree.natural_key(f.rel_path)):
            out.append((s, f, nodes.get(f.node_id) if f.node_id else None))
    return out


def _file_state(s: ImportSession, f: UploadFile, n: SourceNode | None, d: Drop) -> str:
    if f.node_id:
        return _node_state(n, d)
    if f.state == "skipped_duplicate":
        return "duplicate"
    if f.state in ("failed", "rejected"):
        return "failed"
    if s.state == "cancelled":
        return "failed"
    return "uploading"


def person_view(db: Session, d: Drop) -> dict:
    files = []
    for s, f, n in _rows(db, d):
        state = _file_state(s, f, n, d)
        reason = f.reason
        if f.state == "uploaded" and (reason or "").startswith("Same file as"):
            reason = "Already in Sources"
        if f.state == "skipped_duplicate":
            reason = "Already in Sources"
        files.append(
            {
                "clientFileId": f.client_file_id,
                "importId": s.id,
                "nodeId": f.node_id,
                "name": n.name if n is not None else f.rel_path.rsplit("/", 1)[-1],
                "relPath": f.rel_path,
                "size": f.size,
                "received": f.received,
                "sha256": f.sha256,
                "uploadState": f.state,
                "state": state,
                "reason": reason,
                "kind": n.detected_kind if n is not None else None,
                "looksLike": _looks_like(n.name, n.detected_kind) if n is not None else None,
                "flags": sorted(k for k, v in (n.flags or {}).items() if v) if n is not None else [],
            }
        )
    return {
        "id": d.id,
        "projectId": d.project_id,
        "origin": d.origin,
        "conversationId": d.conversation_id,
        "messageId": d.message_id,
        "taskId": d.task_id,
        "datasetId": d.dataset_id,
        "folderNodeId": d.folder_node_id,
        "state": d.state,
        "declared": d.declared or {},
        "createdBy": d.created_by,
        "createdAt": projects.iso(d.created_at),
        "updatedAt": projects.iso(d.updated_at),
        "importIds": [s.id for s in _sessions(db, d)],
        "files": files,
        "findings": list((d.declared or {}).get("findings") or []),
        **({"failure": (d.declared or {})["failure"]} if (d.declared or {}).get("failure") else {}),
        "summary": summary(db, d),
    }


def summary(db: Session, d: Drop, offset: int = 0, limit: int = SUMMARY_FILES) -> dict:
    """The `DropSummary` (D3): ids, screened names, kinds and technical facts; never names."""
    rows = _rows(db, d)
    by_kind: dict[str, int] = {}
    states: dict[str, int] = {}
    total_bytes = 0
    visible: list[tuple[UploadFile, SourceNode]] = []
    for s, f, n in rows:
        st = _file_state(s, f, n, d)
        if st == "removed":
            continue
        states[st] = states.get(st, 0) + 1
        total_bytes += f.size or 0
        kind = (n.detected_kind if n is not None else None) or "pending"
        by_kind[kind] = by_kind.get(kind, 0) + 1
        if n is not None and st not in ("deleted",):
            visible.append((f, n))
    files = []
    for _f, n in visible[offset : offset + limit]:
        facts = {k: v for k, v in (n.facts or {}).items() if k in TECHNICAL_FACTS and isinstance(v, (int, float, str, list, dict))}
        cols = facts.get("columns")
        if isinstance(cols, list):
            facts["columns"] = [{"name": c.get("name"), "type": c.get("type")} if isinstance(c, dict) else c for c in cols][:200]
        files.append({"nodeId": n.id, "agentName": name_screen.agent_name(n), **({"kind": n.detected_kind} if n.detected_kind else {}), **({"facts": facts} if facts else {})})
    total = sum(states.values())
    out = {
        "dropId": d.id,
        "origin": d.origin,
        "state": d.state,
        "total": total,
        # todo20 D8: the files the browser declared, so "still uploading (12 of 35)" can be said.
        "expected": int((d.declared or {}).get("files") or 0),
        "byKind": by_kind,
        "bytes": total_bytes,
        "states": states,
        "groups": classified_groups(db, d.id) or groups(visible),
        "files": files,
    }
    # todo20 D8: grouped findings carry no file names (the agent sees counts and rules only).
    found = (d.declared or {}).get("findings") or []
    if found:
        out["findings"] = [{k: g[k] for k in ("rule", "severity", "outcome", "message", "count") if k in g} for g in found]
    if (d.declared or {}).get("failure"):
        out["failure"] = (d.declared or {})["failure"]
    if offset + limit < len(visible):
        out["nextOffset"] = offset + limit
    return out


def classified_groups(db, drop_id: str) -> list[dict] | None:
    """The classifier's groups (todo13-organize, `drop_plans.groups`) once the drop is classified,
    without node ids (the summary lists files separately)."""
    from ..models import DropPlanRow

    row = db.get(DropPlanRow, drop_id)
    if row is None or not row.groups:
        return None
    return [{k: v for k, v in g.items() if k != "nodeIds"} for g in row.groups]


def groups(visible: list[tuple[UploadFile, SourceNode]]) -> list[dict]:
    """A first grouping by detected kind (and image shape). The classifier (todo13-organize)
    replaces this with the §3.3 rules and real actions; until then `suggestedAction` is the
    plain default for the kind."""
    by: dict[str, list[SourceNode]] = {}
    for _f, n in visible:
        if n.detected_kind:
            by.setdefault(n.detected_kind, []).append(n)
    out = []
    for kind, nodes in sorted(by.items()):
        shapes: dict[str, int] = {}
        for n in nodes:
            w, h = (n.facts or {}).get("width"), (n.facts or {}).get("height")
            if isinstance(w, int) and isinstance(h, int):
                shapes[f"{w}x{h}"] = shapes.get(f"{w}x{h}", 0) + 1
        action = "new_dataset" if kind in VIEWABLE else "unpack" if kind == "archive" else "keep_reference" if kind in ("document",) else "keep_unsupported"
        g = {"groupId": f"g-{kind}", "kind": kind, "count": len(nodes), "suggestedAction": action}
        if shapes:
            g["shape"] = max(shapes, key=lambda k: shapes[k])
        out.append(g)
    return out


def get(db: Session, ctx: RequestContext, d: Drop, offset: int = 0) -> dict:
    if ctx.principal.startswith("agent:"):
        return summary(db, d, offset=max(0, offset))
    return person_view(db, d)


def list_for(db: Session, ctx: RequestContext, p: ProjectRow, conversation_id: str | None, limit: int = 50) -> dict:
    q = select(Drop).where(Drop.project_id == p.id)
    if conversation_id:
        q = q.where(Drop.conversation_id == conversation_id)
    return {"drops": [person_view(db, d) for d in db.scalars(q.order_by(Drop.created_at.desc()).limit(max(1, min(limit, 200))))]}


# ---- Lifecycle (D4, D15) --------------------------------------------------------------------


def remove_file(db: Session, ctx: RequestContext, d: Drop, node_id: str) -> dict:
    """Take a file out of the chat: the reference only, the File stays in Files (D4)."""
    if ctx.scopes:
        raise HTTPException(403, "only people change a chat's files")
    ids = {f.node_id for _s, f, _n in _rows(db, d) if f.node_id}
    if node_id not in ids:
        raise HTTPException(404, "that file isn't in this drop")
    if node_id not in (d.removed or []):
        d.removed = [*(d.removed or []), node_id]
        d.updated_at = now()
        db.flush()
        _publish(db, ctx, d, "drop.file", {"nodeId": node_id, "state": "removed"})
    return person_view(db, d)


def conversation_deleted(db: Session, ctx: RequestContext, p: ProjectRow, conversation_id: str) -> dict:
    """D15: the chat's message references go; its `Shared in chat` folder stays in Files,
    renamed "<conversation> (deleted chat)" (as the person, journaled, undoable)."""
    if ctx.scopes:
        raise HTTPException(403, "only people delete a conversation")
    drops = list(db.scalars(select(Drop).where(Drop.project_id == p.id, Drop.conversation_id == conversation_id)))
    folders = {d.folder_node_id for d in drops if d.folder_node_id}
    renamed = []
    for fid in folders:
        n = db.get(SourceNode, fid)
        if n is None or tree.is_hidden(db, n) or n.name.endswith(DELETED_SUFFIX):
            continue
        name = tree.free_name(f"{n.name}{DELETED_SUFFIX}"[:255], fs.taken_names(db, n.parent_id or ""), is_dir=True)
        fs.apply(db, ctx, p, {"ops": [{"kind": "rename", "nodeId": n.id, "name": name}]})
        renamed.append(n.id)
    for d in drops:
        d.message_id = None
        d.declared = {**(d.declared or {}), "conversationDeleted": True}
        d.updated_at = now()
    db.flush()
    return {"drops": len(drops), "renamedFolders": renamed}
