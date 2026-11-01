"""Read models for the Datasets landing page and its attention lists (todo13 Milestone 3,
docs/datasets.md §2.1 and §4).

- `summaries`: one bounded row per dataset (collections counted at their own level, issue and
  suggestion counts, last change), so the landing page is one request however many datasets or
  files there are (docs/datasets.md §15 criterion 11). Built from the dataset profile, so the
  numbers match the dataset's own pages.
- `attention`: what needs a person, across the project or for one dataset: malformed files
  (inspection flags), unconfirmed suggestions (suggested collections and connections, open
  proposals), and drop plans waiting for a person (todo13 `drops`, read defensively until that
  table exists). Pipeline issues come from the pipeline gateway, which the web reads itself.
- `overlay_collections`: a dataset whose definition names collections (todo13 D7) shows them by
  their own id and name; without any, the profile's one-per-detected-kind collections stand.

Boundary: like the profile, counts, kinds, kernel-written titles and ids only. No file names,
paths, cell values or identifiers (AGENTS.md).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..models import DatasetRow, ProjectRow, Proposal, TaskRow
from . import dataset_profile, projects

log = logging.getLogger(__name__)

RULES_VERSION = 1
# Collections and attention rows per dataset on the landing page; the dataset's pages have the rest.
MAX_COLLECTIONS = 8
MAX_ITEMS = 50
SEVERITY = {"high": 0, "medium": 1, "low": 2}
# Inspection issue categories that mean "a file is malformed or can't be used" (§2.1 "Needs attention").
MALFORMED = {"privacy", "unreadable", "quality"}


# ---- Collections from the dataset definition (todo13 D7) ---------------------------------------


def defined_collections(d: DatasetRow) -> list[dict]:
    """The collections the dataset's definition names, if any (`[{id, name, kind, suggested?}]`).
    Anything malformed is skipped rather than failing the page."""
    raw = (d.definition or {}).get("collections")
    if not isinstance(raw, list):
        return []
    out = []
    for c in raw:
        if isinstance(c, dict) and c.get("id") and c.get("kind"):
            out.append({"id": str(c["id"]), "name": str(c.get("name") or c["kind"]), "kind": str(c["kind"]), "suggested": c.get("suggested")})
    return out


def overlay_collections(d: DatasetRow, profile: dict) -> dict:
    """Show the definition's collections in the profile: the first defined collection of a kind
    takes that kind's counts, facts and fields under its own id and name; a defined collection
    with no files yet is listed empty (an empty collection waiting for a drop, todo13 §3.5).
    Issues and relationships follow the renamed ids."""
    defined = defined_collections(d)
    if not defined:
        return profile
    by_kind = {c["kind"]: c for c in profile["collections"]}
    renamed: dict[str, str] = {}
    out: list[dict] = []
    for c in defined:
        base = by_kind.pop(c["kind"], None)
        if base is not None:
            renamed[base["id"]] = c["id"]
            out.append({**base, "id": c["id"], "name": c["name"], "suggested": base["suggested"] if c["suggested"] is None else bool(c["suggested"])})
        else:
            name, one, other = dataset_profile.NAMES.get(c["kind"], dataset_profile.NAMES["unknown"])
            out.append(
                {
                    "id": c["id"],
                    "name": c["name"],
                    "kind": c["kind"],
                    "count": 0,
                    "unit": {"one": one, "other": other},
                    "files": 0,
                    "formats": [],
                    "facts": [],
                    "fields": [],
                    "previewNodeId": None,
                    "suggested": bool(c["suggested"]) if c["suggested"] is not None else False,
                    "issues": 0,
                }
            )
    # Files of a kind no defined collection holds stay visible, as inferred collections.
    out += list(by_kind.values())
    profile["collections"] = out
    for i in profile["issues"]:
        if i.get("collectionId") in renamed:
            i["collectionId"] = renamed[i["collectionId"]]
    for r in profile["relationships"]:
        r["from"] = renamed.get(r["from"], r["from"])
        r["to"] = renamed.get(r["to"], r["to"])
    return profile


# ---- Landing summaries -------------------------------------------------------------------------


def _last_change(db: Session, d: DatasetRow) -> datetime | None:
    """The newest meaningful change we know of: created, a task added, or a task published."""
    times = [d.created_at]
    for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id)):
        times += [t.created_at, t.published_at]
    times = [t for t in times if t is not None]
    return max(times, key=lambda t: t.replace(tzinfo=None)) if times else None


def summary(db: Session, d: DatasetRow) -> dict:
    p = overlay_collections(d, dataset_profile.build(db, d))
    issues = p["issues"]
    suggested_collections = sum(1 for c in p["collections"] if c["suggested"])
    suggested_links = sum(1 for r in p["relationships"] if r["status"] == "suggested")
    return {
        "datasetId": d.id,
        "files": p["files"],
        "checking": p["checking"],
        "collections": [{k: c[k] for k in ("id", "name", "kind", "count", "unit", "files", "suggested", "issues", "previewNodeId")} for c in p["collections"][:MAX_COLLECTIONS]],
        "moreCollections": max(0, len(p["collections"]) - MAX_COLLECTIONS),
        "relationships": len(p["relationships"]),
        "issues": {
            "count": len(issues),
            "items": sum(i["count"] for i in issues),
            "blocking": sum(1 for i in issues if i["blocking"]),
            "high": sum(1 for i in issues if i["severity"] == "high"),
        },
        "suggestions": suggested_collections + suggested_links,
        "snapshot": p["snapshot"],
        "lastChangedAt": projects.iso(_last_change(db, d)),
    }


def summaries(db: Session, p: ProjectRow) -> dict:
    rows = db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at))
    return {"datasets": [summary(db, d) for d in rows]}


# ---- Attention ---------------------------------------------------------------------------------


def _item(id_: str, kind: str, dataset: DatasetRow | None, severity: str, blocking: bool, title: str, detail: str, count: int, label: str, target: dict, at: datetime | None = None) -> dict:
    return {
        "id": id_,
        "kind": kind,
        "datasetId": dataset.id if dataset else None,
        "datasetTitle": dataset.title if dataset else None,
        "severity": severity,
        "blocking": blocking,
        "title": title,
        "detail": detail,
        "count": count,
        "action": {"label": label, "target": target},
        "at": projects.iso(at),
    }


def _dataset_items(db: Session, d: DatasetRow) -> list[dict]:
    p = overlay_collections(d, dataset_profile.build(db, d))
    out: list[dict] = []
    for i in p["issues"]:
        if i["category"] not in MALFORMED and i["category"] != "identity":
            continue
        kind = "malformed" if i["category"] in MALFORMED else "suggestion"
        target = i["action"]["target"]
        out.append(_item(f"{d.id}:{i['id']}", kind, d, i["severity"], i["blocking"], i["title"], i["detail"], i["count"], i["action"]["label"], target))
    pending = [c for c in p["collections"] if c["suggested"]]
    if pending:
        n = len(pending)
        names = ", ".join(c["name"] for c in pending[:3]) + (f" and {n - 3} more" if n > 3 else "")
        out.append(
            _item(
                f"{d.id}:structure.suggested@{RULES_VERSION}",
                "suggestion",
                d,
                "low",
                False,
                f"{n:,} suggested {'collection' if n == 1 else 'collections'} to confirm",
                f"{names}: inferred from the files. Nothing relies on {'it' if n == 1 else 'them'} until someone confirms.",
                n,
                "Review structure",
                {"section": "datasets", "datasetId": d.id, "tab": "structure"},
            )
        )
    links = [r for r in p["relationships"] if r["status"] == "suggested"]
    if links:
        n = len(links)
        out.append(
            _item(
                f"{d.id}:structure.links@{RULES_VERSION}",
                "suggestion",
                d,
                "low",
                False,
                f"{n:,} suggested {'connection' if n == 1 else 'connections'} to confirm",
                "Links between collections found by matching names. Confirm or fix them in Structure.",
                n,
                "Review connections",
                {"section": "datasets", "datasetId": d.id, "tab": "structure"},
            )
        )
    return out


def _proposal_items(db: Session, p: ProjectRow) -> list[dict]:
    """Open dataset proposals (Explore suggests a dataset from what it found): not yet any
    dataset's, so they belong to the landing page only."""
    rows = list(db.scalars(select(Proposal).where(Proposal.project_id == p.id, Proposal.kind == "dataset", Proposal.status == "proposed").order_by(Proposal.created_at.desc())))
    if not rows:
        return []
    n = len(rows)
    return [
        _item(
            f"proposals:dataset@{RULES_VERSION}",
            "suggestion",
            None,
            "low",
            False,
            f"{n:,} suggested {'dataset' if n == 1 else 'datasets'} from your files",
            "Explore grouped files that look like they belong together. Nothing is created until you confirm.",
            n,
            "Open Explore",
            {"section": "explore", "tab": "datasets", "proposalId": rows[0].id},
            rows[0].created_at,
        )
    ]


def _plan_items(db: Session, p: ProjectRow, datasets: dict[str, DatasetRow]) -> list[dict]:
    """Drop plans waiting for a person (todo13 §5 `drops`, state `planned`). The table arrives
    with `todo13-drops`; until then there is nothing to read, and a missing table is not an
    error. Read in a savepoint so a failure never poisons the request's transaction."""
    try:
        with db.begin_nested():
            rows = db.execute(
                text("SELECT id, dataset_id, conversation_id, created_at FROM drops WHERE project_id = :p AND state = 'planned' ORDER BY created_at DESC LIMIT :n"),
                {"p": p.id, "n": MAX_ITEMS},
            ).all()
    except SQLAlchemyError:
        return []
    out = []
    for drop_id, dataset_id, conversation_id, created_at in rows:
        d = datasets.get(dataset_id) if dataset_id else None
        at = created_at if isinstance(created_at, datetime) else None
        target = {"section": "datasets", "datasetId": d.id} if d else {"section": "overview"}
        out.append(
            _item(
                f"drop:{drop_id}",
                "plan",
                d,
                "medium",
                False,
                "Dropped files are waiting for a decision",
                "A plan for where these files go needs your answer in the chat.",
                1,
                "Open the plan",
                {**target, **({"conversationId": str(conversation_id)} if conversation_id else {}), "dropId": str(drop_id)},
                at,
            )
        )
    return out


def attention(db: Session, p: ProjectRow, dataset_id: str | None = None) -> dict:
    q = select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at)
    if dataset_id:
        q = q.where(DatasetRow.id == dataset_id)
    datasets = {d.id: d for d in db.scalars(q)}
    items: list[dict] = []
    for d in datasets.values():
        items += _dataset_items(db, d)
    if not dataset_id:
        items += _proposal_items(db, p)
    plans = _plan_items(db, p, datasets)
    items += [i for i in plans if not dataset_id or i["datasetId"] == dataset_id]
    # Riskiest first (§4: by risk, not raw count); a waiting plan before a suggestion.
    kind_rank = {"malformed": 0, "plan": 1, "suggestion": 2}
    items.sort(key=lambda i: (not i["blocking"], SEVERITY[i["severity"]], kind_rank.get(i["kind"], 3), -i["count"]))
    return {"items": items[:MAX_ITEMS], "total": len(items), "byKind": _count_kinds(items)}


def _count_kinds(items: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i in items:
        out[i["kind"]] = out.get(i["kind"], 0) + 1
    return out
