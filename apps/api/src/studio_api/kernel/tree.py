"""The project's drive (todo6 Phase 1, todo7): node ids, natural order, numbered runs, compact
chains, computed paths and folder counts.

Node ids are opaque and permanent (todo7 D3): new nodes get `nod-<uuid hex>`. Seeds keep the
ids hashed from (source, path) they were first backfilled with, so a backfill on every start
inserts nothing new. Paths are not stored (D4): `chains` walks the parent chain with one
recursive CTE, so a move is one row update plus counts along two ancestor chains.

Counts (`child_count`, `descendant_count`, `total_bytes`) leave out what is in Trash: a
trashed folder keeps its own counts (restoring it adds them back), but isn't counted in its
parent.
"""

from __future__ import annotations

import hashlib
import posixpath
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import Integer, cast, func, literal, select
from sqlalchemy.orm import Session

from ..dbutil import insert_ignore
from ..models import NodeVersion, SourceNode, now

PAGE = 500
# A run of at least this many numbered siblings collapses into one row.
MIN_SEQUENCE = 3
_DIGITS = re.compile(r"\d+")
_LAST_DIGITS = re.compile(r"\d+(?=\D*$)")
# Extensions whose dots belong together (`.nii.gz` is a volume, not an archive).
DOUBLE_EXT = (".nii.gz", ".tar.gz")
ROOT_NAME = "Files"
SORTS = ("name", "kind", "size", "added")


def node_id(source_id: str, rel_path: str) -> str:
    """Seeds only (and the ids every node had before todo7): a hash of (source, path)."""
    return "nod-" + hashlib.sha256(f"{source_id}\x1f{rel_path}".encode()).hexdigest()[:20]


def new_node_id() -> str:
    return "nod-" + uuid.uuid4().hex


NEW_ID = re.compile(r"nod-[0-9a-f]{32}")


def drive_root_id(project_id: str) -> str:
    """The project's one root (D1). Deterministic, so concurrent first requests (two replicas,
    two tabs) both insert-or-ignore the same row. Migration 0005 uses the same formula."""
    return "nod-" + hashlib.sha256(f"{project_id}\x1fdrive".encode()).hexdigest()[:20]


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


def split_ext(name: str) -> tuple[str, str]:
    """`scan.nii.gz` → (`scan`, `.nii.gz`), keeping the name's own case."""
    ext = extension(name)
    if not ext or len(ext) >= len(name):
        return name, ""
    return name[: len(name) - len(ext)], name[len(name) - len(ext) :]


def free_name(name: str, taken: set[str], is_dir: bool = False) -> str:
    """`scan001.dcm` → `scan001 (2).dcm` (Keep both), the first not in `taken` (lowercase)."""
    if name.lower() not in taken:
        return name
    stem, ext = (name, "") if is_dir else split_ext(name)
    m = re.fullmatch(r"(.*) \((\d+)\)", stem)
    base, i = (m.group(1), int(m.group(2)) + 1) if m else (stem, 2)
    while True:
        cand = f"{base} ({i}){ext}"
        if cand.lower() not in taken:
            return cand
        i += 1


# ---- Building trees (imports, seeds) -----------------------------------------------------------


@dataclass
class FileSpec:
    rel_path: str  # relative to the folder the files land in, "/"-separated
    asset_id: str | None = None
    sha256: str | None = None
    size: int | None = None
    detected_kind: str | None = None
    facts: dict = field(default_factory=dict)
    flags: dict = field(default_factory=dict)
    # A chosen id (an upload's `upload_files.node_id`); otherwise a new one (or the seed hash).
    id: str | None = None


def _row(**kw) -> dict:
    base = {"facts": {}, "flags": {}, "child_count": 0, "descendant_count": 0, "total_bytes": 0, "revision": 0, "version": 1, "name_dup": 0, "locked": False, "asset_id": None, "sha256": None, "size": None, "detected_kind": None, "sequence_key": None, "import_session_id": None, "trashed_at": None, "trashed_by": None, "trash_batch_id": None}
    return base | kw


def add_files(db: Session, project_id: str, source_id: str | None, parent_id: str, files: Iterable[FileSpec], *, stable: bool = False, import_session_id: str | None = None, locked: bool = False, created_by: str = "system", original_prefix: str = "") -> list[str]:
    """Insert files (and the folders on their paths) below `parent_id`. Folders that already
    exist (same name, any case, not in Trash) are reused; a file whose name is taken gets a
    "Keep both" name. A file whose id already exists is left as it is (idempotent). `stable`
    (seeds) hashes ids from (source, path). Returns the file ids, in input order."""
    parent = db.get(SourceNode, parent_id)
    assert parent is not None
    root = parent.project_root or (parent.id if parent.parent_id is None else None)
    at = now()
    taken: dict[str, set[str]] = {}
    folders: dict[tuple[str, str], str] = {}
    by_rel: dict[str, str] = {"": parent_id}
    rows: list[dict] = []

    def load(pid: str) -> set[str]:
        if pid not in taken:
            names: set[str] = set()
            for nid, name, is_dir in db.execute(select(SourceNode.id, SourceNode.name, SourceNode.is_dir).where(SourceNode.parent_id == pid, SourceNode.trashed_at.is_(None))):
                names.add(name.lower())
                if is_dir:
                    folders[(pid, name.lower())] = nid
            taken[pid] = names
        return taken[pid]

    def folder_for(rel_dir: str) -> str:
        if rel_dir in by_rel:
            return by_rel[rel_dir]
        pid = folder_for(posixpath.dirname(rel_dir))
        name = posixpath.basename(rel_dir)
        names = load(pid)
        key = (pid, name.lower())
        if key in folders:
            by_rel[rel_dir] = folders[key]
            return folders[key]
        orig = posixpath.join(original_prefix, rel_dir) if original_prefix else rel_dir
        nid = node_id(source_id or project_id, orig) if stable else new_node_id()
        if name.lower() in names:  # a file has that name
            name = free_name(name, names, is_dir=True)
        rows.append(_row(id=nid, source_id=source_id, project_id=project_id, project_root=root, parent_id=pid, name=name, original_path=orig, is_dir=True, locked=locked, import_session_id=import_session_id, created_at=at))
        names.add(name.lower())
        folders[(pid, name.lower())] = nid
        by_rel[rel_dir] = nid
        return nid

    specs = list(files)
    wanted = [f.id or (node_id(source_id or project_id, posixpath.join(original_prefix, f.rel_path) if original_prefix else f.rel_path) if stable else None) for f in specs]
    existing: set[str] = set()
    known = [w for w in wanted if w]
    for i in range(0, len(known), 500):
        existing |= set(db.scalars(select(SourceNode.id).where(SourceNode.id.in_(known[i : i + 500]))))
    ids: list[str] = []
    versions: list[dict] = []
    for f, want in zip(specs, wanted, strict=True):
        if want and want in existing:
            ids.append(want)
            continue
        pid = folder_for(posixpath.dirname(f.rel_path))
        names = load(pid)
        name = posixpath.basename(f.rel_path)
        if name.lower() in names:
            name = free_name(name, names)
        nid = want or new_node_id()
        orig = posixpath.join(original_prefix, f.rel_path) if original_prefix else f.rel_path
        rows.append(_row(id=nid, source_id=source_id, project_id=project_id, project_root=root, parent_id=pid, name=name, original_path=orig, is_dir=False, asset_id=f.asset_id, sha256=f.sha256, size=f.size, detected_kind=f.detected_kind, facts=f.facts, flags=f.flags, sequence_key=sequence_key(name), locked=locked, import_session_id=import_session_id, created_at=at))
        names.add(name.lower())
        versions.append({"node_id": nid, "version": 1, "project_id": project_id, "asset_id": f.asset_id, "sha256": f.sha256, "size": f.size, "detected_kind": f.detected_kind, "facts": f.facts, "flags": f.flags, "created_by": created_by, "created_at": at})
        ids.append(nid)
    for i in range(0, len(rows), 400):
        insert_ignore(db, SourceNode, rows[i : i + 400])
    for i in range(0, len(versions), 400):
        insert_ignore(db, NodeVersion, versions[i : i + 400])
    if rows:
        recount_under(db, parent_id)
    return ids


# ---- Counts ------------------------------------------------------------------------------------


def subtree(db: Session, folder_id: str, *, into_trash: bool = False) -> list:
    """(id, parent_id, is_dir, size, trashed_at, asset_id, name) of a folder and everything below
    it, with one recursive CTE. Trashed children (and what's below them) only with `into_trash`."""
    cols = (SourceNode.id, SourceNode.parent_id, SourceNode.is_dir, SourceNode.size, SourceNode.trashed_at, SourceNode.asset_id, SourceNode.name)
    down = select(*cols).where(SourceNode.id == folder_id).cte("down", recursive=True)
    # FROM the CTE first: each new row looks its children up by the parent index.
    step = select(*cols).select_from(down).join(SourceNode, SourceNode.parent_id == down.c.id)
    if not into_trash:
        step = step.where(SourceNode.trashed_at.is_(None))
    down = down.union_all(step)
    return list(db.execute(select(down)))


def recount_under(db: Session, folder_id: str) -> None:
    """Recompute the counts of a folder's subtree, then pass the difference up its ancestors.
    Used after an import inserted rows below `folder_id` (O(subtree), like the import)."""
    db.flush()
    rows = subtree(db, folder_id)
    kids: dict[str, list] = {}
    for r in rows:
        if r.id != folder_id:
            kids.setdefault(r.parent_id, []).append(r)
    totals: dict[str, tuple[int, int, int]] = {}

    def total(nid: str) -> tuple[int, int, int]:
        # Iterative post-order: trees can be deeper than Python's recursion limit allows.
        stack = [(nid, False)]
        while stack:
            cur, done = stack.pop()
            if done:
                c = kids.get(cur, [])
                files = sum(1 if not k.is_dir else totals[k.id][1] for k in c)
                size = sum((k.size or 0) if not k.is_dir else totals[k.id][2] for k in c)
                totals[cur] = (len(c), files, size)
                continue
            stack.append((cur, True))
            stack.extend((k.id, False) for k in kids.get(cur, []) if k.is_dir)
        return totals[nid]

    total(folder_id)
    delta_files = delta_bytes = 0
    for nid, (c, d, b) in totals.items():
        n = db.get(SourceNode, nid)
        if n is None:
            continue
        if nid == folder_id:
            delta_files, delta_bytes = d - (n.descendant_count or 0), b - (n.total_bytes or 0)
        if (n.child_count, n.descendant_count, n.total_bytes) != (c, d, b):
            n.child_count, n.descendant_count, n.total_bytes = c, d, b
    top = db.get(SourceNode, folder_id)
    if top is not None and top.trashed_at is None and top.parent_id and (delta_files or delta_bytes):
        bump(db, top.parent_id, delta_files, delta_bytes)


def bump(db: Session, folder_id: str | None, files: int, size: int, children: int = 0) -> list[str]:
    """Add to the counts of `folder_id` and its ancestors (`children` only to the folder
    itself): O(depth) row updates. Stops above a folder in Trash (it isn't counted in its
    parent). Returns the ids it changed."""
    changed: list[str] = []
    cur = db.get(SourceNode, folder_id) if folder_id else None
    first = True
    for _ in range(512):
        if cur is None:
            break
        if first and children:
            cur.child_count = max(0, (cur.child_count or 0) + children)
            cur.revision = (cur.revision or 0) + 1
        if files or size:
            cur.descendant_count = max(0, (cur.descendant_count or 0) + files)
            cur.total_bytes = max(0, (cur.total_bytes or 0) + size)
        changed.append(cur.id)
        if cur.trashed_at is not None or cur.parent_id is None or not (files or size):
            break
        first = False
        cur = db.get(SourceNode, cur.parent_id)
    return changed


def weight(n: SourceNode) -> tuple[int, int]:
    """(files, bytes) a node adds to its ancestors' counts."""
    return (n.descendant_count or 0, n.total_bytes or 0) if n.is_dir else (1, n.size or 0)


# ---- Paths (D4) --------------------------------------------------------------------------------


@dataclass
class Chain:
    """A node's ancestors and itself, root first."""

    ids: list[str]
    names: list[str]
    trashed: list[datetime | None]

    @property
    def path(self) -> str:
        """The current path without the drive root: `MRI/patient_002/scan001.dcm`."""
        return "/".join(self.names[1:])

    @property
    def folder(self) -> str:
        return "/".join(self.names[1:-1])

    @property
    def hidden(self) -> bool:
        """In Trash, or inside a trashed folder."""
        return any(t is not None for t in self.trashed)


def chains(db: Session, ids: Iterable[str]) -> dict[str, Chain]:
    """The parent chains of many nodes with one recursive CTE per 500 ids."""
    want = list(dict.fromkeys(ids))
    out: dict[str, Chain] = {}
    for i in range(0, len(want), 500):
        batch = want[i : i + 500]
        up = select(SourceNode.id.label("start"), SourceNode.id.label("nid"), SourceNode.parent_id.label("pid"), SourceNode.name.label("name"), SourceNode.trashed_at.label("trashed"), cast(literal(0), Integer).label("depth")).where(SourceNode.id.in_(batch)).cte("up", recursive=True)
        up = up.union_all(select(up.c.start, SourceNode.id, SourceNode.parent_id, SourceNode.name, SourceNode.trashed_at, up.c.depth + 1).join(SourceNode, SourceNode.id == up.c.pid).where(up.c.depth < 512))
        rows: dict[str, list] = {}
        for r in db.execute(select(up)):
            rows.setdefault(r.start, []).append(r)
        for start, rs in rows.items():
            rs.sort(key=lambda r: -r.depth)
            out[start] = Chain([r.nid for r in rs], [r.name for r in rs], [r.trashed for r in rs])
    return out


def chain_of(db: Session, n: SourceNode) -> Chain:
    return chains(db, [n.id]).get(n.id) or Chain([n.id], [n.name], [n.trashed_at])


def path_of(db: Session, n: SourceNode) -> str:
    return chain_of(db, n).path


def paths_of(db: Session, ids: Iterable[str]) -> dict[str, str]:
    return {k: c.path for k, c in chains(db, ids).items()}


def is_hidden(db: Session, n: SourceNode) -> bool:
    if n.trashed_at is not None:
        return True
    return chain_of(db, n).hidden


# ---- Listing -----------------------------------------------------------------------------------


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


def node_dict(n: SourceNode, display_path: str | None = None, *, starred: set[str] | None = None) -> dict:
    out = {
        "id": n.id,
        "sourceId": n.source_id,
        "parentId": n.parent_id,
        "name": n.name,
        "kind": "folder" if n.is_dir else "file",
        "detectedKind": "folder" if n.is_dir else n.detected_kind,
        "size": n.total_bytes if n.is_dir else n.size,
        "sha256": n.sha256,
        "childCount": n.child_count,
        "descendantCount": n.descendant_count,
        "facts": n.facts or {},
        "flags": n.flags or {},
        "status": status_of(n),
        "importSessionId": n.import_session_id,
        "createdAt": n.created_at.isoformat() if n.created_at else None,
        "locked": bool(n.locked),
        "trashed": n.trashed_at is not None,
    }
    if n.is_dir:
        out["totalBytes"] = n.total_bytes or 0
        out["revision"] = n.revision or 0
        out["size"] = None
    else:
        out["version"] = n.version or 1
    if starred is not None:
        out["starred"] = n.id in starred
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
        "locked": all(m.locked for m in members),
        "trashed": False,
        "totalBytes": sum(m.size or 0 for m in members),
        "starred": False,
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
        only = db.scalars(select(SourceNode).where(SourceNode.parent_id == cur.id, SourceNode.trashed_at.is_(None)).limit(2)).all()
        if len(only) != 1 or not only[0].is_dir:
            break
        cur = only[0]
        names.append(cur.name)
    return cur, (" / ".join(names) if len(names) > 1 else None)


def _sort_items(items: list[dict], sort: str, direction: str) -> list[dict]:
    """Folders first always (in both directions), then the chosen key; ties by name."""
    rev = direction == "desc"

    def key(d: dict):
        if sort == "kind":
            return (str(d.get("detectedKind") or ""), natural_key(d["name"]))
        if sort == "size":
            return (d.get("totalBytes") if d["kind"] == "folder" else d.get("size")) or 0, natural_key(d["name"])
        if sort == "added":
            return (d.get("createdAt") or "", natural_key(d["name"]))
        return natural_key(d["name"])

    folders = sorted([d for d in items if d["kind"] == "folder"], key=key, reverse=rev)
    rest = sorted([d for d in items if d["kind"] != "folder"], key=key, reverse=rev)
    return folders + rest


def children(db: Session, project_id: str, parent: str, cursor: int = 0, limit: int = PAGE, *, sort: str = "name", direction: str = "asc", starred: set[str] | None = None, compact: bool = True) -> dict:
    """One page of a folder's listing (not in Trash): folders first, numbered runs collapsed,
    sorted server-side so paging stays correct. `parent` is a folder id or a run id
    (`seq:<folder>:<hash>`), which lists the run's files."""
    if parent.startswith("seq:"):
        _, folder, _h = parent.split(":", 2)
        siblings = db.scalars(select(SourceNode).where(SourceNode.project_id == project_id, SourceNode.parent_id == folder, SourceNode.is_dir.is_(False), SourceNode.sequence_key.is_not(None), SourceNode.trashed_at.is_(None)))
        rows = _ordered([n for n in siblings if run_id(folder, n.sequence_key or "") == parent])
        items = [node_dict(n, starred=starred) for n in rows]
    else:
        rows = _ordered(list(db.scalars(select(SourceNode).where(SourceNode.project_id == project_id, SourceNode.parent_id == parent, SourceNode.trashed_at.is_(None)))))
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
            if n.is_dir and compact:
                deepest, display = _compact(db, n)
                items.append(node_dict(deepest, display, starred=starred))
            else:
                items.append(node_dict(n, starred=starred))
    if sort != "name" or direction != "asc":
        items = _sort_items(items, sort if sort in SORTS else "name", direction)
    page = items[cursor : cursor + limit]
    nxt = cursor + limit if cursor + limit < len(items) else None
    return {"items": page, "total": len(items), "nextCursor": str(nxt) if nxt is not None else None}


def run_of(db: Session, n: SourceNode) -> str | None:
    """The run a file is collapsed into in its folder's listing, if it is."""
    if n.is_dir or not n.sequence_key or n.parent_id is None:
        return None
    count = db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.parent_id == n.parent_id, SourceNode.sequence_key == n.sequence_key, SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None))) or 0
    return run_id(n.parent_id, n.sequence_key) if count >= MIN_SEQUENCE else None


def ancestors(db: Session, n: SourceNode) -> list[SourceNode]:
    """Root first, excluding `n`."""
    out = []
    cur = n
    for _ in range(512):
        if cur.parent_id is None:
            break
        p = db.get(SourceNode, cur.parent_id)
        if p is None:
            break
        out.append(p)
        cur = p
    return list(reversed(out))


def files_under(db: Session, node_ids: list[str]) -> list[SourceNode]:
    """Every file at or below the given nodes, not in Trash, in path order. Since todo7 D7 a
    dataset's files are frozen in its definition: this is for previews and the "new files in
    followed folders" banner only."""
    starts = [n for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(list(node_ids)))) if n.trashed_at is None] if node_ids else []
    if not starts:
        return []
    base = chains(db, [n.id for n in starts])
    seen: set[str] = set()
    out: list[tuple[str, SourceNode]] = []
    frontier: list[tuple[SourceNode, str]] = []
    for n in starts:
        c = base.get(n.id)
        if c is not None and c.hidden:
            continue
        frontier.append((n, c.path if c else n.name))
    while frontier:
        batch, frontier = frontier[:500], frontier[500:]
        dirs: dict[str, str] = {}
        for n, path in batch:
            if n.id in seen:
                continue
            seen.add(n.id)
            if n.is_dir:
                dirs[n.id] = path
            else:
                out.append((path, n))
        if dirs:
            for c in db.scalars(select(SourceNode).where(SourceNode.parent_id.in_(list(dirs)), SourceNode.trashed_at.is_(None))):
                frontier.append((c, f"{dirs[c.parent_id]}/{c.name}" if dirs[c.parent_id or ""] else c.name))  # type: ignore[index]
    out.sort(key=lambda pn: natural_key(pn[0]))
    return [n for _, n in out]


def count_files(db: Session, project_id: str) -> int:
    return db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.project_id == project_id, SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None))) or 0
