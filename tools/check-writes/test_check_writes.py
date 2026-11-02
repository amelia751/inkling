"""`pnpm check:writes` (todo17 D1): every mutating route declares an operation (`x-operation`,
set by `admission.http.declares`) and so goes through `admit`.

Routes migrate in later slices, so today's undeclared routes are an allowlist (`allowlist.txt`).
A *new* undeclared route fails; a route that gets declared must leave the allowlist (stale
entries fail too), so the list only shrinks. `--update` regenerates it:
    uv run pytest tools/check-writes -q --update-writes
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

ALLOWLIST = Path(__file__).with_name("allowlist.txt")
HEADER = "# Mutating routes that do not go through admit() yet (todo17 D1). This list only shrinks.\n# Regenerate: uv run pytest tools/check-writes -q --update-writes\n"
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def mutating_routes() -> dict[str, bool]:
    os.environ.setdefault("STUDIO_API_DATABASE_URL", "sqlite:///:memory:")
    from studio_api.app import create_app
    from studio_api.kernel.admission.http import OPERATION_KEY

    # Walk the OpenAPI document: included routers are resolved there, and `openapi_extra` lands
    # on each operation. (Routes with include_in_schema=False are not seen; keep writes in schema.)
    spec = create_app(init_db=False).openapi()
    out: dict[str, bool] = {}
    for path, item in spec.get("paths", {}).items():
        for method, op in item.items():
            if method.upper() in MUTATING:
                out[f"{method.upper()} {path}"] = bool(op.get(OPERATION_KEY))
    return out


def test_every_mutating_route_declares_an_operation(request):
    routes = mutating_routes()
    undeclared = sorted(k for k, ok in routes.items() if not ok)
    if request.config.getoption("--update-writes"):
        ALLOWLIST.write_text(HEADER + "\n".join(undeclared) + "\n")
        pytest.skip(f"wrote {len(undeclared)} entries to {ALLOWLIST.name}")
    allowed = {ln.strip() for ln in ALLOWLIST.read_text().splitlines() if ln.strip() and not ln.startswith("#")}
    new = [k for k in undeclared if k not in allowed]
    stale = sorted(allowed - set(undeclared))
    declared = sum(routes.values())
    print(f"\ncheck:writes: {declared}/{len(routes)} mutating routes declare an operation; {len(undeclared)} allowlisted")
    assert not new, "Mutating routes that bypass admit() (declare an operation with admission.http.declares):\n  " + "\n  ".join(new)
    assert not stale, "Routes now declared or gone; remove them from tools/check-writes/allowlist.txt:\n  " + "\n  ".join(stale)
