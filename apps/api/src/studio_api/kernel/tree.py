"""The source tree (todo6 Phase 1): node ids, natural order, numbered runs and compact chains.

Sources are immutable: a node's id is a hash of (source, relative path), so building the
same tree twice (a seed backfill on every start, a re-dropped folder) inserts nothing new.
"""

from __future__ import annotations

import hashlib
import posixpath
import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..dbutil import insert_ignore
from ..models import SourceNode, now

PAGE = 500
# A run of at least this many numbered siblings collapses into one row.
MIN_SEQUENCE = 3
_DIGITS = re.compile(r"\d+")
_LAST_DIGITS = re.compile(r"\d+(?=\D*$)")
# Extensions whose dots belong together (`.nii.gz` is a volume, not an archive).
DOUBLE_EXT = (".nii.gz", ".tar.gz")


def node_id(source_id: str, rel_path: str) -> str:
    return "nod-" + hashlib.sha256(f"{source_id}\x1f{rel_path}".encode()).hexdigest()[:20]


def natural_key(name: str) -> tuple:
    """`scan2` before `scan10`, case-insensitive (the client sorts with Intl.Collator numeric)."""
    out = []
    pos = 0
    for m in _DIGITS.finditer(name):
        if m.start() > pos:
            out.append((0, name[pos : m.start()].lower(), 0))
        out.append((1, "", int(m.group())))
        pos = m.end()
    if pos < len(name):
        out.append((0, name[pos:].lower(), 0))
    return tuple(out)


def run_id(folder_id: str, key: str) -> str:
    """A numbered run's id: `seq:<folder>:<hash of the key>`. Opaque, because the key comes
    from file names, which may hold identifiers and must stay out of URLs."""
    return f"seq:{folder_id}:{hashlib.sha256(key.encode()).hexdigest()[:12]}"


def sequence_key(name: str) -> str | None:
    """`scan001.dcm` → `scan#.dcm`: siblings with the same key form a numbered run."""
    return _LAST_DIGITS.sub("#", name, count=1) if _LAST_DIGITS.search(name) else None


def extension(name: str) -> str:
    low = name.lower()
    for ext in DOUBLE_EXT:
        if low.endswith(ext):
            return ext
    return posixpath.splitext(low)[1]


@dataclass
class FileSpec:
    rel_path: str  # relative to the source root, "/"-separated
    asset_id: str | None = None
    sha256: str | None = None
    size: int | None = None
    detected_kind: str | None = None
    facts: dict = field(default_factory=dict)
    flags: dict = field(default_factory=dict)


def add_files(db: Session, source_id: str, project_id: str, root_id: str, files: Iterable[FileSpec], *, base: str = "", import_session_id: str | None = None) -> list[str]:
    """Insert the files (and their folders) under `base` in a source. Existing nodes are
    kept as they are (immutable); returns the ids of the file nodes."""
    dirs: dict[str, dict] = {}
    rows: list[dict] = []
    ids: list[str] = []
    at = now()

    def parent_of(rel: str) -> str:
        head = posixpath.dirname(rel)
        if not head:
            return root_id
        if head not in dirs:
            pid = parent_of(head)
            dirs[head] = {"id": node_id(source_id, head), "source_id": source_id, "project_id": project_id, "parent_id": pid, "name": posixpath.basename(head), "rel_path": head, "is_dir": True, "facts": {}, "flags": {}, "child_count": 0, "descendant_count": 0, "import_session_id": import_session_id, "created_at": at}
        return dirs[head]["id"]

    for f in files:
        rel = posixpath.join(base, f.rel_path) if base else f.rel_path
        name = posixpath.basename(rel)
        nid = node_id(source_id, rel)
        ids.append(nid)
        rows.append({"id": nid, "source_id": source_id, "project_id": project_id, "parent_id": parent_of(rel), "name": name, "rel_path": rel, "is_dir": False, "asset_id": f.asset_id, "sha256": f.sha256, "size": f.size, "detected_kind": f.detected_kind, "facts": f.facts, "flags": f.flags, "sequence_key": sequence_key(name), "child_count": 0, "descendant_count": 0, "import_session_id": import_session_id, "created_at": at})
    for chunk in _chunks([*dirs.values(), *rows], 400):
        insert_ignore(db, SourceNode, chunk)
    recount(db, source_id)
    return ids


def _chunks(rows: list[dict], n: int) -> Iterable[list[dict]]:
    for i in range(0, len(rows), n):
        yield rows[i : i + n]


def recount(db: Session, source_id: str) -> None:
    """Folder child and descendant counts (files only for descendants)."""
    db.flush()
    nodes = db.execute(select(SourceNode.id, SourceNode.parent_id, SourceNode.is_dir).where(SourceNode.source_id == source_id)).all()
    children: dict[str | None, int] = {}
    files_below: dict[str, int] = {}
    parent = {n.id: n.parent_id for n in nodes}
    for n in nodes:
        children[n.parent_id] = children.get(n.parent_id, 0) + 1
        if not n.is_dir:
            p = n.parent_id
            while p is not None:
                files_below[p] = files_below.get(p, 0) + 1
                p = parent.get(p)
    for n in db.scalars(select(SourceNode).where(SourceNode.source_id == source_id, SourceNode.is_dir.is_(True))):
        c, d = children.get(n.id, 0), files_below.get(n.id, 0)
        if n.child_count != c or n.descendant_count != d:
            n.child_count, n.descendant_count = c, d


def status_of(n: SourceNode) -> str:
    """One status per row: checking, privacy, attention (duplicate, gaps), unsupported or ready."""
    if n.is_dir:
        return "ready"
    flags = n.flags or {}
    if flags.get("privacy") and not flags["privacy"].get("clearedBy"):
        return "privacy"
    if n.detected_kind is None:
        return "checking"
    if n.detected_kind == "unknown" or flags.get("unsupported"):
        return "unsupported"
    if flags.get("duplicate_of") or flags.get("quality"):
        return "attention"
    return "ready"


def node_dict(n: SourceNode, display_path: str | None = None) -> dict:
    out = {
        "id": n.id,
        "sourceId": n.source_id,
        "parentId": n.parent_id,
        "name": n.name,
        "kind": "folder" if n.is_dir else "file",
        "detectedKind": "folder" if n.is_dir else n.detected_kind,
        "size": n.size,
        "sha256": n.sha256,
        "childCount": n.child_count,
        "descendantCount": n.descendant_count,
        "facts": n.facts or {},
        "flags": n.flags or {},
        "status": status_of(n),
        "importSessionId": n.import_session_id,
        "createdAt": n.created_at.isoformat() if n.created_at else None,
    }
    if display_path:
        out["displayPath"] = display_path
    return out


def _sequence_row(parent_id: str, key: str, members: list[SourceNode]) -> dict:
    first, last = members[0], members[-1]
    kinds = {m.detected_kind for m in members}
    statuses = {status_of(m) for m in members}
    status = next((s for s in ("privacy", "checking", "unsupported", "attention") if s in statuses), "ready")
    return {
        "id": run_id(parent_id, key),
        "sourceId": first.source_id,
        "parentId": parent_id,
        "name": f"{first.name}–{last.name}",
        "kind": "sequence",
        "detectedKind": kinds.pop() if len(kinds) == 1 else None,
        "size": sum(m.size or 0 for m in members),
        "sha256": None,
        "childCount": len(members),
        "descendantCount": len(members),
        "facts": {},
        "flags": {},
        "status": status,
        "importSessionId": first.import_session_id,
        "createdAt": first.created_at.isoformat() if first.created_at else None,
    }


def _ordered(rows: list[SourceNode]) -> list[SourceNode]:
    return sorted(rows, key=lambda n: (not n.is_dir, natural_key(n.name)))


def _compact(db: Session, n: SourceNode) -> tuple[SourceNode, str | None]:
    """A folder whose only child is a folder shows as one row `MRI / patient_002`."""
    names = [n.name]
    cur = n
    for _ in range(16):
        if cur.child_count != 1:
            break
        only = db.scalar(select(SourceNode).where(SourceNode.parent_id == cur.id))
        if only is None or not only.is_dir:
            break
        cur = only
        names.append(cur.name)
    return cur, (" / ".join(names) if len(names) > 1 else None)


def children(db: Session, source_id: str, parent: str, cursor: int = 0, limit: int = PAGE) -> dict:
    """One page of a folder's listing: folders first, natural order, numbered runs collapsed.
    `parent` is a folder id or a run id (`seq:<folder>:<hash>`), which lists the run's files."""
    if parent.startswith("seq:"):
        _, folder, _h = parent.split(":", 2)
        siblings = db.scalars(select(SourceNode).where(SourceNode.source_id == source_id, SourceNode.parent_id == folder, SourceNode.is_dir.is_(False), SourceNode.sequence_key.is_not(None)))
        rows = _ordered([n for n in siblings if run_id(folder, n.sequence_key or "") == parent])
        items = [node_dict(n) for n in rows]
    else:
        rows = _ordered(list(db.scalars(select(SourceNode).where(SourceNode.source_id == source_id, SourceNode.parent_id == parent))))
        runs: dict[str, list[SourceNode]] = {}
        for n in rows:
            if not n.is_dir and n.sequence_key:
                runs.setdefault(n.sequence_key, []).append(n)
        items, emitted = [], set()
        for n in rows:
            key = n.sequence_key if not n.is_dir else None
            if key and len(runs[key]) >= MIN_SEQUENCE:
                if key not in emitted:
                    emitted.add(key)
                    items.append(_sequence_row(parent, key, runs[key]))
                continue
            if n.is_dir:
                deepest, display = _compact(db, n)
                items.append(node_dict(deepest, display))
            else:
                items.append(node_dict(n))
    page = items[cursor : cursor + limit]
    nxt = cursor + limit if cursor + limit < len(items) else None
    return {"items": page, "total": len(items), "nextCursor": str(nxt) if nxt is not None else None}


def run_of(db: Session, n: SourceNode) -> str | None:
    """The run a file is collapsed into in its folder's listing, if it is."""
    if n.is_dir or not n.sequence_key or n.parent_id is None:
        return None
    count = db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.parent_id == n.parent_id, SourceNode.sequence_key == n.sequence_key, SourceNode.is_dir.is_(False))) or 0
    return run_id(n.parent_id, n.sequence_key) if count >= MIN_SEQUENCE else None


def ancestors(db: Session, n: SourceNode) -> list[SourceNode]:
    """Root first, excluding `n`."""
    out = []
    cur = n
    for _ in range(256):
        if cur.parent_id is None:
            break
        p = db.get(SourceNode, cur.parent_id)
        if p is None:
            break
        out.append(p)
        cur = p
    return list(reversed(out))


def files_under(db: Session, node_ids: list[str]) -> list[SourceNode]:
    """Every file at or below the given nodes (dataset definitions name folders or files)."""
    seen: set[str] = set()
    out: list[SourceNode] = []
    frontier = list(node_ids)
    while frontier:
        batch, frontier = frontier[:500], frontier[500:]
        for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(batch))):
            if n.id in seen:
                continue
            seen.add(n.id)
            if n.is_dir:
                frontier.extend(db.scalars(select(SourceNode.id).where(SourceNode.parent_id == n.id)))
            else:
                out.append(n)
    return sorted(out, key=lambda n: natural_key(n.rel_path))


def count_files(db: Session, project_id: str) -> int:
    return db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.project_id == project_id, SourceNode.is_dir.is_(False))) or 0
