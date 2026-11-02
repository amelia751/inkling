"""Imaging checks in the kernel (todo17 D11): enqueue the worker's `imaging.check`, record what it
finds in `lint_findings`, and gate exports on it.

- `enqueue_check` queues the job (a kernel job the worker runs itself, `service_jobs.PLUGIN`) for
  the imaging-looking files of an import or an export. It never blocks the upload or the export.
- `record` stores the worker's results (`POST /api/v1/service/projects/:id/findings`): per
  resource (a DICOM series by its opaque `series_uid_hash`, or a NIfTI file by node id) the open
  scan findings of the checked codes are replaced: new ones inserted, ones no longer reported
  resolved. Severities come from the project's rules (`imaging.checks`, then `severityOverrides`,
  then the catalogue default; `off` drops the finding).
- `export_gate` lists the open imaging findings for files about to be exported; error severity
  blocks the export (422 problem JSON with `findings`) unless a person passes `force`.

Findings carry codes, counts, ids and field names only; the worker never sends header or pixel
values (PHI). When W-HEALTH's `kernel.findings.record` lands, `record` can delegate to it.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import AUTH_API_KEY, RequestContext, ensure_workspace
from ..models import LintFinding, ProjectRow, SourceNode, now
from . import jobs, rules as rules_mod, service_jobs
from .lint import CATALOGUE, SEVERITIES

TOOL = "imaging.check"
TIMEOUT_S = 1800
MAX_NODES = 5000
RESOURCE_KINDS = ("series", "file")
SOURCES = ("scan", "write")
CODES = tuple(c for c in CATALOGUE if c.startswith(("dicom.", "nifti.")))
IMAGING_SUFFIXES = (".dcm", ".dicom", ".ima", ".nii", ".nii.gz")


def is_imaging_name(name: str) -> bool:
    """DICOM often has no extension at all; anything else with a known non-imaging extension is skipped."""
    low = name.lower()
    if low.endswith(IMAGING_SUFFIXES):
        return True
    base = low.rsplit("/", 1)[-1]
    return "." not in base or base.rsplit(".", 1)[-1].isdigit()


# ---- Enqueue --------------------------------------------------------------------------------


def _nodes(db: Session, project_id: str, node_ids: Iterable[str]) -> list[SourceNode]:
    ids = list(dict.fromkeys(node_ids))
    out: list[SourceNode] = []
    for i in range(0, len(ids), 500):
        out.extend(db.scalars(select(SourceNode).where(SourceNode.id.in_(ids[i : i + 500]), SourceNode.project_id == project_id, SourceNode.is_dir.is_(False))))
    return out


def enqueue_check(db: Session, ctx: RequestContext, p: ProjectRow, node_ids: Iterable[str], *, trigger: str, key: str | None = None) -> str | None:
    """Queue `imaging.check` for the imaging-looking files among `node_ids`; → job id or None
    (nothing to check). The same `key` (or the same file set and trigger) queues once."""
    nodes = [n for n in _nodes(db, p.id, node_ids) if n.asset_id and is_imaging_name(n.name)][:MAX_NODES]
    if not nodes:
        return None
    payload = [{"id": n.id, "name": n.name, "parentId": n.parent_id} for n in nodes]
    if key is None:
        key = f"{TOOL}:{trigger}:" + hashlib.sha256(",".join(sorted(n.id for n in nodes)).encode()).hexdigest()[:24]
    ensure_workspace(db, p.id)
    jctx = RequestContext(p.id, ctx.principal, ctx.correlation_id, key, on_behalf_of=ctx.on_behalf_of)
    j, _ = jobs.enqueue(db, jctx, plugin_id=service_jobs.PLUGIN, version=service_jobs.VERSION, tool=TOOL, input={"projectId": p.id, "trigger": trigger, "nodes": payload}, capability=None, provider=None, estimated_cost_usd=0.0, timeout_s=TIMEOUT_S)
    return j.job_id


# ---- Severity -------------------------------------------------------------------------------


def severity_of(code: str, rules: Mapping[str, Any], default: str | None = None) -> str:
    checks = (rules.get("imaging") or {}).get("checks") or {}
    if checks.get(code) in SEVERITIES:
        return checks[code]
    overrides = rules.get("severityOverrides") or {}
    if overrides.get(code) in SEVERITIES:
        return overrides[code]
    spec = CATALOGUE.get(code)
    return spec.severity if spec else (default if default in SEVERITIES else "warn")


def gates(code: str, rules: Mapping[str, Any]) -> bool:
    """Whether an error of this code blocks exports: rules in evaluate mode (D5) only once the
    project chose a severity for them (`imaging.checks`, `severityOverrides`) or promoted them."""
    spec = CATALOGUE.get(code)
    if spec is None or not spec.evaluate:
        return True
    chosen = set(((rules.get("imaging") or {}).get("checks") or {})) | set(rules.get("severityOverrides") or {}) | set(rules.get("enforce") or ())
    return code in chosen


# ---- Record ---------------------------------------------------------------------------------


def _clean(v: Any) -> dict[str, str] | None:
    if not isinstance(v, dict):
        return None
    rule, path, message = v.get("rule"), v.get("path"), v.get("message")
    if not isinstance(rule, str) or rule not in CODES:
        return None
    return {"rule": rule, "path": str(path or "/")[:1024], "message": str(message or "")[:1000], "severity": str(v.get("severity") or "")}


def record(db: Session, project_id: str, resource_kind: str, resource_id: str, violations: list[Any], source: str = "scan", *, checked: Iterable[str] | None = None, rules: Mapping[str, Any] | None = None) -> dict[str, int]:
    """Replace the open findings of `checked` codes on one resource with `violations`."""
    if resource_kind not in RESOURCE_KINDS:
        raise HTTPException(422, f"resourceKind is one of {', '.join(RESOURCE_KINDS)}")
    if source not in SOURCES:
        raise HTTPException(422, f"source is one of {', '.join(SOURCES)}")
    if not isinstance(resource_id, str) or not resource_id or len(resource_id) > 128:
        raise HTTPException(422, "resourceId is required (at most 128 characters)")
    if not isinstance(violations, list):
        raise HTTPException(422, "violations must be a list")
    codes = set(checked or CODES) & set(CODES)
    if rules is None:
        p = db.get(ProjectRow, project_id)
        rules = rules_mod.get(db, p)["rules"] if p is not None else {}
    new: dict[tuple[str, str], dict[str, str]] = {}
    for raw in violations:
        v = _clean(raw)
        if v is None or v["rule"] not in codes:
            continue
        sev = severity_of(v["rule"], rules, v["severity"])
        if sev == "off":
            continue
        new.setdefault((v["rule"], v["path"]), {**v, "severity": sev})
    open_rows = list(db.scalars(select(LintFinding).where(LintFinding.project_id == project_id, LintFinding.resource_kind == resource_kind, LintFinding.resource_id == resource_id, LintFinding.source == source, LintFinding.rule.in_(codes), LintFinding.resolved_at.is_(None))))
    at = now()
    out = {"opened": 0, "resolved": 0, "kept": 0}
    for row in open_rows:
        v = new.pop((row.rule, row.path or "/"), None)
        if v is None:
            row.resolved_at = at
            out["resolved"] += 1
        else:
            row.severity, row.message = v["severity"], v["message"]
            out["kept"] += 1
    for v in new.values():
        db.add(LintFinding(project_id=project_id, resource_kind=resource_kind, resource_id=resource_id, rule=v["rule"], severity=v["severity"], path=v["path"], message=v["message"], source=source, first_seen=at))
        out["opened"] += 1
    db.flush()
    return out


def record_body(db: Session, p: ProjectRow, body: dict) -> dict:
    """The service route's body: one `{resourceKind, resourceId, violations}` or a batch under
    `results`, with `source` ("scan") and optionally `checked` (the codes the check ran)."""
    source = str(body.get("source") or "scan")
    checked = body.get("checked")
    if checked is not None and (not isinstance(checked, list) or not all(isinstance(c, str) for c in checked)):
        raise HTTPException(422, "checked must list rule codes")
    items = body.get("results") if isinstance(body.get("results"), list) else [body]
    rules = rules_mod.get(db, p)["rules"]
    total = {"opened": 0, "resolved": 0, "kept": 0}
    for it in items:
        if not isinstance(it, dict):
            raise HTTPException(422, "each result is {resourceKind, resourceId, violations}")
        r = record(db, p.id, str(it.get("resourceKind") or ""), it.get("resourceId"), it.get("violations") or [], source, checked=checked, rules=rules)  # type: ignore[arg-type]
        for k, n in r.items():
            total[k] += n
    return total


# ---- Export gate ----------------------------------------------------------------------------


def is_person(ctx: RequestContext) -> bool:
    return ctx.on_behalf_of is None and ctx.auth != AUTH_API_KEY and not ctx.principal.startswith(("agent:", "service:", "worker:", "plugin:"))


def finding_json(row: LintFinding, severity: str) -> dict[str, Any]:
    spec = CATALOGUE.get(row.rule)
    return {"id": row.id, "resourceKind": row.resource_kind, "resourceId": row.resource_id, "rule": row.rule, "severity": severity, "path": row.path, "message": row.message, "fix": spec.fix if spec else "", "source": row.source, "firstSeen": row.first_seen.isoformat() if row.first_seen else None}


def open_findings(db: Session, p: ProjectRow, nodes: list[SourceNode]) -> tuple[list[dict], list[dict]]:
    """(blocking, other) open imaging findings for these files, at today's severities."""
    if not nodes:
        return [], []
    ids = {n.id for n in nodes}
    series = {str((n.facts or {}).get("series_uid_hash")) for n in nodes if (n.facts or {}).get("series_uid_hash")}
    rows = list(db.scalars(select(LintFinding).where(LintFinding.project_id == p.id, LintFinding.rule.in_(CODES), LintFinding.resolved_at.is_(None))))
    rules = rules_mod.get(db, p)["rules"]
    blocking, other = [], []
    for row in rows:
        if not ((row.resource_kind == "file" and row.resource_id in ids) or (row.resource_kind == "series" and row.resource_id in series)):
            continue
        sev = severity_of(row.rule, rules, row.severity)
        if sev == "off":
            continue
        (blocking if sev == "error" and gates(row.rule, rules) else other).append(finding_json(row, sev))
    return blocking, other


class ExportBlocked(Exception):
    """Carries the 422 problem body; the route answers it as application/problem+json."""

    def __init__(self, body: dict):
        super().__init__(body["detail"])
        self.body = body

    def response(self) -> Any:
        from fastapi.responses import JSONResponse

        return JSONResponse(self.body, status_code=422, media_type="application/problem+json")


def export_gate(db: Session, ctx: RequestContext, p: ProjectRow, nodes: list[SourceNode], *, force: bool = False) -> list[dict]:
    """Queue a fresh check of the exported files and gate on what is already known. → the
    findings to report with the export; raises ExportBlocked (422 problem JSON) on errors unless
    a person forces it."""
    enqueue_check(db, ctx, p, [n.id for n in nodes], trigger="export")
    blocking, other = open_findings(db, p, nodes)
    if blocking and not (force and is_person(ctx)):
        raise ExportBlocked(problem(blocking + other, forced=force))
    return blocking + other


def problem(findings: list[dict], *, forced: bool = False) -> dict:
    errors = sum(1 for f in findings if f["severity"] == "error")
    detail = f"{errors} imaging check{'s' if errors != 1 else ''} failed on the files in this export."
    detail += " Only a person can export anyway." if forced else " Fix them, or export anyway with force=true."
    return {
        "type": "/docs/lint-rules#export_blocked",
        "title": "Export blocked by imaging checks",
        "status": 422,
        "code": "export_blocked",
        "detail": detail,
        "violations": [{"rule": f["rule"], "severity": f["severity"], "path": f["path"] or "/", "message": f["message"], "fix": f["fix"], "docs": f"/docs/lint-rules#{f['rule']}"} for f in findings],
        "findings": findings,
        "retryable": False,
    }
