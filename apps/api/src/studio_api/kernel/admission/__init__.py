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

    def load_rules(self) -> Mapping[str, Any]:
        if callable(self.rules):
            return self.rules(self.project_id) or {}
        if self.rules is not None:
            return self.rules
        return _default_rules(self.project_id)


def _default_rules(project_id: str | None) -> Mapping[str, Any]:
    if project_id is None:
        return {}
    try:  # kernel/rules.py lands in a parallel slice of todo17 Milestone 1
        from .. import rules as rules_mod  # type: ignore[attr-defined]
    except ImportError:
        return {}
    return rules_mod.get_rules(project_id) or {}


Persist = Callable[[Any, Ctx], Any]


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
    if dry_run or op.persist is None:
        return Admitted(value=value, findings=findings, dry_run=dry_run)
    return Admitted(value=op.persist(value, ctx), findings=findings)


FAMILIES = {"annotations": lint_annotations.check, "labels": lint_labels.check, "layout": lint_layout.check, "datasets": lint_datasets.check}

__all__ = ["FAMILIES", "OPERATIONS", "Admitted", "Ctx", "Operation", "PermissionDenied", "WriteRejected", "admit", "normalise", "operation", "permit", "register"]
