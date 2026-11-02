"""Drop classification (todo13 §3.3, D5, D6): pure functions from inspected files to groups and
a `DropPlan`. No database, no I/O: `kernel/drops_plan.py` gathers the inputs and stores the
result, so every rule here has a table test (`tests/test_drops_classify.py`).

Inputs are technical only: a node id, its detected kind, the kind its extension suggests,
inspection facts and kernel-written flags. Never a file name, a cell value or pixels: a table
"matches" a collection by the worker's name-column count (`facts.table.nameColumns`, columns
whose values look like the drop's file names), not by reading its values here.

Rules, in order (the first that applies wins for a file):

| Group | Default action |
|---|---|
| Already in Files (same SHA-256)                     | link_existing |
| Unknown, unsupported, audio or failed inspection    | keep_unsupported (offer: Find a plugin) |
| Archive                                             | unpack (then classified again as a child drop) |
| Document (PDF, DOCX, TXT, MD), annotation files     | keep_reference (offer: attach as documentation) |
| Table with a name column, and a viewable collection | new_collection, asks "labels for <collection>?" |
| Table, no match                                     | new tabular collection (asks if the dataset has other kinds) |
| DICOM with a series                                 | grouped by modality into `dicom-series`, then as viewable |
| Viewable, same kind and shape as a collection       | add_to_collection |
| Viewable, no match, current dataset a draft (own)   | new_collection in it |
| Viewable, no current dataset, or it's published     | new_dataset (further viewable groups: collections in it) |

A privacy hold never changes the action (the card adds a quarantine notice); a file whose
extension disagrees with its content is classified by content and counted as `spoofed`.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

# What a Studio can open (kinds.VIEWABLE, kept import-free so this module stays pure).
VIEWABLE = frozenset({"image", "dicom", "dicom-series", "volume", "video", "waveform", "slide", "mask"})
REFERENCE = frozenset({"document", "annotations"})
UNSUPPORTED = frozenset({"unknown", "audio"})

NAMES = {
    "image": "Images",
    "dicom": "DICOM images",
    "dicom-series": "DICOM series",
    "volume": "3D volumes",
    "mask": "Masks",
    "video": "Videos",
    "waveform": "Waveforms",
    "slide": "Whole-slide images",
    "table": "Tables",
    "document": "Documents",
    "annotations": "Annotation files",
    "archive": "Archives",
    "unknown": "Files we can't read yet",
    "audio": "Audio",
}


@dataclass
class FileIn:
    node_id: str
    kind: str | None  # detected kind; None = not inspected (yet) or failed
    ext_kind: str | None = None  # the kind its extension suggests (kinds.kind_from_extension)
    facts: dict = field(default_factory=dict)
    flags: dict = field(default_factory=dict)
    existing: bool = False  # the same bytes were already in Files before this drop
    # A WFDB signal file (.mat/.dat): the node id of the header (.hea) whose record it holds.
    # The gatherer pairs them (same folder, same drop); the file joins that header's group as a
    # part of its recording, not an item of its own and not "can't use yet".
    part_of: str | None = None


@dataclass
class CollectionIn:
    id: str
    name: str
    kind: str
    shape: dict = field(default_factory=dict)


@dataclass
class DatasetIn:
    id: str
    draft: bool
    own: bool  # the person who dropped made it (D14: auto-apply only on one's own drafts)
    collections: list[CollectionIn] = field(default_factory=list)


@dataclass
class Context:
    dataset: DatasetIn | None = None
    request: str | None = None


@dataclass
class Group:
    group_id: str
    kind: str
    node_ids: list[str]
    action: str
    shape: dict = field(default_factory=dict)
    held: int = 0
    existing: int = 0
    spoofed: int = 0
    # Resolved targets
    collection_id: str | None = None
    asks: str | None = None
    relates_to: str | None = None
    # Node ids (also in `node_ids`) that are parts of another file's item (WFDB signal files):
    # they go into the collection with it but don't count as items.
    parts: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.node_ids) - len(self.parts)

    def as_dict(self, with_nodes: bool = True) -> dict:
        out: dict[str, Any] = {"groupId": self.group_id, "kind": self.kind, "count": self.count, "suggestedAction": self.action}
        if self.shape:
            out["shape"] = dict(self.shape)
        if with_nodes:
            out["nodeIds"] = list(self.node_ids)
        for k in ("held", "existing", "spoofed"):
            if getattr(self, k):
                out[k] = getattr(self, k)
        return out


# ---- Per-file facts --------------------------------------------------------------------------


def _held(f: FileIn) -> bool:
    p = (f.flags or {}).get("privacy")
    return bool(p) and not (isinstance(p, dict) and p.get("clearedBy"))


def _failed(f: FileIn) -> bool:
    """Inspection failed or said it can't read the file (a viewable kind it couldn't open)."""
    return f.kind is None or bool((f.flags or {}).get("unsupported"))


def _spoofed(f: FileIn) -> bool:
    return bool(f.kind and f.ext_kind and f.ext_kind != "unknown" and f.kind not in ("unknown",) and f.ext_kind != f.kind and not (f.ext_kind == "dicom" and f.kind == "dicom"))


def _modality(f: FileIn) -> str | None:
    d = (f.facts or {}).get("dicom")
    m = (d or {}).get("modality") if isinstance(d, dict) else None
    m = m or (f.facts or {}).get("modality")
    return str(m)[:16].upper() if m else None


def _series(f: FileIn) -> str | None:
    s = (f.facts or {}).get("series")
    return str(s.get("seriesUidHash")) if isinstance(s, dict) and s.get("seriesUidHash") else None


def _table(f: FileIn) -> dict:
    t = (f.facts or {}).get("table")
    return t if isinstance(t, dict) else {}


def file_key(f: FileIn) -> tuple[str, str]:
    """(bucket, kind): which group a file goes to before collections are considered."""
    if f.existing or (f.flags or {}).get("duplicate_of"):
        return "existing", f.kind or "unknown"
    if _failed(f) or (f.kind or "unknown") in UNSUPPORTED:
        return f"unsupported:{f.kind or 'unknown'}", f.kind or "unknown"
    if f.kind == "archive":
        return "archive", "archive"
    if f.kind in REFERENCE:
        return f"reference:{f.kind}", f.kind
    if f.kind == "table":
        return "table", "table"
    if f.kind == "dicom" and _series(f):
        return f"viewable:dicom-series:{_modality(f) or ''}", "dicom-series"
    if f.kind == "dicom":
        return f"viewable:dicom:{_modality(f) or ''}", "dicom"
    if f.kind in VIEWABLE:
        return f"viewable:{f.kind}:", f.kind
    return f"unsupported:{f.kind or 'unknown'}", f.kind or "unknown"


def group_files(files: list[FileIn]) -> list[Group]:
    """Groups in a stable order (first appearance), each with its counts and shape."""
    buckets: OrderedDict[str, Group] = OrderedDict()
    series: dict[str, set[str]] = {}
    keys = {f.node_id: file_key(f) for f in files}
    parts: set[str] = set()
    for f in files:
        # A signal file joins its header's (viewable) group as a part of that recording.
        head = keys.get(f.part_of) if f.part_of else None
        if head is not None and head[0].startswith("viewable:") and not f.existing:
            keys[f.node_id] = head
            parts.add(f.node_id)
    for f in files:
        bucket, kind = keys[f.node_id]
        g = buckets.get(bucket)
        if g is None:
            gid = "g-" + bucket.replace("viewable:", "").replace(":", "-").rstrip("-").lower()
            g = buckets[bucket] = Group(group_id=gid, kind=kind, node_ids=[], action="")
            if kind in ("dicom-series", "dicom") and (m := _modality(f)):
                g.shape["modality"] = m
        g.node_ids.append(f.node_id)
        if f.node_id in parts:
            g.parts.append(f.node_id)
            continue
        g.held += _held(f)
        g.existing += bool(f.existing or (f.flags or {}).get("duplicate_of"))
        g.spoofed += _spoofed(f)
        if kind == "dicom-series" and (s := _series(f)):
            series.setdefault(bucket, set()).add(s)
        if kind == "table":
            t = _table(f)
            g.shape["columns"] = max(g.shape.get("columns", 0), int(t.get("columnCount") or len(t.get("columns") or [])))
            g.shape["nameColumns"] = g.shape.get("nameColumns", 0) + len(t.get("nameColumns") or [])
    for bucket, ids in series.items():
        buckets[bucket].shape["series"] = len(ids)
    return list(buckets.values())


# ---- Collections -----------------------------------------------------------------------------


def shape_matches(group: Group, c: CollectionIn) -> bool:
    """Same kind, and every shape key both sides have agrees (modality for DICOM)."""
    if group.kind != c.kind:
        return False
    for k in ("modality",):
        if k in group.shape and k in (c.shape or {}) and str(group.shape[k]).upper() != str(c.shape[k]).upper():
            return False
    return True


def classify(files: list[FileIn], ctx: Context) -> list[Group]:
    """Groups with their default action (§3.3) and resolved targets."""
    groups = group_files(files)
    ds = ctx.dataset
    viewable_in_drop = [g for g in groups if g.kind in VIEWABLE and not g.group_id.startswith("g-existing") and not g.group_id.startswith("g-unsupported")]
    new_dataset_taken = False
    for g in groups:
        if g.group_id.startswith("g-existing"):
            g.action = "link_existing"
        elif g.group_id.startswith("g-unsupported"):
            g.action = "keep_unsupported"
        elif g.kind == "archive":
            g.action = "unpack"
        elif g.kind in REFERENCE:
            g.action = "keep_reference"
        elif g.kind == "table":
            target = _labels_target(g, ds, viewable_in_drop)
            if target is not None:
                g.action, g.asks, g.relates_to = "new_collection", "labels_table", target
            elif ds is None and not viewable_in_drop:
                g.action = "new_dataset" if not new_dataset_taken else "new_collection"
                new_dataset_taken = True
            else:
                g.action = "new_collection"
                other_kinds = bool(viewable_in_drop) or bool(ds and any(c.kind != "table" for c in ds.collections))
                if other_kinds:
                    g.asks = "tabular_collection"
        elif g.kind in VIEWABLE:
            match = next((c for c in (ds.collections if ds else []) if shape_matches(g, c)), None)
            if match is not None:
                g.action, g.collection_id = "add_to_collection", match.id
            elif ds is not None and ds.draft:
                g.action = "new_collection"
            elif not new_dataset_taken:
                g.action, new_dataset_taken = "new_dataset", True
            else:
                g.action = "new_collection"  # in the dataset this plan creates
        else:
            g.action = "keep_unsupported"
    return groups


def _labels_target(g: Group, ds: DatasetIn | None, viewable_in_drop: list[Group]) -> str | None:
    """The collection a name-keyed table would describe: one in the current dataset, else a
    viewable group of the same drop (its group id; apply maps it to the collection it creates)."""
    if not g.shape.get("nameColumns"):
        return None
    if ds is not None:
        c = next((c for c in ds.collections if c.kind in VIEWABLE), None)
        if c is not None:
            return c.id
    return viewable_in_drop[0].group_id if viewable_in_drop else None


# ---- The plan --------------------------------------------------------------------------------


def _collection_name(kind: str, shape: dict) -> str:
    base = NAMES.get(kind, kind.capitalize())
    m = shape.get("modality")
    return f"{m} series" if kind == "dicom-series" and m else base


def plan(drop_id: str, groups: list[Group], ctx: Context, preset_for: Callable[[str], str | None] | None = None) -> dict:
    """The `DropPlan` (§5) for classified groups. `needsPerson` when any action asks a question
    or touches a dataset that isn't the person's own draft (D6, D14)."""
    ds = ctx.dataset
    actions: list[dict] = []
    needs = False
    for g in groups:
        a: dict[str, Any] = {"groupId": g.group_id, "type": g.action, "nodeIds": list(g.node_ids), "kind": g.kind, "count": g.count}
        if g.held:
            a["held"] = g.held
        if g.action in ("add_to_collection", "new_collection", "new_dataset") and preset_for and g.kind in VIEWABLE:
            if p := preset_for(g.kind):
                a["preset"] = p
        if g.action == "add_to_collection":
            assert ds is not None and g.collection_id
            a["datasetId"], a["collectionId"] = ds.id, g.collection_id
            if not (ds.draft and ds.own):
                needs = True
        elif g.action == "new_collection":
            a["name"] = _collection_name(g.kind, g.shape)
            if ds is not None:
                a["datasetId"] = ds.id
                if not (ds.draft and ds.own):
                    # A published dataset or someone else's: never changed without a click.
                    needs = True
                    a.setdefault("asks", "which_dataset")
        elif g.action == "new_dataset":
            a["name"] = _collection_name(g.kind, g.shape)
        elif g.action == "keep_reference":
            a["asks"] = "attach_documentation"
        elif g.action == "keep_unsupported":
            a["asks"] = "find_plugin"
            a["findPluginKind"] = g.kind
        if g.asks:
            a["asks"] = g.asks
            if g.asks in ("labels_table", "tabular_collection"):
                needs = True
        if g.relates_to:
            a["relatesTo"] = g.relates_to
        actions.append(a)
    return {"dropId": drop_id, "actions": actions, "needsPerson": needs}


# Offers that don't hold up an apply: the card shows them as links beside the action.
OFFERS = frozenset({"attach_documentation", "find_plugin"})


def safe_to_auto_apply(p: dict) -> bool:
    """D6: only plans that touch nothing but the person's own drafts (and Files)."""
    return not p.get("needsPerson") and all(a.get("asks") in (None, *OFFERS) for a in p.get("actions") or [])


def fast_path_kinds(groups: list[Group]) -> list[str]:
    """The kinds the fast path resolves a preset from: the viewable groups a new dataset gets."""
    return [g.kind for g in groups if g.action in ("new_dataset", "new_collection", "add_to_collection") and g.kind in VIEWABLE]
