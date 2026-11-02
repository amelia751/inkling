"""todo18 edge cases: session (skeleton; W4 todo18-session).

Run against a frozen dev server: `INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort`, then
`python3 e2e/edge_session_test.py --port 5199`.
"""

from __future__ import annotations

import argparse
import sys

CASES = {
    "session": [
        "sign-out mid-upload: tray row says 'Upload stopped: you signed out', kernel import is cancelled",
        "workspace switch mid-upload: uploads cancelled with a toast",
        "401 on a chunk PUT: one PUT, session cancelled, Signing you in…",
        "two drops into one project: one attestation dialog with both counts",
    ],
    "stuck": [
        "import inspecting past API_IMPORT_STALL_MINUTES shows the stall reason",
        "Checking files: closing the tab warns",
    ],
}["session"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5199)
    ap.parse_args()
    for c in CASES:
        print(f"SKIP (todo): {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
