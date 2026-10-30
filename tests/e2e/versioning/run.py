"""Run the dataset-versioning e2e flows against a fresh stack (README.md).

    uv run --project apps/api python tests/e2e/versioning/run.py            # A, B, C (+ chaos: skipped)
    uv run --project apps/api python tests/e2e/versioning/run.py b c        # some flows
    uv run --project apps/api python tests/e2e/versioning/run.py --keep     # leave containers up
    uv run --project apps/api python tests/e2e/versioning/run.py --api http://127.0.0.1:58800   # reuse a stack
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chaos_test  # noqa: E402
import flow_a_test  # noqa: E402
import flow_b_test  # noqa: E402
import flow_c_test  # noqa: E402
from stack import running  # noqa: E402

FLOWS = {"a": flow_a_test.run, "b": flow_b_test.run, "c": flow_c_test.run, "chaos": chaos_test.run}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("flows", nargs="*", default=list(FLOWS))
    ap.add_argument("--api", help="use an already running stack")
    ap.add_argument("--keep", action="store_true", help="leave the containers running afterwards")
    ap.add_argument("--serve", action="store_true", help="start the stack and keep it up until Ctrl-C (no flows)")
    a = ap.parse_args()

    if a.serve:
        with running(a.keep) as s:
            print(f"serving: api {s.api}, versioning {s.versioning}; Ctrl-C to stop", flush=True)
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                return 0

    def go(api: str) -> int:
        failed = 0
        for name in a.flows:
            t = time.monotonic()
            try:
                FLOWS[name](api)
                print(f"PASS {name} ({time.monotonic() - t:.1f}s)")
            except Exception:  # noqa: BLE001
                failed += 1
                traceback.print_exc()
                print(f"FAIL {name}")
        return failed

    if a.api:
        failed = go(a.api)
    else:
        with running(a.keep) as s:
            failed = go(s.api)
            if failed:
                for n in ("versioning", "api", "worker"):
                    print(f"---- {n}.log (tail) ----\n{s.tail(n)}", file=sys.stderr)
    print(f"{len(a.flows) - failed}/{len(a.flows)} flows passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
