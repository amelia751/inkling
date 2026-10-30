"""Dependency resolution (docs/plugins.md §7.2 Resolve; §14 #11).

Resolves a requested plugin (and its `requires`) to concrete versions from the catalog,
checks kernel API and Studio compatibility, detects cycles, and reports conflicts with
what the workspace already runs. Conflicts are surfaced, never auto-rewritten: installing
B never silently upgrades or removes an active A.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..naming import canonical_id
from . import catalog, semver

KERNEL_PLUGIN_API = "1.0.0"
STUDIO_VERSION = "0.1.0"


@dataclass
class Resolution:
    install: list[catalog.Entry] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors and not self.conflicts


def resolve(plugin_id: str, version_range: str | None, active: dict[str, str]) -> Resolution:
    """`active`: plugin id → version currently ACTIVATED in the workspace."""
    r = Resolution()
    chosen: dict[str, catalog.Entry] = {}

    def visit(pid: str, rng: str | None, path: list[str]) -> None:
        if pid in path:
            r.errors.append({"code": "cycle", "message": " → ".join([*path, pid])})
            return
        e_all = catalog.versions(pid)
        if not e_all:
            r.errors.append({"code": "not-found", "plugin": pid, "message": f"{pid} is not in the registry", "requiredBy": path[-1] if path else None})
            return
        if e_all[0].trust_tier == "builtin":
            if rng and not semver.satisfies(e_all[-1].version, rng):
                r.errors.append({"code": "builtin-version", "plugin": pid, "message": f"{pid}@{e_all[-1].version} (built in) doesn't satisfy {rng}"})
            return
        if pid in active:
            if rng and not semver.satisfies(active[pid], rng):
                r.conflicts.append({"plugin": pid, "active": active[pid], "required": rng, "requiredBy": path[-1] if path else None, "message": f"{path[-1] if path else 'request'} needs {pid} {rng}, but {active[pid]} is active; upgrade or roll back {pid} explicitly"})
            if path:  # an active dependency that satisfies the range stays as it is
                return
        if pid in chosen:
            if rng and not semver.satisfies(chosen[pid].version, rng):
                r.conflicts.append({"plugin": pid, "chosen": chosen[pid].version, "required": rng, "message": f"two plugins need incompatible versions of {pid}"})
            return
        best = semver.max_satisfying([e.version for e in e_all], rng or "*")
        if best is None:
            r.errors.append({"code": "no-version", "plugin": pid, "message": f"no {pid} version satisfies {rng}"})
            return
        e = next(x for x in e_all if x.version == best)
        compat = e.manifest.get("compatibility") or {}
        if compat.get("pluginApi") and not semver.satisfies(KERNEL_PLUGIN_API, compat["pluginApi"]):
            r.errors.append({"code": "plugin-api", "plugin": pid, "message": f"{pid}@{best} needs plugin API {compat['pluginApi']}; the kernel provides {KERNEL_PLUGIN_API}"})
        if compat.get("studio") and not semver.satisfies(STUDIO_VERSION, compat["studio"]):
            r.errors.append({"code": "studio-version", "plugin": pid, "message": f"{pid}@{best} needs Studio {compat['studio']}; this is {STUDIO_VERSION}"})
        chosen[pid] = e
        for dep, dep_rng in (e.manifest.get("requires") or {}).items():
            visit(canonical_id(dep), dep_rng, [*path, pid])
        r.install.append(e)

    visit(plugin_id, version_range, [])
    return r
