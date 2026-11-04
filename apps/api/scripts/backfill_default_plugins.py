"""todo25 D3: activate the default plugins (`API_DEFAULT_PLUGINS`) in projects created before
they existed. Idempotent: a plugin already installed in a project (in any state, disabled
included) is left alone, so it's safe to run again.

    uv run python apps/api/scripts/backfill_default_plugins.py [--dry-run]

In production, run it as a one-off Cloud Run job with the api's env (it reads the same config).
"""

from __future__ import annotations

import argparse
import json

from studio_api.db import session_scope
from studio_api.plugins import defaults


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="report what would change, then roll back")
    args = ap.parse_args()
    with session_scope() as db:
        out = defaults.backfill(db)
        if args.dry_run:
            db.rollback()
    summary = {pid: r for pid, r in out.items() if any(v != "present" for v in r.values())}
    print(json.dumps({"projects": len(out), "changed": summary, "dryRun": args.dry_run}, indent=2))


if __name__ == "__main__":
    main()
