"""Runtime names from the naming config (packages/plugin-contracts/src/naming.ts → schemas/naming.json).

The product name never appears in kernel code (todo2 D3): contribution ids, env vars and
resource names all come from here.
"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path



def _find_repo_root() -> Path:
    """The checkout (or its mirror at /app in the images) holding schemas/, registry/, plugins/.

    `<envPrefix>REPO_ROOT` overrides; the prefix itself comes from that root's naming.json, so
    any `*REPO_ROOT` variable is only taken when its name matches. Otherwise walk up from
    this file (editable install at <root>/apps/api/src), then the working directory, then /app.
    """
    for key, value in os.environ.items():
        if key.endswith("REPO_ROOT") and value:
            f = Path(value) / "schemas" / "naming.json"
            if f.is_file() and key == f"{json.loads(f.read_text())['envPrefix']}REPO_ROOT":
                return Path(value).resolve()
    for start in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        for d in (start, *start.parents):
            if (d / "schemas" / "naming.json").is_file():
                return d
    return Path("/app")


REPO_ROOT = _find_repo_root()


@cache
def naming() -> dict:
    """`NAMING_FILE` (unprefixed: the prefix is read from it), else the checkout's schemas/naming.json."""
    return json.loads(Path(os.environ.get("NAMING_FILE") or REPO_ROOT / "schemas" / "naming.json").read_text())


def ns(local: str) -> str:
    """A full id in the current namespace: ns("segmentation") → "<namespace>.segmentation"."""
    return f"{naming()['namespace']}.{local}"


def canonical_id(id_: str) -> str:
    """Map an id under a legacy namespace to the current one (stored documents survive a rename)."""
    for old in naming()["legacyNamespaces"]:
        if id_.startswith(f"{old}."):
            return f"{naming()['namespace']}.{id_[len(old) + 1:]}"
    return id_


def plugin_schema_version() -> str:
    return f"{naming()['schemaPrefix']}.plugins/v1"
