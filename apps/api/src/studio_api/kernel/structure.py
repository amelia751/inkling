"""`DatasetStructure v1` (todo13 D8): a dataset's collections, fields, relationships and
annotation definitions, as `structure.json` on its working draft.

Branches: `draft` is the person's working draft. An agent writes only its own `work/agent-*`
branch (`propose_structure`); the person accepts it into the draft (or, with
`API_FEATURE_AUTO_APPLY`, it's accepted for them when the dataset is their own draft, D6).
A published dataset's draft isn't edited in place: a write becomes a `structure` proposal a
person confirms.

Where it's stored: the kernel keeps every branch (`dataset_structures`). apps/versioning's commit
route accepts only `.studio/` paths today (`plugins.lock.json`, `tasks/*/…`), so
`structure.json` can't be committed to a dataset's tree yet; once todo12-versioning admits the
path, `VERSIONING_ACCEPTS_STRUCTURE` turns on the mirror: every draft write is also committed to
the dataset's work branch (a dataset without a repo gets one on its first write). Reported in the
todo13-organize hand-back.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path
from typing import Any

import jsonschema
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import DatasetCollectionRow, DatasetRow, DatasetStructureRow, now
from . import audit, drop_flags, projects
from .canonical import content_hash

DRAFT = "draft"
STRUCTURE_PATH = "structure.json"
# Flip when apps/versioning admits `structure.json` in a commit's tree (todo12-versioning).
VERSIONING_ACCEPTS_STRUCTURE = False
FIELD_TYPES = {"integer", "number", "decimal", "text", "category", "id", "date", "boolean", "list", "path", "empty"}


def empty() -> dict:
    return {"schemaVersion": 1, "collections": [], "relationships": [], "annotations": []}


@cache
def _schema_at(path: str) -> dict:
    return json.loads(Path(path).read_text())


def schema() -> dict:
    return _schema_at(str(Path(settings().repo_root) / "schemas" / "dataset-structure.v1.json"))


def validate(s: Any) -> list[dict]:
    """Errors as `{path, message}` (the emitted JSON Schema, then ids and references)."""
    errors = [{"path": "/" + "/".join(str(p) for p in e.absolute_path), "message": e.message[:300]} for e in jsonschema.Draft202012Validator(schema()).iter_errors(s)]
    if errors:
        return errors[:20]
    for part in ("collections", "relationships", "annotations"):
        seen: set[str] = set()
        for i, x in enumerate(s[part]):
            if x["id"] in seen:
                errors.append({"path": f"/{part}/{i}/id", "message": f"duplicate id {x['id']}"})
            seen.add(x["id"])
    cols = {c["id"] for c in s["collections"]}
    for i, r in enumerate(s["relationships"]):
        for end in ("from", "to"):
            if r[end] not in cols:
                errors.append({"path": f"/relationships/{i}/{end}", "message": f"no collection {r[end]}"})
    for i, a in enumerate(s["annotations"]):
        if a["collectionId"] not in cols:
            errors.append({"path": f"/annotations/{i}/collectionId", "message": f"no collection {a['collectionId']}"})
    return errors


def hash_of(s: dict) -> str:
    return content_hash(s)


def _row(db: Session, dataset_id: str, branch: str) -> DatasetStructureRow | None:
    return db.get(DatasetStructureRow, (dataset_id, branch))


def get(db: Session, d: DatasetRow, branch: str = DRAFT) -> dict:
    r = _row(db, d.id, branch)
    s = r.structure if r is not None else empty()
    return {"datasetId": d.id, "branch": branch, "structure": s, "hash": hash_of(s), "updatedBy": r.updated_by if r else None, "updatedAt": projects.iso(r.updated_at) if r else None, "storedIn": "versioning" if VERSIONING_ACCEPTS_STRUCTURE else "kernel"}


def _write(db: Session, ctx: RequestContext, d: DatasetRow, branch: str, s: dict) -> DatasetStructureRow:
    r = _row(db, d.id, branch)
    if r is None:
        r = DatasetStructureRow(dataset_id=d.id, branch=branch, project_id=d.project_id, structure=s, hash=hash_of(s), updated_by=ctx.principal, updated_at=now())
        db.add(r)
    else:
        r.structure, r.hash, r.updated_by, r.updated_at = s, hash_of(s), ctx.principal, now()
    db.flush()
    if branch == DRAFT and VERSIONING_ACCEPTS_STRUCTURE:
        _mirror(db, ctx, d, s)
    return r


def _mirror(db: Session, ctx: RequestContext, d: DatasetRow, s: dict) -> None:  # pragma: no cover - waits for versioning
    """Commit `structure.json` onto the dataset's work branch (a repo is made on first write)."""
    from .canonical import canonicalize
    from .versioning import service as vservice

    vservice.run(db, ctx, "dataset.create", d.id, {"name": d.title})
    files = {STRUCTURE_PATH: canonicalize(s)}
    vservice.run(db, ctx, "studio.commit", d.id, {"message": "Dataset structure", "files": files})


def agent_branch(ctx: RequestContext, d: DatasetRow) -> str:
    from .versioning.service import work_branch

    return work_branch(ctx, d.id)


def diff(base: dict, head: dict) -> list[dict]:
    """What changed from `base` to `head`, by stable id (never by position)."""
    out: list[dict] = []
    for part in ("collections", "relationships", "annotations"):
        a = {x["id"]: x for x in base.get(part) or []}
        b = {x["id"]: x for x in head.get(part) or []}
        for i in b.keys() - a.keys():
            out.append({"op": "add", "path": f"{part}/{i}"})
        for i in a.keys() - b.keys():
            out.append({"op": "remove", "path": f"{part}/{i}"})
        for i in a.keys() & b.keys():
            if a[i] == b[i]:
                continue
            if part == "annotations":
                la = {x["id"]: x for x in a[i].get("labels") or []}
                lb = {x["id"]: x for x in b[i].get("labels") or []}
                out += [{"op": "add", "path": f"{part}/{i}/labels/{x}"} for x in lb.keys() - la.keys()]
                out += [{"op": "remove", "path": f"{part}/{i}/labels/{x}"} for x in la.keys() - lb.keys()]
                out += [{"op": "change", "path": f"{part}/{i}/labels/{x}"} for x in la.keys() & lb.keys() if la[x] != lb[x]]
                if {k: v for k, v in a[i].items() if k != "labels"} != {k: v for k, v in b[i].items() if k != "labels"}:
                    out.append({"op": "change", "path": f"{part}/{i}"})
            else:
                out.append({"op": "change", "path": f"{part}/{i}"})
    return sorted(out, key=lambda e: (e["path"], e["op"]))


def put(db: Session, ctx: RequestContext, d: DatasetRow, s: Any, base_hash: str | None = None) -> tuple[int, dict]:
    """A person writes the draft; an agent writes its own branch and gets the diff back."""
    errors = validate(s)
    if errors:
        return 422, {"ok": False, "errors": errors}
    is_agent = ctx.principal.startswith("agent:")
    if is_agent:
        branch = agent_branch(ctx, d)
        _write(db, ctx, d, branch, s)
        draft = get(db, d)["structure"]
        audit.record(db, ctx.for_scope(d.project_id, None), "dataset.structure.proposed", target=d.id, after={"branch": branch, "changes": len(diff(draft, s))})
        out = {**get(db, d, branch), "diff": diff(draft, s)}
        if drop_flags.enabled("auto_apply") and projects.is_draft_dataset(db, d) and d.created_by == projects.person(ctx):
            # D6: the agent drafts structure on the person's own draft dataset; accepted for them.
            _write(db, ctx, d, DRAFT, s)
            out["accepted"] = True
        return 200, out
    current = get(db, d)
    if base_hash is not None and base_hash != current["hash"]:
        return 409, {"error": "the structure changed since you read it", "current": current}
    if not projects.is_draft_dataset(db, d):
        # A published dataset: the change waits for a person's confirmation (a proposal).
        p = projects.require_project(db, ctx, d.project_id, write=True)
        pr = projects.create_proposal(db, ctx, p, "structure", {"datasetId": d.id, "structure": s, "baseHash": current["hash"]}, {"changes": diff(current["structure"], s)[:200]}, "possible", ctx.principal)
        return 202, {"proposal": projects.proposal_dict(pr), "diff": diff(current["structure"], s)}
    _write(db, ctx, d, DRAFT, s)
    audit.record(db, ctx.for_scope(d.project_id, None), "dataset.structure.saved", target=d.id, after={"hash": hash_of(s), "changes": len(diff(current["structure"], s))})
    return 200, get(db, d)


def accept(db: Session, ctx: RequestContext, d: DatasetRow, branch: str) -> dict:
    """A person takes an agent's proposed structure into the draft."""
    if ctx.principal.startswith(("agent:", "plugin:", "worker:")):
        raise HTTPException(403, "only a person accepts a proposed structure")
    r = _row(db, d.id, branch)
    if r is None or branch == DRAFT:
        raise HTTPException(404, "no proposed structure on that branch")
    if not projects.is_draft_dataset(db, d):
        raise HTTPException(409, "the dataset is published: confirm the change as a proposal")
    before = get(db, d)["structure"]
    _write(db, ctx, d, DRAFT, r.structure)
    audit.record(db, ctx.for_scope(d.project_id, None), "dataset.structure.accepted", target=d.id, after={"branch": branch, "changes": len(diff(before, r.structure))})
    return {**get(db, d), "diff": diff(before, r.structure)}


def delete_all(db: Session, dataset_id: str) -> None:
    for r in db.scalars(select(DatasetStructureRow).where(DatasetStructureRow.dataset_id == dataset_id)):
        db.delete(r)
    db.flush()


# ---- Drafting from inspection facts (apply, fast path) -----------------------------------------

_SLUG = re.compile(r"[^a-z0-9]+")


def slug(s: str) -> str:
    return _SLUG.sub("-", s.lower()).strip("-")[:60] or "x"


def _fields(kind: str, facts: list[dict]) -> list[dict]:
    """Technical fields every item of a collection carries, from inspection facts."""
    out: list[dict] = []

    def add(fid: str, name: str, type_: str, unit: str | None = None) -> None:
        if not any(f["id"] == fid for f in out):
            out.append({"id": fid, "name": name, "type": type_, **({"unit": unit} if unit else {}), "required": True, "suggested": True})

    if kind in ("image", "dicom", "slide", "mask"):
        add("fact:width", "Width", "integer", "px")
        add("fact:height", "Height", "integer", "px")
    if kind in ("dicom", "dicom-series"):
        add("fact:modality", "Modality", "category")
    if kind == "dicom-series":
        add("fact:slices", "Slices", "integer")
    if kind == "video":
        add("fact:duration", "Duration", "number", "s")
        add("fact:fps", "Frame rate", "number", "fps")
    if kind == "waveform":
        add("fact:duration", "Duration", "number", "s")
    if kind == "table":
        for f in facts:
            t = f.get("table") if isinstance(f.get("table"), dict) else {}
            for c in (t.get("columns") or [])[:200]:
                name = str(c.get("name") or "")[:200]
                if not name:
                    continue
                type_ = str(c.get("type") or "text")
                add(f"col:{slug(name)}", name, type_ if type_ in FIELD_TYPES else "text")
    return out


FORMAT_LABEL = {"image": "Image", "dicom": "DICOM", "dicom-series": "DICOM", "volume": "Volume", "video": "Video", "waveform": "Waveform", "slide": "Whole-slide", "table": "Table", "mask": "Mask"}


def collection_entry(c: DatasetCollectionRow, facts: list[dict]) -> dict:
    formats = sorted({str(f.get("format"))[:64] for f in facts if f.get("format")}) or [FORMAT_LABEL.get(c.kind, c.kind)]
    return {"id": c.id, "name": c.name[:200], "kind": c.kind, "formats": formats[:32], "fields": _fields(c.kind, facts), "suggested": True}


def merge(db: Session, ctx: RequestContext, d: DatasetRow, cols: list[tuple[DatasetCollectionRow, list[dict]]], *, labels: list[dict] | None = None, relationships: list[dict] | None = None) -> dict:
    """Add collections (and labels, relationships) to the draft as `suggested`; parts a person
    already has are left alone. Returns the new draft."""
    s = json.loads(json.dumps(get(db, d)["structure"]))
    have = {c["id"] for c in s["collections"]}
    for c, facts in cols:
        if c.id not in have:
            s["collections"].append(collection_entry(c, facts))
            have.add(c.id)
    for r in relationships or []:
        if r["from"] in have and r["to"] in have and not any(x["id"] == r["id"] for x in s["relationships"]):
            s["relationships"].append({**r, "suggested": True})
    if labels:
        target = next((c for c, _ in cols if c.kind != "table"), None)
        if target is not None:
            aid = f"ann-{target.id}"
            if not any(a["id"] == aid for a in s["annotations"]):
                s["annotations"].append({"id": aid, "collectionId": target.id, "geometry": "class", "labels": labels, "suggested": True})
    if not validate(s):
        _write(db, ctx, d, DRAFT, s)
    return s


# The request's labels (fast path, §4 M2 item 6): "Label 200 chest X-rays as normal or pneumonia",
# "classify into benign, malignant and unclear", "labels: a, b, c". Deterministic; anything vaguer
# ("five labels") is left to the agent.
_LIST = re.compile(r"(?:\blabels?\s*[:=]\s*|\b(?:as|into)\s+)(?P<list>[A-Za-z][\w /'-]*(?:\s*(?:,|\bor\b|\band\b)\s*[A-Za-z][\w /'-]*)+)", re.IGNORECASE)
_SPLIT = re.compile(r"\s*(?:,|\bor\b|\band\b)\s*", re.IGNORECASE)


def labels_from_request(text: str | None) -> list[dict]:
    if not text:
        return []
    m = _LIST.search(text)
    if not m:
        return []
    names = [n.strip(" .'") for n in _SPLIT.split(m.group("list").split(".")[0]) if n and n.strip(" .'")]
    out: list[dict] = []
    for n in names[:50]:
        lid = slug(n)
        if lid and not any(x["id"] == lid for x in out) and len(n) <= 60:
            out.append({"id": lid, "name": n})
    return out if len(out) >= 2 else []


def label_patch(labels: list[dict], geometry: str = "class") -> list[dict]:
    """The environment's label config for the same labels, with the same stable ids."""
    group = {"name": "finding", "control": "Choices", "classes": [{"id": x["id"], "name": x["name"]} for x in labels]}
    return [{"op": "add", "path": "/labels", "value": [group]}]


def _confirm_structure(db: Session, ctx: RequestContext, p, pr) -> dict:
    """A person confirms a structure change to a published dataset (its `structure` proposal)."""
    d = db.get(DatasetRow, (pr.payload or {}).get("datasetId"))
    if d is None or d.project_id != p.id:
        raise HTTPException(404, "the proposal's dataset is gone")
    s = (pr.payload or {}).get("structure")
    if validate(s):
        raise HTTPException(422, "the proposed structure isn't valid any more")
    current = get(db, d)
    if pr.payload.get("baseHash") and pr.payload["baseHash"] != current["hash"]:
        raise HTTPException(409, "the structure changed since this was proposed")
    _write(db, ctx, d, DRAFT, s)
    return {"structure": get(db, d)}


projects.CONFIRM_EFFECTS["structure"] = _confirm_structure
