"""todo18 D6 edges: nothing waits forever, and leaving while it works warns.

    INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 e2e/edge_stuck_test.py --port 5199

The kernel side (imports stuck `inspecting` failing after API_IMPORT_STALL_MINUTES, poison
files, wedged scheduled runs) is covered by apps/api pytest (test_drops.py, test_sweepers.py);
this checks what a person sees.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _edge_common import check, finish, seed_session, uploads, wait_text  # noqa: E402
from harness import launch, parse_args, sync_playwright  # noqa: E402


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_page()
        page.goto(base + "/")
        page.wait_for_load_state("networkidle")

        # 1. "Checking files" arms the tab-close warning.
        seed_session(page, "checking")
        check("tray shows Checking files", wait_text(page, "Checking files"))
        check("closing the tab warns while checking", uploads(page, "return u.bytesInFlight();") is True)

        # 2. A session the kernel failed for stalling shows its reason.
        reason = "Inspection didn't finish in 15 minutes. Retry or drop the files again"
        uploads(page, f"u.useUploads.setState((s) => ({{ sessions: s.sessions.map((x) => ({{ ...x, phase: 'failed', error: {reason!r} }})) }}));")
        check("the stall reason is shown", wait_text(page, reason))
        check("no warning once it failed", uploads(page, "return u.bytesInFlight();") is False)
        browser.close()
    return finish()


if __name__ == "__main__":
    sys.exit(main())
