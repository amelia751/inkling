"""Runtime names from the naming config (packages/plugin-contracts/src/naming.ts →
schemas/naming.json), so plugin code never hardcodes the product name (todo2 D3).

The SDK is installed into each plugin's own locked `uv` environment, usually as a copy, so
it can't assume where the repository is. The config is found in this order:

1. `configure(values)`: the worker sends the kernel's naming config with every job, and
   the runner applies it before the plugin is imported (the normal path at run time);
2. `$NAMING_FILE`: a path to a `naming.json` (tests, out-of-tree plugins);
3. `schemas/naming.json` in the nearest ancestor of the working directory or of this file
   (a source checkout, or an editable install);

and otherwise `naming()` raises: guessing a namespace would mint ids that don't resolve.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

NAMING_FILE_ENV = "NAMING_FILE"
_KEYS = ("displayName", "namespace", "schemaPrefix", "resourcePrefix", "envPrefix", "legacyNamespaces")

_configured: dict | None = None
_loaded: dict | None = None


def _check(values: dict, source: str) -> dict:
    missing = [k for k in _KEYS if k not in values]
    if missing:
        raise ValueError(f"naming config from {source} lacks {', '.join(missing)}")
    return {k: (list(values[k]) if k == "legacyNamespaces" else str(values[k])) for k in _KEYS}


def configure(values: dict | None) -> None:
    """Use these values (the job's naming config); `None` goes back to file discovery."""
    global _configured, _loaded
    _configured = _check(values, "configure()") if values is not None else None
    _loaded = None


def find_naming_file(start: Path | None = None) -> Path | None:
    """`$NAMING_FILE`, else `schemas/naming.json` in an ancestor of `start` (cwd) or of this file."""
    env = os.environ.get(NAMING_FILE_ENV)
    if env:
        p = Path(env).expanduser()
        if not p.is_file():
            raise FileNotFoundError(f"${NAMING_FILE_ENV} points at {p}, which doesn't exist")
        return p
    for base in (Path(start or Path.cwd()).resolve(), Path(__file__).resolve().parent):
        for d in (base, *base.parents):
            f = d / "schemas" / "naming.json"
            if f.is_file():
                return f
    return None


def naming() -> dict:
    global _loaded
    if _configured is not None:
        return _configured
    if _loaded is None:
        f = find_naming_file()
        if f is None:
            raise RuntimeError(f"no naming config: run the plugin through the worker, set ${NAMING_FILE_ENV}, or run from a checkout that has schemas/naming.json")
        _loaded = _check(json.loads(f.read_text()), str(f))
    return _loaded


def ns(local: str) -> str:
    """A full id in the current namespace: ns("segmentation") → "<namespace>.segmentation"."""
    return f"{naming()['namespace']}.{local}"


def canonical_id(id_: str) -> str:
    """Map an id under a legacy namespace to the current one."""
    n = naming()
    for old in n["legacyNamespaces"]:
        if id_.startswith(f"{old}."):
            return f"{n['namespace']}.{id_[len(old) + 1:]}"
    return id_


def env(name: str, default: str | None = None) -> str | None:
    """A namespaced env var: env("E2E") reads <envPrefix>E2E."""
    return os.environ.get(f"{naming()['envPrefix']}{name}", default)


def plugin_schema_version() -> str:
    return f"{naming()['schemaPrefix']}.plugins/v1"
