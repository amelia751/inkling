"""Two tabs annotate the same Studio (todo18 P0-4): saves don't silently overwrite each other.

Skeleton. Tab A and tab B open the same Studio on a frozen dev server; A draws a box and saves,
B (still on the old revision) draws a different box and saves. B's save gets 409 with A's
document, merges per annotation id and saves again, so both boxes survive. Then both tabs move
the same box: the later tab shows the Theirs / Mine notice (`save-conflict-notice`).

    STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 e2e/edge_concurrency_test.py --port 5199

The dev annotations server (`dev/seed-server.ts`) answers a stale revision with 409 + `current`,
like `kernel/annotations.py put_document`. TODO(todo18): the drawing steps below.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        base = f"http://127.0.0.1:{args.port}"
        a = browser.new_context().new_page()
        b = browser.new_context().new_page()
        for page in (a, b):
            page.goto(f"{base}/")
        # TODO: open the same Studio in both, draw in A and save, draw in B and save,
        # then assert both annotations are in the document and no notice shows;
        # move the same box in both and assert `save-conflict-notice` in the later tab.
        check("two tabs opened", True, "skeleton: merge steps not written yet")
        browser.close()
    failed = [r for r in results if not r[1]]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
