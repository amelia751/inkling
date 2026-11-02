"""One write pipeline (todo17 D1): `admit(op_id, input, ctx)` runs normalise -> validate ->
permit -> persist for every operation that changes a project.

Operations register themselves with `register(Operation(...))`; routes call `admit` (directly or
through `http.write_params`). The project's rules come from an injectable `ctx.rules` (default:
`kernel.rules.get_rules` once that module lands), so this package works before the tables do.
"""

from __future__ import annotations

import copy
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..lint import Family, Violation, resolve_severity, run_families
from ..lint import annotations as lint_annotations
from ..lint import datasets as lint_datasets
from ..lint import labels as lint_labels
from ..lint import layout as lint_layout


class WriteRejected(Exception):
    """A write broke at least one rule at severity error. Carries every violation (D6)."""

    def __init__(self, violations: Sequence[Violation], *, retryable: bool = False, title: str = "The write breaks the project's rules"):
        super().__init__(title)
        self.violations = list(violations)
        self.retryable = retryable
        self.title = title
        # Extra top-level keys for the problem body (a route's legacy fields, e.g. `errors`).
        self.body_extra: dict[str, Any] = {}


class PermissionDenied(WriteRejected):
    def __init__(self, message: str):
        super().__init__([Violation(rule="permit.denied", path="", message=message, severity="error")], title=message)


@dataclass
class Admitted:
    value: Any
    findings: list[Violation] = field(default_factory=list)
    dry_run: bool = False
    # todo17 D7: not applied; an agent's write to something published became a change request
    # (`value` is `{"changeRequest": CR}`; routes answer 202).
    deferred: bool = False

    def findings_json(self) -> list[dict[str, Any]]:
        return [f.to_json() for f in self.findings]


@dataclass
class Ctx:
    """Who is writing and where. Every hook is injectable so tests and early callers need no DB."""

    project_id: str | None = None
    principal: str | None = None
    on_behalf_of: str | None = None
    role: str | None = None
    scopes: frozenset[str] | None = None  # None: not a token-scoped caller
    rules: Mapping[str, Any] | Callable[[str | None], Mapping[str, Any]] | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    # todo17 D7: the writer is an agent (assistant, MCP/OAuth client, non-admin API key); whether
    # an operation's target is published; and how to hand it to a change request instead.
    # `kernel.change_requests.admission_ctx` fills all three for a request.
    agent: bool = False
    targets_published: Callable[[Operation, dict[str, Any], Ctx], bool] | None = None
    open_change_request: Callable[[str, dict[str, Any]], Any] | None = None

    def load_rules(self) -> Mapping[str, Any]:
        if callable(self.rules):
            return self.rules(self.project_id) or {}
        if self.rules is not None:
            return self.rules
        return _default_rules(self.project_id)


def _default_rules(project_id: str | None) -> Mapping[str, Any]:
    """The project's rules (saved, else its preset's), read in a session of its own; callers in a
    request pass `ctx.rules` bound to theirs (`change_requests.admission_ctx`)."""
    if project_id is None:
        return {}
    from ... import db as kdb
    from ...models import ProjectRow
    from .. import rules as rules_mod

    with kdb.session_scope() as db:
        p = db.get(ProjectRow, project_id)
        return rules_mod.get(db, p)["rules"] if p is not None else {}


Persist = Callable[[Any, Ctx], Any]

# `published` value (packages/contracts/src/operations.ts): an agent's write to a published thing
# opens a change request instead of applying (todo17 D7).
CHANGE_REQUEST = "change-request"


@dataclass
class Operation:
    id: str
    families: Sequence[Family] = ()
    defaults: Mapping[str, Any] = field(default_factory=dict)
    scope: str | None = None  # token scope needed (D12), e.g. "project:write"
    roles: frozenset[str] | None = None  # project roles allowed; None = any member
    tier: str = "write"  # todo16 D8 risk tier
    persist: Persist | None = None
    prepare: Callable[[dict[str, Any], Ctx], None] | None = None  # e.g. look up existing names
    idempotent: bool = False
    published: str | None = None  # CHANGE_REQUEST: agents' writes to published targets are reviewed


OPERATIONS: dict[str, Operation] = {}


def register(op: Operation) -> Operation:
    OPERATIONS[op.id] = op
    return op


def operation(op_id: str) -> Operation:
    try:
        return OPERATIONS[op_id]
    except KeyError:
        raise KeyError(f"unknown operation {op_id!r}") from None


# --- normalise ---------------------------------------------------------------------------


def _clean(v: Any) -> Any:
    if isinstance(v, str):
        return unicodedata.normalize("NFC", v).strip()
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def normalise(data: Mapping[str, Any], rules: Mapping[str, Any], defaults: Mapping[str, Any] = ()) -> tuple[dict[str, Any], list[Violation]]:
    """Trim, NFC, defaults, synonyms -> canonical labels. Returns the fixes applied as findings."""
    out: dict[str, Any] = {**copy.deepcopy(dict(defaults)), **_clean(dict(data))}
    fixes: list[Violation] = []
    if rules.get("labels"):
        for v in lint_labels.check({"annotations": out.get("annotations") or []}, rules):
            if v.rule != "label.synonym":
                continue
            i = int(v.path.split("/")[2])
            out["annotations"][i]["label"] = v.allowed[0]
            v.message += f" Rewritten to '{v.allowed[0]}'."
            fixes.append(resolve_severity(v, rules))
    return out, fixes


# --- permit ------------------------------------------------------------------------------


def permit(op: Operation, ctx: Ctx) -> None:
    if op.scope and ctx.scopes is not None and op.scope not in ctx.scopes and "admin" not in ctx.scopes:
        raise PermissionDenied(f"The token lacks the '{op.scope}' scope for {op.id}.")
    if op.roles is not None and ctx.role is not None and ctx.role not in op.roles:
        raise PermissionDenied(f"Role '{ctx.role}' may not run {op.id}.")


def needs_change_request(op: Operation, value: dict[str, Any], ctx: Ctx) -> bool:
    """Permit, D7: an agent's change-request operation on a published target (people, drafts and
    an agent's own scratch apply directly)."""
    return bool(ctx.agent and op.published == CHANGE_REQUEST and ctx.open_change_request is not None and ctx.targets_published is not None and ctx.targets_published(op, value, ctx))


# --- admit -------------------------------------------------------------------------------


def admit(op_id: str | Operation, data: Mapping[str, Any], ctx: Ctx | None = None, *, dry_run: bool = False) -> Admitted:
    op = op_id if isinstance(op_id, Operation) else operation(op_id)
    ctx = ctx or Ctx()
    rules = ctx.load_rules()
    value, fixes = normalise(data, rules, op.defaults)
    if op.prepare:
        op.prepare(value, ctx)
    found = run_families(op.families, value, rules)
    blocking = [v for v in found if v.severity == "error" and not v.evaluate]
    if blocking:
        raise WriteRejected(blocking + [v for v in fixes + found if v not in blocking])
    permit(op, ctx)
    findings = [f for f in fixes + found if f.severity != "off"]
    if not dry_run and needs_change_request(op, value, ctx):
        assert ctx.open_change_request is not None
        return Admitted(value={"changeRequest": ctx.open_change_request(op.id, value)}, findings=findings, deferred=True)
    if dry_run or op.persist is None:
        return Admitted(value=value, findings=findings, dry_run=dry_run)
    return Admitted(value=op.persist(value, ctx), findings=findings)


FAMILIES = {"annotations": lint_annotations.check, "labels": lint_labels.check, "layout": lint_layout.check, "datasets": lint_datasets.check}

__all__ = ["CHANGE_REQUEST", "FAMILIES", "OPERATIONS", "Admitted", "Ctx", "Operation", "PermissionDenied", "WriteRejected", "admit", "needs_change_request", "normalise", "operation", "permit", "register"]
