"""Runtime names from the naming config (packages/plugin-contracts/src/naming.ts → schemas/naming.json).

The product name never appears in kernel code (todo2 D3): contribution ids, env vars and
resource names all come from here.
"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]


@cache
def naming() -> dict:
    return json.loads((REPO_ROOT / "schemas" / "naming.json").read_text())


def ns(local: str) -> str:
    """A full id in the current namespace: ns("segmentation") → "<namespace>.segmentation"."""
    return f"{naming()['namespace']}.{local}"


def canonical_id(id_: str) -> str:
    """Map an id under a legacy namespace to the current one (stored documents survive a rename)."""
    for old in naming()["legacyNamespaces"]:
        if id_.startswith(f"{old}."):
            return f"{naming()['namespace']}.{id_[len(old) + 1:]}"
    return id_


def env(name: str, default: str | None = None) -> str | None:
    """A namespaced env var: env("API_DB") reads <envPrefix>API_DB."""
    return os.environ.get(f"{naming()['envPrefix']}{name}", default)


def plugin_schema_version() -> str:
    return f"{naming()['schemaPrefix']}.plugins/v1"
