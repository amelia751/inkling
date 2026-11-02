"""Project rules (todo17 D3): one `rules.v1` document per project, with history.

The canonical schema is zod in `packages/contracts/src/rules.ts` (`schemas/rules.v1.json`); the
pydantic models here check the shape lightly (sections and field types, extra keys allowed) so a
malformed document never lands. A project with no saved rules reads its preset's defaults
(`registry/presets/<id>.json` `rules`) at revision 0; every change bumps the revision, needs the
revision it was based on (409 if stale, D13) and appends a history row. People edit rules; agents
and delegated tokens get 403 (they propose changes through change requests, D7).
"""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Literal

import jsonpatch
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import Boot, ProjectRow, ProjectRules, ProjectRulesHistory, TaskRow, WorkspaceEnvironment

AGENT_DENIED = "Rules are changed by people. The assistant proposes rule changes as a change request."

Severity = Literal["error", "warn", "info", "off"]


class _M(BaseModel):
    model_config = ConfigDict(extra="allow")


class Label(_M):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    synonyms: list[str] = []
    colour: str | None = None
    allowedGeometries: list[str] = []
    attributes: dict[str, Any] | list[Any] = {}


class Layout(_M):
    folderPatterns: list[str] = []
    fileNamePattern: str | None = None
    forbiddenCharacters: str | list[str] = ""
    maxDepth: int | None = Field(default=None, ge=0)


class Datasets(_M):
    requiredMetadata: list[str] = []
    oneModalityPerDataset: bool = False
    uniqueNames: bool = False


class Annotations(_M):
    insideImage: bool = False
    minSize: float | dict[str, Any] | None = None
    requiredAttributes: list[str] | dict[str, Any] = []


class Merge(_M):
    auto: bool | dict[str, Any] | str = "write-tier"  # "write-tier" | "never" (todo17 D7)


class RulesV1(_M):
    version: Literal[1] = 1
    labels: list[Label] = []
    layout: Layout = Layout()
    datasets: Datasets = Datasets()
    annotations: Annotations = Annotations()
    imaging: dict[str, Any] = {}
    severityOverrides: dict[str, Severity] = {}
    merge: Merge = Merge()


def empty_rules() -> dict[str, Any]:
    return RulesV1().model_dump(mode="json")


def validate(doc: Any) -> dict[str, Any]:
    """The document as stored (input keys kept), or 422 with the paths that are wrong."""
    if not isinstance(doc, dict):
        raise HTTPException(422, {"error": "rules must be an object"})
    try:
        RulesV1.model_validate(doc)
    except ValidationError as e:
        raise HTTPException(422, {"error": "invalid rules", "issues": [{"path": "/".join(str(x) for x in err["loc"]), "message": err["msg"]} for err in e.errors()]}) from None
    ids = [label["id"] for label in doc.get("labels", [])]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, {"error": "invalid rules", "issues": [{"path": "labels", "message": "label ids must be unique"}]})
    return {"version": 1, **doc}


@lru_cache(maxsize=64)
def _preset_rules(preset_id: str, root: str) -> str | None:
    from pathlib import Path

    p = Path(root) / "registry" / "presets" / f"{preset_id}.json"
    try:
        raw = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    rules = raw.get("rules") if isinstance(raw, dict) else None
    return json.dumps(rules) if isinstance(rules, dict) else None


def project_preset(db: Session, p: ProjectRow) -> str | None:
    """The preset the project's Studios extend (its first task's environment), else its last boot's."""
    for task in db.scalars(select(TaskRow).where(TaskRow.project_id == p.id).order_by(TaskRow.created_at)):
        env = db.scalars(select(WorkspaceEnvironment).where(WorkspaceEnvironment.task_id == task.id)).first()
        ext = (env.environment or {}).get("extends") if env is not None else None
        if isinstance(ext, str) and ext.startswith("preset:"):
            return ext.removeprefix("preset:")
    boot = db.scalars(select(Boot).where(Boot.project_id == p.id).order_by(Boot.id.desc())).first()
    if boot is not None and boot.preset:
        return boot.preset.removeprefix("preset:")
    return None


def defaults(db: Session, p: ProjectRow) -> tuple[dict[str, Any], str | None]:
    preset = project_preset(db, p)
    if preset and "/" not in preset and ".." not in preset:
        raw = _preset_rules(preset, str(settings().repo_root))
        if raw is not None:
            try:
                return validate(json.loads(raw)), preset
            except HTTPException:
                pass
    return empty_rules(), preset


def _out(rules: dict, revision: int, *, source: str, preset: str | None = None, updated_by: str | None = None, updated_at: datetime | None = None) -> dict[str, Any]:
    return {"rules": rules, "revision": revision, "source": source, "preset": preset, "updatedBy": updated_by, "updatedAt": updated_at.isoformat() if updated_at else None}


def get(db: Session, p: ProjectRow) -> dict[str, Any]:
    row = db.get(ProjectRules, p.id)
    if row is None:
        rules, preset = defaults(db, p)
        return _out(rules, 0, source="preset" if preset and rules != empty_rules() else "default", preset=preset)
    return _out(row.rules, row.revision, source="project", updated_by=row.updated_by, updated_at=row.updated_at)


def require_person(ctx: RequestContext) -> None:
    if ctx.on_behalf_of is not None or ctx.principal.startswith(("agent:", "service:", "worker:")):
        raise HTTPException(403, AGENT_DENIED)


def _check_revision(current: int, base: Any) -> None:
    if base is None:
        raise HTTPException(428, {"error": "baseRevision is required", "revision": current})
    if not isinstance(base, int) or isinstance(base, bool) or base != current:
        raise HTTPException(409, {"error": "stale revision", "revision": current})


def _save(db: Session, ctx: RequestContext, p: ProjectRow, rules: dict[str, Any], base: Any) -> dict[str, Any]:
    row = db.get(ProjectRules, p.id, with_for_update=True)
    current = row.revision if row is not None else 0
    _check_revision(current, base)
    rules = validate(rules)
    at = datetime.now(UTC)
    if row is None:
        row = ProjectRules(project_id=p.id, rules=rules, revision=1, updated_by=ctx.principal, updated_at=at)
        db.add(row)
    else:
        row.rules, row.revision, row.updated_by, row.updated_at = rules, current + 1, ctx.principal, at
    db.add(ProjectRulesHistory(project_id=p.id, revision=row.revision, rules=rules, actor=ctx.principal, on_behalf_of=ctx.on_behalf_of, created_at=at))
    db.flush()
    return _out(row.rules, row.revision, source="project", updated_by=row.updated_by, updated_at=row.updated_at)


def put(db: Session, ctx: RequestContext, p: ProjectRow, body: dict[str, Any]) -> dict[str, Any]:
    require_person(ctx)
    if "rules" not in body:
        raise HTTPException(422, {"error": "body needs rules and baseRevision"})
    return _save(db, ctx, p, body["rules"], body.get("baseRevision"))


def patch(db: Session, ctx: RequestContext, p: ProjectRow, body: dict[str, Any]) -> dict[str, Any]:
    """JSON Patch (RFC 6902) on the current rules: `{ baseRevision, ops: [...] }`."""
    require_person(ctx)
    ops = body.get("ops")
    if not isinstance(ops, list):
        raise HTTPException(422, {"error": "body needs ops (a JSON Patch) and baseRevision"})
    current = get(db, p)
    _check_revision(current["revision"], body.get("baseRevision"))
    try:
        rules = jsonpatch.apply_patch(copy.deepcopy(current["rules"]), ops)
    except (jsonpatch.JsonPatchException, jsonpatch.JsonPointerException, TypeError, ValueError) as e:
        raise HTTPException(422, {"error": f"patch does not apply: {e}"}) from None
    return _save(db, ctx, p, rules, body.get("baseRevision"))


def history(db: Session, p: ProjectRow, limit: int = 50) -> dict[str, Any]:
    rows = db.scalars(select(ProjectRulesHistory).where(ProjectRulesHistory.project_id == p.id).order_by(ProjectRulesHistory.revision.desc()).limit(max(1, min(limit, 200))))
    return {"history": [{"revision": r.revision, "rules": r.rules, "actor": r.actor, "onBehalfOf": r.on_behalf_of, "createdAt": r.created_at.isoformat()} for r in rows]}
