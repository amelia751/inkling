"""todo18 D7 edges: leaving stops uploads you own, and says so.

    INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 e2e/edge_session_test.py --port 5199

Drives the real tray and store in the page (no kernel needed): requests to the kernel are
intercepted, so the test sees that the cancel was sent.
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
        cancels: list[str] = []
        page.route("**/v1/imports/*/cancel", lambda r: (cancels.append(r.request.url), r.fulfill(status=200, json={"id": "imp_e2e", "state": "cancelled"})))
        page.goto(base + "/")
        page.wait_for_load_state("networkidle")

        # 1. Sign-out (and workspace switch) mid-upload: aborted, cancelled on the kernel, said so.
        seed_session(page, "uploading")
        n = uploads(page, "return await u.useUploads.getState().abortAll('signedOut');")
        check("abortAll stops the upload", n == 1, f"stopped {n}")
        check("the kernel import is cancelled", any("imp_e2e/cancel" in c for c in cancels), str(cancels))
        reason = uploads(page, "return u.LEAVE_REASONS.signedOut;")
        check("the tray says why", wait_text(page, reason.split(".")[0]), reason)

        # 2. Two uploads into one project share one rights dialog (counts merge).
        uploads(page, "u.useUploads.setState({ attestation: null, attestationQueue: [] });")
        page.route("**/v1/projects/p2", lambda r: r.fulfill(status=200, json={"id": "p2", "attested": False}))
        uploads(
            page,
            """const f = (n) => ({ files: Array.from({ length: n }, (_, i) => ({ relPath: `x/${i}.png`, file: new File(['x'], `${i}.png`) })), skipped: 0 });
               void u.useUploads.getState().add('p2', f(2)); void u.useUploads.getState().add('p2', f(3));""",
        )
        page.wait_for_selector("[data-testid=attestation]", timeout=10000)
        check("one dialog with both counts", wait_text(page, "Upload 5 files?"))
        page.keyboard.press("Escape")
        browser.close()
    return finish()


if __name__ == "__main__":
    sys.exit(main())
