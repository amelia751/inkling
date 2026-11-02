"""A dataset's profile (docs/datasets.md §11.1, Phase 1): what it holds and how it is shaped.

Read from the inspection of the file versions the dataset pins (`projects.pinned_view`), so it
describes one snapshot, the working draft. Collections are inferred one per detected kind and
stay `suggested` until a person confirms the dataset's structure (todo13 D8). Relationships come
from the project's relationship proposals on the dataset's tables. Issues come from the
kernel-written flags and the relationship evidence.

Boundary (AGENTS.md, docs/ux.md §8): no cell values, no column examples, no DICOM identifiers, no
file names or paths. Counts, kinds, formats, column names and types, technical facts, flag
reasons (kernel-written) and node ids only.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import DatasetRow, Proposal
from . import projects
from .kinds import VIEWABLE, wfdb_parts

RULES_VERSION = 1

# Plural collection names and the unit one item is counted in.
NAMES: dict[str, tuple[str, str, str]] = {
    "image": ("Images", "image", "images"),
    "dicom": ("DICOM images", "image", "images"),
    "dicom-series": ("DICOM series", "series", "series"),
    "volume": ("3D volumes", "volume", "volumes"),
    "mask": ("Masks", "mask", "masks"),
    "video": ("Videos", "video", "videos"),
    "waveform": ("Waveforms", "recording", "recordings"),
    "slide": ("Whole-slide images", "slide", "slides"),
    "table": ("Tables", "table", "tables"),
    "document": ("Documents", "document", "documents"),
    "annotations": ("Annotation files", "file", "files"),
    "archive": ("Archives", "archive", "archives"),
    "unknown": ("Files we can't read yet", "file", "files"),
}
# Most useful first (what a person came to label), then the rest.
ORDER = ["dicom-series", "dicom", "volume", "image", "video", "slide", "waveform", "mask", "table", "annotations", "document", "archive", "unknown"]
MAX_VALUES = 6
MAX_NODE_IDS = 50
COLOUR = {"L": "Grayscale", "I;16": "Grayscale (16-bit)", "I": "Grayscale (32-bit)", "RGB": "Colour", "RGBA": "Colour with transparency", "P": "Palette", "1": "Black and white"}


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _fmt(v: float) -> str:
    return f"{v:g}" if abs(v) < 1e6 else f"{v:.3g}"


def _duration(s: float) -> str:
    if s < 60:
        return f"{s:.1f} s".replace(".0 s", " s")
    m, sec = divmod(round(s), 60)
    return f"{m} min {sec:02d} s" if m < 60 else f"{m // 60} h {m % 60:02d} min"


def _dims(v: Any, unit: str = "") -> str | None:
    if isinstance(v, (list, tuple)) and v and all(_num(x) is not None for x in v):
        return " × ".join(_fmt(round(float(x), 3)) for x in v) + (f" {unit}" if unit else "")
    return None


def _shape_facts(kind: str, f: dict) -> dict[str, tuple[str, str | None]]:
    """(label, value) per fact key, plain words; a value of None means "not known"."""
    out: dict[str, tuple[str, str | None]] = {}
    w, h = _num(f.get("width")), _num(f.get("height"))
    dicom = d if isinstance(d := f.get("dicom"), dict) else {}
    video = v if isinstance(v := f.get("video"), dict) else {}
    if kind in ("image", "dicom", "dicom-series", "slide", "mask", "volume"):
        out["size"] = ("Image size", f"{int(w)} × {int(h)} px" if w and h else None)
    if kind == "image":
        mode = f.get("mode")
        out["colour"] = ("Colour", COLOUR.get(str(mode), str(mode)) if mode else None)
    if kind in ("dicom", "dicom-series"):
        mod = dicom.get("modality") or f.get("modality")
        out["modality"] = ("Modality", str(mod) if mod else None)
    if kind in ("dicom", "dicom-series", "volume", "mask"):
        out["spacing"] = ("Spacing", _dims(f.get("spacing") or dicom.get("spacing"), "mm"))
    if kind in ("volume", "mask"):
        out["shape"] = ("Array shape", _dims(f.get("shape")))
        out["dtype"] = ("Intensity type", str(f["dtype"]) if f.get("dtype") else None)
    if kind in ("dicom", "dicom-series", "image", "volume"):
        frames = _num(f.get("frames") or f.get("slices"))
        if frames:
            out["frames"] = ("Frames or slices", f"{int(frames)}")
    if kind == "video":
        vw, vh = _num(video.get("width") or f.get("width")), _num(video.get("height") or f.get("height"))
        out["size"] = ("Frame size", f"{int(vw)} × {int(vh)} px" if vw and vh else None)
        fps = _num(video.get("fps") or f.get("fps"))
        out["fps"] = ("Frame rate", f"{_fmt(round(fps, 2))} fps" if fps else None)
        out["codec"] = ("Codec", str(video["codec"]) if video.get("codec") else None)
    if kind == "slide":
        mpp, mag = _num(f.get("mpp")), _num(f.get("magnification"))
        out["mpp"] = ("Microns per pixel", _fmt(round(mpp, 4)) if mpp else None)
        out["magnification"] = ("Magnification", f"{_fmt(mag)}×" if mag else None)
    if kind == "table":
        t = tb if isinstance(tb := f.get("table"), dict) else {}
        cols = _num(t.get("columnCount")) or (len(t["columns"]) if isinstance(t.get("columns"), list) else None)
        out["columns"] = ("Columns", f"{int(cols)}" if cols else None)
        out["delimiter"] = ("Delimiter", str(t["delimiter"]) if t.get("delimiter") else None)
    return out


# Continuous facts are summarized as a range, not a distribution of every value.
RANGES: dict[str, tuple[str, str]] = {"duration": ("Duration", "s"), "rows": ("Rows", ""), "pages": ("Pages", "")}


def _range_value(key: str, kind: str, f: dict) -> float | None:
    if key == "duration" and kind in ("video", "waveform"):
        return _num((f.get("video") or {}).get("duration") if isinstance(f.get("video"), dict) else None) or _num(f.get("duration"))
    if key == "rows" and kind == "table":
        return _num((f.get("table") or {}).get("rowCount")) if isinstance(f.get("table"), dict) else None
    if key == "pages" and kind == "document":
        return _num(f.get("pages"))
    return None


def _field_type(key: str) -> tuple[str, str | None]:
    return {
        "size": ("text", "px"),
        "colour": ("category", None),
        "modality": ("category", None),
        "spacing": ("list", "mm"),
        "shape": ("list", None),
        "dtype": ("category", None),
        "frames": ("integer", None),
        "fps": ("decimal", "fps"),
        "codec": ("category", None),
        "mpp": ("decimal", "µm/px"),
        "magnification": ("decimal", "×"),
        "columns": ("integer", None),
        "delimiter": ("category", None),
        "duration": ("decimal", "s"),
        "rows": ("integer", None),
        "pages": ("integer", None),
    }.get(key, ("text", None))


class _Collection:
    def __init__(self, kind: str):
        self.kind = kind
        self.files = 0
        self.series: set[str] = set()
        self.loose = 0  # files not in a series (count one item each)
        self.formats: Counter = Counter()
        self.facts: dict[str, Counter] = defaultdict(Counter)
        self.fact_labels: dict[str, str] = {}
        self.fact_missing: Counter = Counter()
        self.ranges: dict[str, list[float]] = defaultdict(list)
        self.columns: dict[str, dict] = {}
        self.tables = 0
        self.preview: str | None = None
        self.flagged: set[str] = set()

    @property
    def count(self) -> int:
        return len(self.series) + self.loose


def _merge_columns(c: _Collection, table: dict) -> None:
    keys = set(table.get("candidateKeys") or [])
    c.tables += 1
    for col in table.get("columns") or []:
        if not isinstance(col, dict) or not col.get("name"):
            continue
        name = str(col["name"])[:200]
        m = c.columns.setdefault(name, {"types": Counter(), "filled": 0, "total": 0, "tables": 0, "keyIn": 0})
        m["types"][str(col.get("type") or "text")] += 1
        m["filled"] += int(col.get("filled") or 0)
        m["total"] += int(col.get("total") or 0)
        m["tables"] += 1
        m["keyIn"] += name in keys


def build(db: Session, d: DatasetRow) -> dict:
    pairs = projects.dataset_files(db, d, include_hidden=False)
    cols: dict[str, _Collection] = {}
    flags_by: dict[str, list[tuple[str, str, dict]]] = defaultdict(list)  # flag → (node id, collection, flag value)
    checking: list[str] = []
    table_nodes: dict[str, str] = {}
    # A WFDB header's signal files (.mat/.dat beside it) belong to its recording, not "can't read".
    signal_of = wfdb_parts([(n.id, n.parent_id, n.name) for n, _ in pairs])
    for n, ref in pairs:
        if n.id in signal_of:
            continue
        kind, facts, flags, *_ = projects.pinned_view(db, n, ref)
        if kind is None:
            checking.append(n.id)
            continue
        if kind == "dicom" and facts.get("series_uid_hash"):
            kind = "dicom-series"
        kind = kind if kind in NAMES else "unknown"
        c = cols.setdefault(kind, _Collection(kind))
        c.files += 1
        if kind == "dicom-series":
            c.series.add(str(facts["series_uid_hash"]))
        else:
            c.loose += 1
        if facts.get("format"):
            c.formats[str(facts["format"])] += 1
        for key, (label, value) in _shape_facts(kind, facts).items():
            c.fact_labels[key] = label
            if value is None:
                c.fact_missing[key] += 1
            else:
                c.facts[key][value] += 1
        for key in RANGES:
            v = _range_value(key, kind, facts)
            if v is not None:
                c.ranges[key].append(v)
        if kind == "table" and isinstance(facts.get("table"), dict):
            _merge_columns(c, facts["table"])
            table_nodes[n.id] = kind
        clean = not any(flags.get(k) for k in ("privacy", "unsupported", "quality", "duplicate_of"))
        if c.preview is None and clean and (kind in VIEWABLE or kind == "image"):
            c.preview = n.id
        for k in ("privacy", "unsupported", "quality", "duplicate_of"):
            if flags.get(k):
                flags_by[k].append((n.id, kind, flags[k]))
                c.flagged.add(n.id)

    collections = [_collection_dict(c) for c in sorted(cols.values(), key=lambda c: ORDER.index(c.kind))]
    relationships, identity = _relationships(db, d, table_nodes, cols)
    issues = _issues(flags_by, checking, identity)
    return {
        "datasetId": d.id,
        "snapshot": {"kind": "draft", "label": "Working draft", "readOnly": False},
        "files": len(pairs),
        "checking": len(checking),
        "collections": collections,
        "relationships": relationships,
        "issues": issues,
    }


def _collection_dict(c: _Collection) -> dict:
    name, one, other = NAMES[c.kind]
    count = c.count
    facts = []
    fields = []
    for key, counter in c.facts.items():
        ranked = counter.most_common()
        facts.append({"key": key, "label": c.fact_labels[key], "values": [{"value": v, "count": n} for v, n in ranked[:MAX_VALUES]], "more": max(0, len(ranked) - MAX_VALUES), "missing": c.fact_missing.get(key, 0)})
    for key in c.fact_missing:
        if key not in c.facts:
            facts.append({"key": key, "label": c.fact_labels[key], "values": [], "more": 0, "missing": c.fact_missing[key]})
    for key, values in c.ranges.items():
        label, unit = RANGES[key]
        lo, hi = min(values), max(values)
        show = (lambda v: _duration(v)) if key == "duration" else (lambda v: f"{int(v):,}")
        facts.append({"key": key, "label": label, "values": [{"value": show(lo) if lo == hi else f"{show(lo)} – {show(hi)}", "count": len(values)}], "more": 0, "missing": c.files - len(values)})
    for f in facts:
        t, unit = _field_type(f["key"])
        # Every file of the collection either has the fact or counts as missing.
        filled = (c.files - f["missing"]) / c.files if c.files else 0
        field = {"id": f"fact:{f['key']}", "name": f["label"], "type": t, "required": f["missing"] == 0, "filled": round(filled, 4), "source": "inspection"}
        if unit:
            field["unit"] = unit
        fields.append(field)
    for name_, m in c.columns.items():
        fields.append(
            {
                "id": f"col:{name_}",
                "name": name_,
                "type": m["types"].most_common(1)[0][0],
                "required": m["total"] > 0 and m["filled"] == m["total"] and m["tables"] == c.tables,
                "filled": round(m["filled"] / m["total"], 4) if m["total"] else 0,
                "key": m["keyIn"] == m["tables"] and m["keyIn"] > 0,
                "source": "inspection",
            }
        )
    return {
        "id": f"kind:{c.kind}",
        "name": name,
        "kind": c.kind,
        "count": count,
        "unit": {"one": one, "other": other},
        "files": c.files,
        "formats": [{"label": k, "count": v} for k, v in c.formats.most_common()],
        "facts": facts,
        "fields": fields,
        "previewNodeId": c.preview,
        "suggested": True,
        "issues": len(c.flagged),
    }


def _relationships(db: Session, d: DatasetRow, table_nodes: dict[str, str], cols: dict[str, _Collection]) -> tuple[list[dict], list[dict]]:
    """Relationship proposals on the dataset's tables, and the identity issues their evidence shows."""
    if not table_nodes:
        return [], []
    # The collection a table's rows point at: the largest viewable one (what a person labels).
    targets = [c for c in cols.values() if c.kind in VIEWABLE]
    to = max(targets, key=lambda c: c.count).kind if targets else None
    out: list[dict] = []
    identity: list[dict] = []
    rows = db.scalars(select(Proposal).where(Proposal.project_id == d.project_id, Proposal.kind == "relationship", Proposal.status.in_(("proposed", "confirmed"))).order_by(Proposal.created_at))
    for pr in rows:
        payload, ev = pr.payload or {}, pr.evidence or {}
        if payload.get("tableNodeId") not in table_nodes or to is None:
            continue
        folders = payload.get("target") == "folders"
        col = str(payload.get("column") or "a column")
        unit = NAMES[to][1]
        cov = {k: int(ev.get(k) or 0) for k in ("rows", "matched", "unmatched", "ambiguous")}
        out.append(
            {
                "id": f"rel:{pr.id}",
                "from": "kind:table",
                "to": f"kind:{to}",
                "label": f"Each table row describes a folder of {NAMES[to][2]}" if folders else f"Each table row describes one {unit}",
                "cardinality": "1:N" if folders else "1:1",
                "keys": f"{col} → {'folder' if folders else 'file'} name",
                "status": "confirmed" if pr.status == "confirmed" else "suggested",
                "coverage": cov,
                "strength": pr.strength,
                "proposalId": pr.id,
            }
        )
        missing = cov["unmatched"] + cov["ambiguous"]
        if missing:
            identity.append(
                {
                    "id": f"explore.relationship@{RULES_VERSION}:{pr.id}",
                    "category": "identity",
                    "severity": "medium",
                    "blocking": False,
                    "title": f"{missing:,} table {'row has' if missing == 1 else 'rows have'} no single matching {'folder' if folders else unit}",
                    "detail": f"{cov['unmatched']:,} not found, {cov['ambiguous']:,} could match more than one. Nothing is linked until a person picks.",
                    "count": missing,
                    "ruleId": f"explore.relationship@{RULES_VERSION}",
                    "collectionId": "kind:table",
                    "nodeIds": [str(payload["tableNodeId"])],
                    "action": {"label": "Inspect relationship", "target": {"section": "explore", "tab": "relationships", "proposalId": pr.id}},
                }
            )
    return out, identity


SEVERITY = {"high": 0, "medium": 1, "low": 2}


def _issues(flags_by: dict[str, list[tuple[str, str, dict]]], checking: list[str], identity: list[dict]) -> list[dict]:
    out: list[dict] = []

    def group(flag: str) -> dict[str, list[tuple[str, Any]]]:
        by: dict[str, list[tuple[str, Any]]] = defaultdict(list)
        for nid, kind, value in flags_by.get(flag, []):
            by[kind].append((nid, value))
        return by

    for kind, items in group("privacy").items():
        n = len(items)
        out.append(_issue("privacy", kind, "high", True, f"{n:,} {'file is' if n == 1 else 'files are'} held for privacy review", "Held files stay out of the Studio, exports and the assistant until someone clears them.", items, "Review held files", {"section": "sources", "status": "privacy"}))
    for kind, items in group("unsupported").items():
        n = len(items)
        out.append(_issue("unreadable", kind, "medium", False, f"{n:,} {'file' if n == 1 else 'files'} we can't read yet", _reasons(items) or "A plugin may add support for this format.", items, "Show in Sources", {"section": "sources", "status": "unsupported"}))
    for kind, items in group("quality").items():
        n = len(items)
        out.append(_issue("quality", kind, "medium", False, f"{n:,} {'file has' if n == 1 else 'files have'} quality warnings", _reasons(items) or "Inspection found something to check.", items, "Show in Sources", {"section": "sources", "status": "attention"}))
    for kind, items in group("duplicate_of").items():
        n = len(items)
        out.append(_issue("duplicate", kind, "low", False, f"{n:,} duplicate {'file' if n == 1 else 'files'}", "The same bytes were added more than once; the copies share one stored file.", items, "Show in Sources", {"section": "sources", "status": "attention"}))
    if checking:
        n = len(checking)
        out.append(_issue("checking", None, "low", False, f"{n:,} {'file is' if n == 1 else 'files are'} still being checked", "Their kind and shape appear here when inspection finishes.", [(i, None) for i in checking], "Show in Sources", {"section": "sources", "status": "checking"}))
    out += identity
    out.sort(key=lambda i: (not i["blocking"], SEVERITY[i["severity"]], -i["count"]))
    return out


def _reasons(items: list[tuple[str, Any]]) -> str:
    """The most common kernel-written reasons, in plain words (never a file name)."""
    c: Counter = Counter()
    for _, v in items:
        for r in v if isinstance(v, list) else [v] if isinstance(v, str) else []:
            c[str(r)[:160]] += 1
    return " · ".join(r for r, _ in c.most_common(3))


def _issue(category: str, kind: str | None, severity: str, blocking: bool, title: str, detail: str, items: list[tuple[str, Any]], label: str, target: dict) -> dict:
    rule = f"inspection.{category}@{RULES_VERSION}"
    return {
        "id": f"{rule}:{kind or 'all'}",
        "category": category,
        "severity": severity,
        "blocking": blocking,
        "title": title,
        "detail": detail,
        "count": len(items),
        "ruleId": rule,
        **({"collectionId": f"kind:{kind}"} if kind else {}),
        "nodeIds": [i for i, _ in items[:MAX_NODE_IDS]],
        "action": {"label": label, "target": target},
    }
