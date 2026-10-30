"""Write the kernel's OpenAPI spec to schemas/api/openapi.json (packages/api-client generates from it).

    uv run --package studio-api python apps/api/scripts/dump_openapi.py [--check]
"""

from __future__ import annotations

import json
import sys

from studio_api.app import create_app
from studio_api.naming import REPO_ROOT

out = REPO_ROOT / "schemas" / "api" / "openapi.json"
text = json.dumps(create_app(init_db=False).openapi(), indent=2, sort_keys=True) + "\n"
if "--check" in sys.argv:
    if not out.is_file() or out.read_text() != text:
        sys.exit(f"{out.relative_to(REPO_ROOT)} is stale; run apps/api/scripts/dump_openapi.py")
    print(f"{out.relative_to(REPO_ROOT)} is up to date.")
else:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"wrote {out.relative_to(REPO_ROOT)}")
