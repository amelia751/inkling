"""Environment saves through admit() (todo17 D1, D2, D6).

`environment_policy.check_write` stays the authority on shape, references, the agent's patch
scope and the resolver's checks; this module turns its result into lint violations and runs them
through the pipeline with the project's rules:

- `env.unresolved` (error): every schema, reference, patch and resolver error, each with the
  policy's own code kept in the legacy `errors[]` beside the problem JSON;
- `env.label-drift` (warn, evaluate): Studio labels (presets resolved) the project's rules don't
  have, or spelled as a synonym.

Resolver warnings come back as `warnings` as before. A scope refusal (403) and revision checks
(409) stay with the routes.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy.orm import Session

from . import labelset
from .admission import Admitted, Ctx, Operation, WriteRejected, admit, register
from .admission import doors
from .environment_policy import CheckResult
from .lint import Violation, violation


def _unresolved(data: Mapping[str, Any], _rules: Mapping[str, Any]) -> list[Violation]:
    out = []
    for e in data.get("errors") or ():
        v = violation("env.unresolved", str(e.get("path") or ""), str(e.get("message") or e.get("code") or "unresolved"))
        v.extra["code"] = e.get("code")
        if e.get("suggestion"):
            v.fix = f"{v.fix} Suggestion: {e['suggestion']}"
        out.append(v)
    return out


def _drift(data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    labels = list(rules.get("labels") or ())
    if not labels:
        return []
    names = sorted({lab.get("name") or lab.get("id") for lab in labels})
    out = []
    for s in data.get("labels") or ():
        lab = labelset._match(labels, s)
        if lab is None:
            out.append(violation("env.label-drift", "/labels", f"The Studio label '{s}' isn't in the project's rules.", value=s, allowed=names))
        elif labelset._key(s) not in {labelset._key(w) for w in (lab.get("id"), lab.get("name")) if isinstance(w, str)}:
            out.append(violation("env.label-drift", "/labels", f"The Studio label '{s}' is a synonym of '{lab.get('name')}'.", value=s, allowed=[lab.get("id") or lab.get("name")]))
    return out


SAVE_OP = register(Operation(id="studio.save", families=(_unresolved, _drift), scope="project:write"))
PATCH_OP = register(Operation(id="studio.patch", families=(_unresolved, _drift), scope="project:write"))


def admit_environment(db: Session, workspace_id: str, op: Operation, checked: CheckResult, *, principal: str, on_behalf_of: str | None = None, dry_run: bool = False) -> Admitted:
    """Raise WriteRejected (problem JSON + the legacy `ok/errors`) when the environment doesn't
    resolve; else the findings (label drift) to return and record. `checked` is a 200 or 422
    result of `environment_policy.check_write` (callers answer 403 scope refusals themselves)."""
    from ..models import ProjectRow

    project = db.get(ProjectRow, workspace_id)
    rules = labelset.project_rules(db, workspace_id) if project is not None else {}
    data = {"errors": checked.errors, "labels": labelset.environment_labels(checked.environment) if checked.ok else []}
    c = Ctx(project_id=workspace_id if project is not None else None, principal=principal, on_behalf_of=on_behalf_of, rules=rules)
    try:
        res = admit(op, data, c, dry_run=True)
        if not checked.ok:  # a severity override can't let a document that doesn't resolve through
            raise WriteRejected([v for v in res.findings if v.rule == "env.unresolved"] or _unresolved(data, rules))
    except WriteRejected as e:
        raise doors.reject(e.violations, title="The environment doesn't resolve", errors=checked.errors or doors.legacy_errors(e.violations), warnings=checked.warnings) from None
    res.dry_run = dry_run
    res.value = checked.environment
    return res


def success(body: dict, res: Admitted, warnings: list | None = None) -> dict:
    out = {**body, "findings": res.findings_json()}
    if warnings:
        out.setdefault("warnings", warnings)
    if res.dry_run:
        out["dryRun"] = True
    return out


def record(db: Session, workspace_id: str, task_id: str, res: Admitted) -> None:
    from ..models import ProjectRow

    if db.get(ProjectRow, workspace_id) is not None:
        doors.record_findings(db, workspace_id, "environment", task_id, res)
