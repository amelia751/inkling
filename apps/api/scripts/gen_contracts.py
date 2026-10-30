"""Generate pydantic models from schemas/*.json (emitted by `pnpm emit:schemas`).

    uv run python scripts/gen_contracts.py          # write src/studio_api/kernel/contracts/_generated/
    uv run python scripts/gen_contracts.py --check  # CI: exit 1 on drift
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

SCHEMAS = {
    "plugin_v1": "plugin.v1.json",
    "ui_contributions_v1": "ui-contributions.v1.json",
    "workspace_v1": "workspace.v1.json",
    "image_segment_request": "capabilities/image.segment.request.json",
    "image_segment_result": "capabilities/image.segment.result.json",
}
OUT = REPO_ROOT / "apps/api/src/studio_api/kernel/contracts/_generated"
HEADER = "# Generated from schemas/ by apps/api/scripts/gen_contracts.py. Do not edit.\n"


def generate(dest: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for mod, rel in SCHEMAS.items():
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / f"{mod}.py"
            subprocess.run(
                [
                    sys.executable, "-m", "datamodel_code_generator",
                    "--input", str(REPO_ROOT / "schemas" / rel),
                    "--input-file-type", "jsonschema",
                    "--output", str(target),
                    "--output-model-type", "pydantic_v2.BaseModel",
                    "--target-python-version", "3.12",
                    "--use-annotated",
                    "--field-constraints",
                    "--disable-timestamp",
                    "--use-schema-description",
                    "--set-default-enum-member",
                    "--class-name", {"plugin_v1": "PluginManifest", "ui_contributions_v1": "UiContributions", "workspace_v1": "WorkspaceState", "image_segment_request": "SegmentRequest", "image_segment_result": "SegmentResult"}[mod],
                ],
                check=True,
                capture_output=True,
            )
            out[f"{mod}.py"] = HEADER + target.read_text()
    out["__init__.py"] = HEADER + "".join(f"from . import {m}  # noqa: F401\n" for m in SCHEMAS)
    return out


def main() -> int:
    check = "--check" in sys.argv
    files = generate(OUT)
    stale = [n for n, text in files.items() if not (OUT / n).is_file() or (OUT / n).read_text() != text]
    if check:
        if stale:
            print(f"generated contracts are stale ({', '.join(stale)}); run python scripts/gen_contracts.py", file=sys.stderr)
            return 1
        print("generated contracts are up to date")
        return 0
    OUT.mkdir(exist_ok=True)
    for n, text in files.items():
        (OUT / n).write_text(text)
    print(f"wrote {len(files)} files to {OUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
