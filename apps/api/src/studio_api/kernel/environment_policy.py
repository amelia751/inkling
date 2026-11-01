"""What the API enforces on every environment write (todo11 D2), for every caller: the browser,
the agent, a future MCP server and raw HTTP.

1. Scope: an agent principal patches only allowlisted paths, and changes `modules` only for
   plugins installed in the workspace; it never replaces a whole document.
2. Patch: RFC 6902, all ops or none, a failing op reported by index.
3. Shape: the patched document validates against `schemas/environment.v1.json` with the
   enums that list contribution ids removed…
4. …because references are checked separately: every preset, module, data kind, renderer,
   tool, panel, exporter, review rule, command and override id must be in the generated
   schema's enums (the bundled catalogue) or belong to an installed plugin (`<pluginId>.…`).

The same rules run in TypeScript in `packages/environment-core` (fast client feedback, never
the final word). Both read `packages/environment-core/reference-slots.json`, and both must
produce the same (status, path, code) for every case in
`packages/environment-core/fixtures/cases.json` (tests/test_environment_conformance.py).
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import jsonpatch
from jsonschema import Draft202012Validator

from ..config import settings


@dataclass
class CheckResult:
    status: int  # 200, 403 (scope), 422 (patch, schema, reference)
    errors: list[dict] = field(default_factory=list)
    environment: dict | None = None

    @property
    def ok(self) -> bool:
        return self.status == 200

    def body(self) -> dict:
        return {"ok": False, "errors": self.errors}


def _root() -> Path:
    return Path(settings().repo_root)


@lru_cache(maxsize=4)
def _load(root: str) -> tuple[dict, dict, Draft202012Validator]:
    base = Path(root)
    schema = json.loads((base / "schemas" / "environment.v1.json").read_text())
    slots = json.loads((base / "packages" / "environment-core" / "reference-slots.json").read_text())
    return schema, slots, Draft202012Validator(shape_schema(schema, slots))


def rules() -> tuple[dict, dict, Draft202012Validator]:
    """(schema, slots, shape validator), read once per repo root (static files, not request state)."""
    return _load(str(_root()))


# ---- JSON Pointer --------------------------------------------------------------------------------


def _esc(s: str) -> str:
    return s.replace("~", "~0").replace("/", "~1")


def _unesc(s: str) -> str:
    return s.replace("~1", "/").replace("~0", "~")


def pointer(parts) -> str:
    return "".join("/" + _esc(str(p)) for p in parts)


def _parse(ptr: str) -> list[str]:
    return [] if ptr == "" else [_unesc(p) for p in ptr[1:].split("/")]


def _at(doc, ptr: str):
    cur = doc
    for part in _parse(ptr):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


# ---- Patch -----------------------------------------------------------------------------------------


def apply_patch(base, ops) -> tuple[dict | None, list[dict]]:
    if not isinstance(ops, list):
        return None, [{"path": "", "code": "patch", "message": "A JSON Patch is an array of operations"}]
    spec = copy.deepcopy(base if base is not None else {})
    for i, op in enumerate(ops):
        try:
            if not (isinstance(op, dict) and isinstance(op.get("op"), str) and isinstance(op.get("path"), str)):
                raise ValueError("not an operation")
            spec = jsonpatch.JsonPatch([op]).apply(spec)
        except (jsonpatch.JsonPatchException, jsonpatch.JsonPointerException, KeyError, TypeError, ValueError, IndexError) as e:
            desc = f"{op.get('op')} {op.get('path')}" if isinstance(op, dict) else "?"
            return None, [{"path": f"/{i}", "code": "patch", "message": f"Patch op {i} ({desc}): {e}"}]
    return spec, []


# ---- Agent scope -----------------------------------------------------------------------------------


def _allowed_path(path: str, slots: dict) -> bool:
    agent = slots["agentPaths"]
    return any(path == p or path.startswith(p + "/") for p in agent["prefixes"]) or any(re.search(p, path) for p in agent["patterns"])


def owns_id(installed, id_: str) -> bool:
    return any(id_ == p or id_.startswith(p + ".") for p in installed)


def scope_errors(ops: list, installed, base: dict | None) -> list[dict]:
    _, slots, _ = rules()
    current = (base or {}).get("modules") or {}
    errors: list[dict] = []
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            continue  # the patch step reports it
        paths = [op.get("path")] + ([op["from"]] if isinstance(op.get("from"), str) else [])
        for path in paths:
            if not isinstance(path, str):
                continue
            parts = _parse(path)
            if parts[:1] == ["modules"]:
                if len(parts) < 2:
                    errors.append({"path": f"/{i}", "code": "scope", "message": f"Patch op {i}: an agent can change one module at a time (/modules/<id>), not the whole map"})
                elif parts[1] not in installed and not (op.get("op") == "remove" and parts[1] in current):
                    errors.append({"path": f"/{i}", "code": "scope", "message": f"Patch op {i}: {parts[1]} isn't installed in this workspace; ask the user to install it first"})
                continue
            if not _allowed_path(path, slots):
                errors.append({"path": f"/{i}", "code": "scope", "message": f"Patch op {i} ({op.get('op')} {path}): an agent can change {', '.join(slots['agentPaths']['prefixes'])}, viewport config and installed modules only"})
    return errors


# ---- Shape -------------------------------------------------------------------------------------------


def shape_schema(schema: dict, slots: dict) -> dict:
    out = copy.deepcopy(schema)
    for slot in slots["slots"]:
        parts = _parse(slot["schema"])
        key = parts.pop()
        parent = _at(out, pointer(parts))
        if isinstance(parent, dict):
            parent.pop(key, None)
    return out


def _dedupe(errors: list[dict]) -> list[dict]:
    seen, out = set(), []
    for e in errors:
        k = (e["code"], e["path"])
        if k not in seen:
            seen.add(k)
            out.append(e)
    return out


def shape_errors(spec) -> list[dict]:
    """Normalized like environment-core: one error per extra or missing property."""
    _, _, validator = rules()
    out: list[dict] = []
    for e in validator.iter_errors(spec):
        path = pointer(list(e.absolute_path))
        if e.validator == "additionalProperties" and isinstance(e.instance, dict):
            props = set((e.schema or {}).get("properties") or {})
            extra = [k for k in e.instance if k not in props]
            out += [{"path": f"{path}/{_esc(k)}", "code": "schema", "message": f"{path}/{k}: unexpected property"} for k in extra]
        elif e.validator == "required" and isinstance(e.instance, dict):
            missing = [k for k in e.validator_value if k not in e.instance]
            out += [{"path": f"{path}/{_esc(k)}", "code": "schema", "message": f"{path}/{k}: required"} for k in missing]
        else:
            out.append({"path": path, "code": "schema", "message": f"{path or '/'}: {e.message}"})
    return _dedupe(out)


# ---- References --------------------------------------------------------------------------------------


def _slot_values(spec, instance: str):
    parts = _parse(instance)

    def walk(node, i, path):
        if i == len(parts):
            yield pointer(path), node
            return
        part = parts[i]
        if part == "*":
            if isinstance(node, list):
                for j, v in enumerate(node):
                    yield from walk(v, i + 1, [*path, j])
            elif isinstance(node, dict):
                for k, v in node.items():
                    yield from walk(v, i + 1, [*path, k])
        elif part == "{key}":
            if isinstance(node, dict):
                for k in node:
                    yield pointer([*path, k]), k
        elif isinstance(node, dict) and part in node:
            yield from walk(node[part], i + 1, [*path, part])

    yield from walk(spec, 0, [])


def reference_errors(spec, installed) -> list[dict]:
    schema, slots, _ = rules()
    errors = []
    for slot in slots["slots"]:
        known = set(_at(schema, slot["schema"]) or [])
        for path, id_ in _slot_values(spec, slot["instance"]):
            if not isinstance(id_, str) or id_ in known or owns_id(installed, id_):
                continue
            errors.append({"path": path, "code": "reference", "message": f'{path}: no {slot["kind"]} contribution "{id_}" in the catalogue or the workspace\'s installed plugins'})
    return _dedupe(errors)


# ---- The whole check -------------------------------------------------------------------------------------


def check_write(*, principal: str, installed, base: dict | None = None, patch=None, environment=None, is_patch: bool | None = None) -> CheckResult:
    """`principal` is "person" or "agent". A patch applies to `base`; otherwise `environment` is the document."""
    installed = list(installed or [])
    if is_patch is None:
        is_patch = patch is not None
    if is_patch:
        if principal == "agent" and isinstance(patch, list):
            scope = scope_errors(patch, installed, base)
            if scope:
                return CheckResult(403, scope)
        spec, errors = apply_patch(base, patch)
        if errors:
            return CheckResult(422, errors)
        environment = spec
    elif principal == "agent":
        return CheckResult(403, [{"path": "", "code": "scope", "message": "an agent changes an environment with a patch, never by replacing it"}])
    if not isinstance(environment, dict):
        return CheckResult(422, [{"path": "", "code": "schema", "message": "environment must be an object"}])
    errors = shape_errors(environment) + reference_errors(environment, installed)
    return CheckResult(422, errors) if errors else CheckResult(200, [], environment)


def installed_plugins(db, workspace_id: str) -> list[str]:
    """Plugin ids active in the workspace (pinned in its lockfile): valid reference namespaces."""
    from ..plugins import installer

    return sorted(installer.active(db, workspace_id).keys())
