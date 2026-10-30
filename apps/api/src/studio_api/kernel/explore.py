"""Explore (todo6 Phase 5): proposals built from inspected facts, and what confirming one does.

Proposals change nothing until a person confirms them (docs/ux.md §6, §9):

- *relationship*: a table column ↔ file or folder names. IDs are compared after a stated
  rule: exactly, ignoring case and separators, or (only for a numeric-like column) ignoring
  letters and leading zeros, so `P001` = `p-001` = `1` but never one name for another.
  Evidence counts matched, not found and ambiguous rows, with examples. A person can pick
  another column, target or rule, and fix single rows (pick the file or folder, or skip the
  row); the kernel recomputes every time (`recompute`).
- *mapping*: a categorical column → label classes, with examples and conflicts (values that
  differ only by case or spacing).
- *dataset*: a dataset definition (which files, how items group) plus a preset and the label
  classes. Confirming it creates the dataset and task, writes the environment, imports the
  table's labels as `imported` annotations (todo6 D8) and confirms the relationship and
  mapping it was built on.

Matching never decides patient identity from file names alone: ambiguous rows stay open
until a person picks.
"""

from __future__ import annotations

import csv
import io
import math
import re
import uuid
from collections import Counter
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import Asset, DatasetRow, ImportSession, ProjectRow, Proposal, Source, SourceNode, TaskRow, now
from . import annotations, assets, audit, events, projects, tree
from .kinds import BY_EXTENSION, VIEWABLE

INSPECTOR = "worker:inspect"
RULES = {
    "exact": "Exactly as written",
    "normalized": "Ignoring case, spaces, dashes and underscores",
    "numeric": "Ignoring leading zeros and abbreviated letters (P001 = p-001 = patient_001 = 1)",
}
TARGETS = {"files": "file names", "folders": "folder names"}
DELIMITERS = {"comma": ",", "semicolon": ";", "tab": "\t", "pipe": "|"}
NUMERIC = re.compile(r"([A-Za-z]{0,12})[-_ #]?0*(\d{1,9})")
SEP = re.compile(r"[\s_\-.]+")
LABEL_HINT = re.compile(r"label|class|diagnos|finding|category|target|outcome|grade|result|type", re.I)
MAX_TABLE_BYTES = 64 * 1024 * 1024
MAX_LISTED = 200
# Which preset opens which data (registry/presets).
PRESETS = {"image": "preset:image-2d", "dicom": "preset:image-2d", "dicom-series": "preset:volume-3d", "volume": "preset:volume-3d", "mask": "preset:volume-3d", "video": "preset:video", "waveform": "preset:ecg", "slide": "preset:pathology"}
NOUNS = {"image": ("image", "images"), "dicom": ("DICOM image", "DICOM images"), "dicom-series": ("DICOM series", "DICOM series"), "volume": ("3D volume", "3D volumes"), "mask": ("mask", "masks"), "video": ("video", "videos"), "waveform": ("recording", "recordings"), "slide": ("slide", "slides")}
CHART = [f"chart-{i}" for i in range(1, 9)]

# ---- Reading tables ------------------------------------------------------------------------------


def table_rows(db: Session, n: SourceNode) -> tuple[list[str], list[list[str]]]:
    """(column names, data rows) of a table node, parsed the way the worker profiled it."""
    t = (n.facts or {}).get("table") or {}
    path = t.get("csvPath")
    a = db.scalar(select(Asset).where(Asset.workspace_id == n.project_id, Asset.path == path)) if path else (db.get(Asset, n.asset_id) if n.asset_id else None)
    if a is None:
        return [], []
    raw = assets.asset_head(a, MAX_TABLE_BYTES)
    text = None
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    text = text or ""
    delim = DELIMITERS.get(str(t.get("delimiter") or "comma"), ",")
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]
    if not rows:
        return [], []
    names = [c["name"] for c in t.get("columns") or []]
    if t.get("header", True):
        names = names or [c.strip() for c in rows[0]]
        rows = rows[1:]
    width = max([len(names)] + [len(r) for r in rows[:1000]])
    names += [f"Column {i + 1}" for i in range(len(names), width)]
    return names, rows


def _cell(row: list[str], i: int) -> str:
    return row[i].strip() if i < len(row) else ""


# ---- ID rules --------------------------------------------------------------------------------------

EXTENSIONS = sorted(BY_EXTENSION, key=len, reverse=True)


def bare(v: str) -> str:
    """A value or a name without folders and without a known extension (`a/img_001.png` → `img_001`)."""
    s = v.strip().replace("\\", "/").rsplit("/", 1)[-1]
    low = s.lower()
    for ext in EXTENSIONS:
        if low.endswith(ext) and len(s) > len(ext):
            return s[: -len(ext)]
    return s


def key_of(v: str, rule: str) -> str | None:
    """The comparable form of a value or name. Under `numeric` it is `<letters>|<number>`:
    `P001` → `p|1`, `1` → `|1`; `prefix_compatible` decides which letters may meet."""
    s = bare(v)
    if not s:
        return None
    if rule == "exact":
        return s
    if rule == "normalized":
        return SEP.sub("", s.lower()) or None
    m = NUMERIC.fullmatch(s)
    return f"{m.group(1).lower()}|{int(m.group(2))}" if m else None


def prefix_compatible(a: str, b: str) -> bool:
    """`P001` = `p-001` = `1` = `patient_001` = `pt001`, but `s1` ≠ `img_001`: letters may be
    missing on one side or abbreviated (same first letter, the short one's letters in order in
    the long one), never different."""
    pa, pb = sorted((a.split("|", 1)[0], b.split("|", 1)[0]), key=len)
    if not pa or pa == pb:
        return True
    if pa[0] != pb[0]:
        return False
    rest = iter(pb)
    return all(ch in rest for ch in pa)


def numeric_like(values: list[str]) -> bool:
    vals = [bare(v) for v in values if v.strip()]
    return bool(vals) and sum(bool(NUMERIC.fullmatch(v)) for v in vals) >= 0.9 * len(vals)


# ---- Targets (files and folders that can be items) -------------------------------------------------


class Targets:
    """The project's viewable files and the folders above them, by id and by key."""

    def __init__(self, db: Session, p: ProjectRow):
        self.files = [n for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False))) if (n.detected_kind or "") in VIEWABLE]
        dirs = {n.id: n for n in db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(True)))}
        self.nodes: dict[str, SourceNode] = {n.id: n for n in self.files}
        self.files_in: dict[str, list[str]] = {}
        for f in self.files:
            cur = dirs.get(f.parent_id or "")
            while cur is not None and cur.parent_id is not None:  # a source root is not a record
                self.nodes[cur.id] = cur
                self.files_in.setdefault(cur.id, []).append(f.id)
                cur = dirs.get(cur.parent_id)
        self._index: dict[tuple[str, str], dict[str, list[tuple[str, str]]]] = {}

    def of(self, target: str) -> list[SourceNode]:
        return self.files if target == "files" else [n for n in self.nodes.values() if n.is_dir]

    def index(self, target: str, rule: str) -> dict[str, list[tuple[str, str]]]:
        """key → [(node id, its full key)]; under `numeric` the key is the number alone."""
        if (target, rule) not in self._index:
            idx: dict[str, list[tuple[str, str]]] = {}
            for n in self.of(target):
                k = key_of(n.name, rule)
                if k is not None:
                    idx.setdefault(k.split("|", 1)[1] if rule == "numeric" else k, []).append((n.id, k))
            self._index[(target, rule)] = idx
        return self._index[(target, rule)]

    def lookup(self, target: str, rule: str, key: str) -> list[str]:
        if rule != "numeric":
            return [nid for nid, _ in self.index(target, rule).get(key, [])]
        return [nid for nid, k in self.index(target, rule).get(key.split("|", 1)[1], []) if prefix_compatible(key, k)]

    def file_ids(self, node_id: str) -> list[str]:
        n = self.nodes.get(node_id)
        if n is None:
            return []
        return [node_id] if not n.is_dir else self.files_in.get(node_id, [])

    def describe(self, node_id: str) -> dict:
        n = self.nodes[node_id]
        return {"nodeId": n.id, "name": n.name, "path": n.rel_path, "kind": "folder" if n.is_dir else "file"}


# ---- Relationships -----------------------------------------------------------------------------------


def match(names: list[str], rows: list[list[str]], targets: Targets, column: str, target: str, rule: str, resolutions: dict[str, str] | None = None) -> dict:
    """Evidence for `column` ↔ `target` names under `rule`, with a person's per-row fixes."""
    if column not in names:
        raise HTTPException(422, f"the table has no column {column!r}")
    if target not in TARGETS:
        raise HTTPException(422, f"target is one of {sorted(TARGETS)}")
    if rule not in RULES:
        raise HTTPException(422, f"rule is one of {sorted(RULES)}")
    i = names.index(column)
    values = [_cell(r, i) for r in rows]
    if rule == "numeric" and not numeric_like(values):
        raise HTTPException(422, f"“{column}” isn't numeric-like, so letters and leading zeros can't be ignored: that could match one name for another")
    resolutions = {str(k): str(v) for k, v in (resolutions or {}).items()}
    matched: list[dict] = []
    unmatched: list[dict] = []
    ambiguous: list[dict] = []
    skipped = resolved = empty = 0
    links: list[list] = []
    keys = Counter(key_of(v, rule) for v in values if v)
    for row, v in enumerate(values):
        fix = resolutions.get(str(row))
        if fix == "skip":
            skipped += 1
            continue
        if fix and fix in targets.nodes:
            resolved += 1
            matched.append({"row": row, "value": v, "target": targets.describe(fix), "manual": True})
            links.append([row, fix])
            continue
        if not v:
            empty += 1
            continue
        k = key_of(v, rule)
        hits = targets.lookup(target, rule, k) if k is not None else []
        if len(hits) == 1:
            matched.append({"row": row, "value": v, "target": targets.describe(hits[0])})
            links.append([row, hits[0]])
        elif hits:
            ambiguous.append({"row": row, "value": v, "candidates": [targets.describe(h) for h in hits[:20]]})
        else:
            unmatched.append({"row": row, "value": v})
    considered = len(matched) + len(unmatched) + len(ambiguous)
    frac = len(matched) / considered if considered else 0.0
    strength = "strong" if frac >= 0.95 and not ambiguous else "possible" if frac >= 0.6 else "weak"
    if rule == "numeric" and strength == "strong":
        strength = "possible"  # letters were ignored: a person should look before it counts
    repeated = sum(1 for k, n in keys.items() if k is not None and n > 1)
    why = [f"Compared “{column}” with {TARGETS[target]}: {RULES[rule].lower()}."]
    if matched:
        ex = matched[0]
        why.append(f"For example, row {ex['row'] + 1} “{ex['value']}” ↔ {ex['target']['name']}.")
    if repeated:
        why.append(f"{repeated} {'id appears' if repeated == 1 else 'ids appear'} on more than one row.")
    if rule == "numeric":
        why.append("Letters and leading zeros were ignored, so check a few rows before confirming.")
    return {
        "column": column,
        "target": target,
        "rule": rule,
        "ruleLabel": RULES[rule],
        "rows": len(values),
        "matched": len(matched),
        "unmatched": len(unmatched),
        "ambiguous": len(ambiguous),
        "skipped": skipped,
        "resolved": resolved,
        "empty": empty,
        "repeatedIds": repeated,
        "examples": matched[:3],
        "unmatchedRows": unmatched[:MAX_LISTED],
        "ambiguousRows": ambiguous[:MAX_LISTED],
        "links": links,
        "why": why,
        "strength": strength,
    }


def _summary_rel(table: str, ev: dict) -> str:
    return f"{table} › {ev['column']} ↔ {TARGETS[ev['target']]}: {ev['matched']} matched · {ev['unmatched']} not found · {ev['ambiguous']} ambiguous"


def best_relationship(names: list[str], rows: list[list[str]], targets: Targets, profile: dict) -> dict | None:
    """The column, target and rule that link the most rows (ties: name-like columns, unique
    columns, files before folders, the stricter rule)."""
    cols = {c["name"]: c for c in profile.get("columns") or []}
    best: tuple[tuple, dict] | None = None
    for ci, col in enumerate(names):
        info = cols.get(col, {})
        if info.get("type") in ("number", "date", "empty") and not numeric_like([_cell(r, ci) for r in rows[:200]]):
            continue
        values = [_cell(r, ci) for r in rows]
        filled = sum(1 for v in values if v)
        if not filled:
            continue
        for target in ("files", "folders"):
            for rank, rule in enumerate(("normalized", "numeric")):
                if rule == "numeric" and not numeric_like(values):
                    continue
                ev = match(names, rows, targets, col, target, rule)
                # One coincidental match (`s1` ~ `series1`) is not a relationship.
                if ev["matched"] < max(2, math.ceil(0.3 * filled)):
                    continue
                score = (ev["matched"], -ev["ambiguous"], col in (profile.get("nameColumns") or []), col in (profile.get("candidateKeys") or []), target == "files", -rank)
                if best is None or score > best[0]:
                    best = (score, ev)
    return best[1] if best else None


# ---- Label mappings --------------------------------------------------------------------------------


def slug(v: str) -> str:
    s = re.sub(r"[^a-z0-9_-]+", "-", v.strip().lower()).strip("-")
    return s or "label"


def mapping_evidence(names: list[str], rows: list[list[str]], column: str, classes: list[dict] | None = None) -> tuple[dict, list[dict]]:
    """(evidence, classes) for `column` as label classes; `classes` keeps a person's renames."""
    if column not in names:
        raise HTTPException(422, f"the table has no column {column!r}")
    i = names.index(column)
    counts = Counter(_cell(r, i) for r in rows if _cell(r, i))
    if not counts:
        raise HTTPException(422, f"“{column}” is empty")
    if len(counts) > 50:
        raise HTTPException(422, f"“{column}” has {len(counts)} different values: too many to be label classes")
    given = {str(c.get("value")): str(c.get("id") or "") for c in classes or [] if isinstance(c, dict)}
    out = [{"value": v, "id": slug(given.get(v) or v), "count": n} for v, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    by_norm: dict[str, list[str]] = {}
    for v in counts:
        by_norm.setdefault(SEP.sub("", v.lower()), []).append(v)
    conflicts = [{"values": vs, "reason": "differ only by case or spacing"} for vs in by_norm.values() if len(vs) > 1]
    ids = Counter(c["id"] for c in out)
    merged = [k for k, n in ids.items() if n > 1]
    ev = {
        "column": column,
        "distinct": len(counts),
        "filled": sum(counts.values()),
        "total": len(rows),
        "examples": [v for v, _ in counts.most_common(3)],
        "conflicts": conflicts,
        "merged": merged,
        "summary": f"“{column}” → {len({c['id'] for c in out})} label classes: {', '.join(list(dict.fromkeys(c['id'] for c in out))[:5])}",
    }
    return ev, out


def best_label_column(names: list[str], profile: dict, key_column: str | None) -> str | None:
    cats = [c for c in profile.get("columns") or [] if c.get("type") == "category" and c.get("name") != key_column and 2 <= int(c.get("distinct") or 0) <= 50]
    if not cats:
        return None
    hinted = [c for c in cats if LABEL_HINT.search(c["name"])]
    return (hinted or cats)[0]["name"] if (hinted or cats)[0]["name"] in names else None


# ---- Proposals the assistant makes ---------------------------------------------------------------


def _agent_table(db: Session, p: ProjectRow, node_id: str) -> SourceNode:
    n = db.get(SourceNode, node_id)
    if n is None or n.project_id != p.id:
        raise HTTPException(404, "no such file in this project")
    if n.detected_kind != "table":
        raise HTTPException(422, f"{n.name} isn't a table")
    return n


def from_agent(db: Session, p: ProjectRow, kind: str, payload: dict, evidence: dict) -> tuple[dict, dict, str | None]:
    """The assistant's relationship or schema proposal in the shape Explore reads, with evidence the
    kernel computes (never the model's own counts). Returns (payload, evidence, strength or None to
    keep the one asked for). Other kinds and payloads already in the kernel's shape pass through."""
    reason = str(evidence.get("reason") or "")[:2000]
    if kind == "relationship" and isinstance(payload.get("from"), dict) and "tableNodeId" not in payload:
        t = _agent_table(db, p, str(payload["from"].get("nodeId") or ""))
        names, rows = table_rows(db, t)
        column = str(payload["from"].get("column") or "")
        to = db.get(SourceNode, str((payload.get("to") or {}).get("nodeId") or ""))
        targets = Targets(db, p)
        ranked = [tg for tg in (("folders", "files") if to is not None and to.is_dir else ("files", "folders"))]
        best = None
        for target in ranked:
            for rule in ("normalized", "numeric", "exact"):
                if rule == "numeric" and not numeric_like([_cell(r, names.index(column)) for r in rows] if column in names else []):
                    continue
                ev = match(names, rows, targets, column, target, rule)
                if best is None or (ev["matched"], -ev["ambiguous"]) > (best["matched"], -best["ambiguous"]):
                    best = ev
        assert best is not None
        out = {"tableNodeId": t.id, "table": t.name, "column": column, "target": best["target"], "rule": best["rule"], "resolutions": {}, "summary": _summary_rel(t.name, best), "assistantRule": str(payload.get("rule") or "")[:500]}
        return out, {**best, "summary": out["summary"], "reason": reason}, best["strength"]
    if kind == "mapping" and "nodeId" in payload and "tableNodeId" not in payload:
        t = _agent_table(db, p, str(payload.get("nodeId") or ""))
        names, rows = table_rows(db, t)
        cols = [c for c in payload.get("columns") or [] if isinstance(c, dict)]
        label = next((str(c.get("name")) for c in cols if LABEL_HINT.search(str(c.get("role") or ""))), None)
        if label is None:
            raise HTTPException(422, "say which column holds the labels (a column whose role is 'label')")
        ev, classes = mapping_evidence(names, rows, label)
        out = {"tableNodeId": t.id, "table": t.name, "column": label, "field": "label classes", "classes": classes, "summary": ev["summary"], "columns": cols}
        return out, {**ev, "reason": reason}, None
    return payload, evidence, None


# ---- Building proposals after inspection ---------------------------------------------------------


def _dataset_nodes(db: Session, files: list[SourceNode], kind_of) -> list[str]:
    """Folders that hold only the dataset's kind (and nothing else), else the files themselves."""
    by_parent: dict[str, list[SourceNode]] = {}
    for f in files:
        by_parent.setdefault(f.parent_id or "", []).append(f)
    out: list[str] = []
    for parent, members in by_parent.items():
        folder = db.get(SourceNode, parent) if parent else None
        under = tree.files_under(db, [parent]) if folder is not None and folder.parent_id is not None else []
        if under and len(under) == len(members) and all(kind_of(n) for n in under):
            out.append(parent)
        else:
            out.extend(f.id for f in members)
    return out


def _main_kind(files: list[SourceNode]) -> str | None:
    def k(n: SourceNode) -> str:
        if n.detected_kind == "dicom" and (n.facts or {}).get("series", {}).get("sliceCount", 1) > 1:
            return "dicom-series"
        return n.detected_kind or ""

    counts = Counter(k(n) for n in files if k(n) in PRESETS)
    return counts.most_common(1)[0][0] if counts else None


def build_proposals(db: Session, ctx: RequestContext, p: ProjectRow, s: ImportSession) -> list[Proposal]:
    """Relationship, mapping and dataset proposals for what an import brought (created by
    `worker:inspect`, because they come from its report)."""
    files = list(db.scalars(select(SourceNode).where(SourceNode.import_session_id == s.id, SourceNode.is_dir.is_(False))))
    created: list[Proposal] = []
    targets = Targets(db, p)
    relationship = mapping = None
    label_table = None
    for t in [n for n in files if n.detected_kind == "table" and (n.facts or {}).get("table", {}).get("rowCount")]:
        names, rows = table_rows(db, t)
        if not rows:
            continue
        profile = t.facts["table"]
        ev = best_relationship(names, rows, targets, profile)
        if ev is None:
            continue
        payload = {"tableNodeId": t.id, "table": t.name, "column": ev["column"], "target": ev["target"], "rule": ev["rule"], "resolutions": {}, "summary": _summary_rel(t.name, ev)}
        rel = projects.create_proposal(db, ctx, p, "relationship", payload, {**ev, "summary": payload["summary"]}, ev["strength"], INSPECTOR, import_session_id=s.id)
        created.append(rel)
        col = best_label_column(names, profile, ev["column"])
        if col is not None:
            mev, classes = mapping_evidence(names, rows, col)
            hinted = bool(LABEL_HINT.search(col)) and not mev["conflicts"]
            mp = projects.create_proposal(db, ctx, p, "mapping", {"tableNodeId": t.id, "table": t.name, "column": col, "field": "label classes", "classes": classes, "relationshipProposalId": rel.id, "summary": mev["summary"]}, mev, "strong" if hinted else "possible", INSPECTOR, import_session_id=s.id)
            created.append(mp)
            if relationship is None:
                relationship, mapping, label_table = rel, mp, t
    viewable = [n for n in files if (n.detected_kind or "") in VIEWABLE]
    kind = _main_kind(viewable)
    if kind is not None:
        main = [n for n in viewable if (_main_kind([n]) == kind)]
        node_ids = _dataset_nodes(db, main, lambda n: _main_kind([n]) == kind)
        source = db.get(Source, s.source_id)
        one, many = NOUNS.get(kind, ("item", "items"))
        items = len({(n.facts or {}).get("series", {}).get("seriesUidHash") for n in main}) if kind == "dicom-series" else len(main)
        noun = one if items == 1 else many
        summary = f"Looks like {items} {noun}" + (f" with labels from {label_table.name}" if label_table is not None else "")
        title = (source.title if source else None) or "New dataset"
        payload = {
            "title": title,
            "nodeIds": node_ids,
            "kind": kind,
            "preset": PRESETS[kind],
            "taskTitle": "Classify" if mapping is not None else "Annotate",
            "taskKind": "classification" if mapping is not None else "annotate",
            "relationshipProposalId": relationship.id if relationship else None,
            "mappingProposalId": mapping.id if mapping else None,
            "itemCount": items,
            "summary": summary,
        }
        strength = "strong" if len({_main_kind([n]) for n in viewable}) == 1 else "possible"
        created.append(projects.create_proposal(db, ctx, p, "dataset", payload, {"items": items, "kind": kind, "otherFiles": len(files) - len(main), "summary": summary}, strength, INSPECTOR, import_session_id=s.id))
    return created


# ---- Edits a person makes before confirming --------------------------------------------------------


def _table_of(db: Session, p: ProjectRow, pr: Proposal) -> tuple[SourceNode, list[str], list[list[str]]]:
    n = db.get(SourceNode, str((pr.payload or {}).get("tableNodeId") or ""))
    if n is None or n.project_id != p.id:
        raise HTTPException(409, "the table this proposal reads is gone")
    names, rows = table_rows(db, n)
    return n, names, rows


def recompute(db: Session, ctx: RequestContext, p: ProjectRow, pr: Proposal, body: dict) -> Proposal:
    """A relationship with another column, target or ID rule, or with row fixes; a mapping with
    another column or renamed classes. The kernel recomputes the evidence; nothing is applied."""
    if pr.status != "proposed":
        raise HTTPException(409, f"this proposal is already {pr.status}")
    if ctx.scopes and not ctx.allows("proposals.write"):
        raise HTTPException(403, "this session can't change proposals")
    payload = dict(pr.payload or {})
    if pr.kind == "relationship":
        t, names, rows = _table_of(db, p, pr)
        column = str(body.get("column") or payload.get("column") or "")
        target = str(body.get("target") or payload.get("target") or "files")
        rule = str(body.get("rule") or payload.get("rule") or "normalized")
        resolutions = dict(payload.get("resolutions") or {})
        if column != payload.get("column") or target != payload.get("target") or rule != payload.get("rule"):
            resolutions = {}  # row fixes were for the old comparison
        targets = Targets(db, p)
        for row, fix in (body.get("resolutions") or {}).items() if isinstance(body.get("resolutions"), dict) else []:
            if fix is None:
                resolutions.pop(str(row), None)
            elif fix == "skip" or fix in targets.nodes:
                resolutions[str(row)] = fix
            else:
                raise HTTPException(422, f"row {row}: pick a file or folder of this project, or skip it")
        ev = match(names, rows, targets, column, target, rule, resolutions)
        payload.update({"column": column, "target": target, "rule": rule, "resolutions": resolutions, "summary": _summary_rel(t.name, ev)})
        pr.payload, pr.evidence, pr.strength = payload, {**ev, "summary": payload["summary"]}, ev["strength"]
    elif pr.kind == "mapping":
        _, names, rows = _table_of(db, p, pr)
        column = str(body.get("column") or payload.get("column") or "")
        classes = body.get("classes") if isinstance(body.get("classes"), list) else (payload.get("classes") if column == payload.get("column") else None)
        ev, out = mapping_evidence(names, rows, column, classes)
        payload.update({"column": column, "classes": out, "summary": ev["summary"]})
        pr.payload, pr.evidence = payload, ev
        pr.strength = "strong" if LABEL_HINT.search(column) and not ev["conflicts"] else "possible"
    elif pr.kind == "dataset":
        if "title" in body:
            title = str(body.get("title") or "").strip()[:256]
            if not title:
                raise HTTPException(422, "a dataset needs a name")
            payload["title"] = title
        if "taskTitle" in body:
            payload["taskTitle"] = str(body.get("taskTitle") or "").strip()[:256] or payload.get("taskTitle")
        pr.payload = payload
    else:
        raise HTTPException(422, f"a {pr.kind} proposal has nothing to recompute")
    db.flush()
    events.publish(db, ctx.for_scope(p.id, None), "proposal.created", {"projectId": p.id, "proposalId": pr.id, "kind": pr.kind, "updated": True}, source="kernel")
    return pr


# ---- Confirming a dataset proposal -----------------------------------------------------------------


def _linked(db: Session, p: ProjectRow, pr: Proposal, key: str) -> Proposal | None:
    pid = (pr.payload or {}).get(key)
    other = db.get(Proposal, pid) if pid else None
    return other if other is not None and other.project_id == p.id and other.status in ("proposed", "confirmed") else None


def _labels(db: Session, p: ProjectRow, pr: Proposal, files: list[SourceNode]) -> tuple[list[dict], dict[str, tuple[str, int]], SourceNode | None]:
    """(label classes, file node id → (class id, table row), table) from the linked proposals' current state."""
    rel, mp = _linked(db, p, pr, "relationshipProposalId"), _linked(db, p, pr, "mappingProposalId")
    if rel is None or mp is None:
        return [], {}, None
    t, names, rows = _table_of(db, p, mp)
    column = (mp.payload or {}).get("column")
    if column not in names:
        return [], {}, None
    ci = names.index(column)
    by_value = {c["value"]: c["id"] for c in (mp.payload or {}).get("classes") or []}
    classes = list(dict.fromkeys(by_value.values()))
    in_dataset = {f.id for f in files}
    targets = Targets(db, p)
    out: dict[str, tuple[str, int]] = {}
    for row, node in (rel.evidence or {}).get("links") or []:
        if not isinstance(row, int) or row >= len(rows):
            continue
        cls = by_value.get(_cell(rows[row], ci))
        if not cls:
            continue
        for fid in targets.file_ids(node):
            if fid in in_dataset:
                out.setdefault(fid, (cls, row))
    return classes, out, t


def preview(db: Session, ctx: RequestContext, p: ProjectRow, pr: Proposal) -> dict:
    """What confirming a dataset proposal will do (the action preview), from current state."""
    if pr.kind != "dataset":
        return {"proposal": projects.proposal_dict(pr)}
    payload = pr.payload or {}
    files = [n for n in tree.files_under(db, payload.get("nodeIds") or []) if _main_kind([n]) == payload.get("kind")]
    held = [n for n in files if tree.status_of(n) == "privacy"]
    classes, labels, table = _labels(db, p, pr, files)
    also = [projects.proposal_dict(x) for x in (_linked(db, p, pr, "relationshipProposalId"), _linked(db, p, pr, "mappingProposalId")) if x is not None and x.status == "proposed"]
    groups = Counter(labels[f.id][0] for f in files if f.id in labels)
    blocking = []
    if table is not None and labels and tree.status_of(table) == "privacy":
        blocking.append({"nodeId": table.id, "reason": f"{table.name} is held for privacy review: clear it in Sources before importing its labels"})
    return {
        "proposal": projects.proposal_dict(pr),
        "title": payload.get("title"),
        "taskTitle": payload.get("taskTitle"),
        "preset": payload.get("preset"),
        "kind": payload.get("kind"),
        "files": len(files),
        "heldFiles": len(held),
        "items": payload.get("itemCount") or len(files),
        "grouping": "by label" if labels else "one item per file" if payload.get("kind") != "dicom-series" else "one item per series",
        "groups": [{"label": k, "count": v} for k, v in groups.most_common()],
        "labelClasses": classes,
        "importedLabels": len(labels),
        "labelsFrom": table.name if table is not None and labels else None,
        "alsoConfirms": also,
        "blocking": blocking,
        "examples": [{"nodeId": f.id, "name": f.name, "label": labels.get(f.id, (None,))[0]} for f in files[:5]],
    }


def _confirm_dataset(db: Session, ctx: RequestContext, p: ProjectRow, pr: Proposal) -> dict:
    payload = pr.payload or {}
    info = preview(db, ctx, p, pr)
    if info["blocking"]:
        raise HTTPException(409, info["blocking"][0]["reason"])
    files = [n for n in tree.files_under(db, payload.get("nodeIds") or []) if _main_kind([n]) == payload.get("kind")]
    if not files:
        raise HTTPException(409, "the files this dataset was built from are gone")
    classes, labels, table = _labels(db, p, pr, files)
    preset = str(payload.get("preset") or "preset:image-2d")
    task_kind = "classification" if classes else str(payload.get("taskKind") or "annotate")
    definition: dict[str, Any] = {"nodeIds": payload.get("nodeIds") or [], "kind": payload.get("kind"), "preset": preset, "grouping": info["grouping"]}
    if labels:
        definition["labels"] = {fid: cls for fid, (cls, _) in labels.items()}
        definition["labelsFrom"] = {"nodeId": table.id if table else None, "proposalId": payload.get("mappingProposalId")}
    d = projects.create_dataset(db, ctx, p, str(payload.get("title") or "Dataset"), definition, proposal_id=pr.id)
    env: dict[str, Any] = {"extends": preset}
    if classes:
        env["task"] = "classification"
        groups = projects.label_groups(classes, "classification")
        for g in groups:
            g["classes"] = [{"id": c["id"], "color": CHART[i % len(CHART)]} for i, c in enumerate(g["classes"])]
        env["labels"] = groups
    t = projects.create_task(db, ctx, d, str(payload.get("taskTitle") or d.title), task_kind, env)
    imported = 0
    if labels and table is not None:
        imported = _import_labels(db, ctx, p, t, pr, files, labels, table)
    # The relationship and mapping it stands on are confirmed with it (the preview said so).
    for key in ("relationshipProposalId", "mappingProposalId"):
        other = _linked(db, p, pr, key)
        if other is not None and other.status == "proposed":
            other.status, other.decided_by, other.decided_at = "confirmed", ctx.principal, now()
            audit.record(db, ctx.for_scope(p.id, None), "proposal.confirmed", target=other.id, after={"kind": other.kind, "with": pr.id})
            events.publish(db, ctx.for_scope(p.id, None), "proposal.decided", {"projectId": p.id, "proposalId": other.id, "status": "confirmed"}, source="kernel")
    if pr.import_session_id:
        s = db.get(ImportSession, pr.import_session_id)
        if s is not None and s.state in ("ready", "needs_review"):
            s.state = "imported"
    db.flush()
    return {"dataset": projects.dataset_dict(db, d), "task": projects.task_dict(db, t), "importedLabels": imported}


def _import_labels(db: Session, ctx: RequestContext, p: ProjectRow, t: TaskRow, pr: Proposal, files: list[SourceNode], labels: dict[str, tuple[str, int]], table: SourceNode) -> int:
    """The table's labels as `imported` class annotations (todo6 D8): unreviewed until a person
    accepts them. The item id is the one the Studio's data kinds use (the asset path)."""
    at = now().isoformat()
    out = []
    for f in files:
        if f.id not in labels or f.asset_id is None:
            continue
        a = db.get(Asset, f.asset_id)
        if a is None:
            continue
        cls, row = labels[f.id]
        out.append({
            "id": uuid.uuid5(uuid.NAMESPACE_URL, f"{pr.id}/{f.id}").hex,
            "itemId": a.path,
            "label": cls,
            "geometry": {"type": "class"},
            "provenance": "imported",
            "author": ctx.principal,
            "createdAt": at,
            "attributes": {"source_file": table.name, "source_node": table.id, "source_row": row + 1, "review_status": "pending"},
        })
    if out:
        annotations.commit(db, ctx.for_scope(p.id, t.id), out, idempotency_key=f"proposal:{pr.id}:labels", source="explore.import-labels")
    return len(out)


projects.CONFIRM_EFFECTS["dataset"] = _confirm_dataset
projects.CONFIRM_EFFECTS["task"] = _confirm_dataset


# ---- The Summary tab and the Quality list ----------------------------------------------------------


def summary(db: Session, p: ProjectRow) -> dict:
    """Files → records → tasks (docs/ux.md §7), plus the quality list. Counts are rows, never guesses."""
    from .overview import kind_label

    files = list(db.scalars(select(SourceNode).where(SourceNode.project_id == p.id, SourceNode.is_dir.is_(False))))
    by_kind = Counter(n.detected_kind or "checking" for n in files)
    proposals = list(db.scalars(select(Proposal).where(Proposal.project_id == p.id).order_by(Proposal.created_at)))
    open_ = [x for x in proposals if x.status == "proposed"]
    records: list[dict] = []
    for g in [x for x in proposals if x.kind == "group" and x.status in ("proposed", "confirmed")]:
        records.append({"id": f"proposal:{g.id}", "type": "series", "title": str((g.payload or {}).get("seriesDescription") or (g.payload or {}).get("modalityLabel") or "DICOM series"), "detail": (g.payload or {}).get("summary"), "status": g.status, "proposalId": g.id, "strength": g.strength})
    for t in [n for n in files if n.detected_kind == "table"]:
        tf = (t.facts or {}).get("table") or {}
        records.append({"id": f"node:{t.id}", "type": "table", "title": t.name, "detail": f"{tf.get('rowCount', 0):,} rows · {tf.get('columnCount', len(tf.get('columns') or [])):,} columns", "status": "detected", "nodeId": t.id})
    docs = [n for n in files if n.detected_kind == "document"]
    if docs:
        records.append({"id": "documents", "type": "documents", "title": f"{len(docs)} {'document' if len(docs) == 1 else 'documents'}", "detail": ", ".join(n.name for n in docs[:3]), "status": "detected", "nodeId": docs[0].id})
    loose = Counter((n.parent_id, n.detected_kind) for n in files if n.detected_kind in ("image", "video", "volume", "mask", "waveform", "slide") or (n.detected_kind == "dicom" and not (n.facts or {}).get("series")))
    parents = {n.id: n for n in db.scalars(select(SourceNode).where(SourceNode.id.in_([k[0] for k in loose if k[0]])))} if loose else {}
    for (parent, kind), count in loose.most_common(8):
        folder = parents.get(parent or "")
        where = folder.name if folder is not None and folder.parent_id is not None else "the top folder"
        records.append({"id": f"files:{parent}:{kind}", "type": "files", "title": f"{count} {kind_label(kind, count).lower()}", "detail": f"in {where}", "status": "detected", "nodeId": parent})
    tasks: list[dict] = []
    for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at)):
        for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id).order_by(TaskRow.created_at)):
            tasks.append({"id": f"task:{t.id}", "title": t.title, "detail": f"{d.title} · {t.kind.replace('-', ' ')}", "status": "confirmed", "taskId": t.id, "datasetId": d.id})
    for x in [x for x in open_ if x.kind in ("dataset", "task")]:
        tasks.append({"id": f"proposal:{x.id}", "title": str((x.payload or {}).get("title") or "New dataset"), "detail": (x.payload or {}).get("summary"), "status": "proposed", "proposalId": x.id, "strength": x.strength})
    quality = quality_items(db, p, files, proposals)
    ready = [x for x in open_ if x.kind == "dataset"]
    clean = bool(ready) and len(open_) == len(ready) and not [q for q in quality if q["severity"] != "low"]
    out = {
        "files": {"total": len(files), "byKind": [{"kind": k, "label": kind_label(k if k != "checking" else None, n) if k != "checking" else "Checking…", "count": n} for k, n in by_kind.most_common()], "facts": _fact_lines(files)},
        "records": records,
        "tasks": tasks,
        "quality": quality,
        "clean": clean,
        "openProposals": len(open_),
    }
    if clean:
        out["readyProposalId"] = ready[0].id
    return out


def _fact_lines(files: list[SourceNode]) -> list[str]:
    """A few detected facts in the solid "Detected" style (`DICOM · MR · 256×256`)."""
    seen: Counter = Counter()
    for n in files:
        f = n.facts or {}
        if not f.get("format"):
            continue  # unreadable files are in the Quality list, not "Detected"
        parts = [str(f["format"])]
        if f.get("dicom", {}).get("modality"):
            parts.append(f["dicom"]["modality"])
        if f.get("width") and f.get("height"):
            parts.append(f"{f['width']}×{f['height']}")
        if f.get("series", {}).get("sliceCount", 0) > 1:
            parts.append(f"{f['series']['sliceCount']} slices")
        if f.get("video", {}).get("codec"):
            parts.append(str(f["video"]["codec"]))
        line = " · ".join(p for p in parts if p)
        if line:
            seen[line] += 1
    return [f"{line} ({n})" if n > 1 else line for line, n in seen.most_common(8)]


def quality_items(db: Session, p: ProjectRow, files: list[SourceNode], proposals: list[Proposal]) -> list[dict]:
    """Missing values, duplicates, mismatched IDs, unsupported files, series gaps and privacy
    holds, each linking to the exact node or proposal row."""
    out: list[dict] = []
    for n in files:
        flags = n.flags or {}
        priv = flags.get("privacy")
        if priv and not priv.get("clearedBy"):
            out.append({"id": f"privacy:{n.id}", "type": "privacy", "severity": "high", "title": "Held for privacy review", "detail": f"{n.name}: {priv.get('reason')}", "target": {"section": "sources", "nodeId": n.id}})
    for n in files:
        if n.detected_kind == "unknown" or (n.flags or {}).get("unsupported"):
            out.append({"id": f"unsupported:{n.id}", "type": "unsupported", "severity": "low", "title": "We can't read this file yet", "detail": n.name, "target": {"section": "sources", "nodeId": n.id}})
    for n in files:
        dup = (n.flags or {}).get("duplicate_of")
        if dup:
            out.append({"id": f"duplicate:{n.id}", "type": "duplicate", "severity": "low", "title": "Duplicate file", "detail": f"{n.name} has the same bytes as {dup.get('name')}", "target": {"section": "sources", "nodeId": n.id}})
    for g in [x for x in proposals if x.kind == "group" and x.status != "dismissed"]:
        for q in (g.evidence or {}).get("quality") or []:
            ids = (g.payload or {}).get("nodeIds") or []
            out.append({"id": f"series:{g.id}:{q[:20]}", "type": "series", "severity": "medium", "title": q, "detail": str((g.payload or {}).get("summary") or ""), "target": {"section": "sources", "nodeId": ids[0]} if ids else {"section": "explore", "tab": "summary", "proposalId": g.id}})
    for r in [x for x in proposals if x.kind == "relationship" and x.status == "proposed"]:
        ev = r.evidence or {}
        if ev.get("unmatched"):
            out.append({"id": f"unmatched:{r.id}", "type": "mismatch", "severity": "medium", "title": f"{ev['unmatched']} {'row has' if ev['unmatched'] == 1 else 'rows have'} no matching file", "detail": str((r.payload or {}).get("summary") or ""), "target": {"section": "explore", "tab": "relationships", "proposalId": r.id}})
        if ev.get("ambiguous"):
            out.append({"id": f"ambiguous:{r.id}", "type": "mismatch", "severity": "medium", "title": f"{ev['ambiguous']} {'row matches' if ev['ambiguous'] == 1 else 'rows match'} more than one file", "detail": str((r.payload or {}).get("summary") or ""), "target": {"section": "explore", "tab": "relationships", "proposalId": r.id}})
        if ev.get("repeatedIds"):
            out.append({"id": f"repeated:{r.id}", "type": "duplicate", "severity": "low", "title": f"{ev['repeatedIds']} {'id appears' if ev['repeatedIds'] == 1 else 'ids appear'} on more than one row", "detail": str((r.payload or {}).get("table") or ""), "target": {"section": "explore", "tab": "relationships", "proposalId": r.id}})
    for t in [n for n in files if n.detected_kind == "table"]:
        for c in ((t.facts or {}).get("table") or {}).get("columns") or []:
            missing = int(c.get("total") or 0) - int(c.get("filled") or 0)
            if missing > 0:
                out.append({"id": f"missing:{t.id}:{c['name']}", "type": "missing", "severity": "low", "title": f"{missing} missing {'value' if missing == 1 else 'values'} in “{c['name']}”", "detail": t.name, "target": {"section": "sources", "nodeId": t.id}})
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda q: order[q["severity"]])
    return out
