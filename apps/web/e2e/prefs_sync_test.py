"""Per-person state on the server (todo22 W3, D3): a Studio layout dragged in one browser
context is what a second, fresh context (another device: empty localStorage) opens with,
because the layout is a `user_prefs` key (`layout:<project>:<task>:<viewport>`), not localStorage.

Both contexts carry the same `e2e-prefs-scope` cookie: the e2e server keeps the default
person's prefs only per scope, so this test's layout never leaks into another test.

    STUDIO_E2E=1 pnpm exec vite --port 5203 --strictPort
    python3 e2e/prefs_sync_test.py --port 5203
"""

from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, open_studio, parse_args, sync_playwright  # noqa: E402

DATASET = "2d-xray"
LAYOUT_KEY = f"layout:{DATASET}:{DATASET}:desktop"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def wait_for(fn, what: str, timeout: float = 20):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError(f"timed out waiting for {what}")


def left_width(page) -> float:
    box = page.locator("[data-testid=files-panel]").bounding_box()
    return box["width"] if box else 0.0


def server_prefs(page) -> dict:
    return page.evaluate("() => fetch('/api/v1/me/prefs').then((r) => r.json()).then((j) => j.prefs ?? {})")


def main() -> int:
    args = parse_args()
    scope = uuid.uuid4().hex
    cookie = f"document.cookie = 'e2e-prefs-scope={scope}; path=/';"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        first = open_studio(browser, args.port, DATASET, init_script=cookie)
        a = first.page
        try:
            a.wait_for_selector("[data-testid=image-canvas] canvas", timeout=30000)
            a.wait_for_selector("[data-testid=files-panel]", timeout=20000)
            a.wait_for_timeout(500)
            w0 = left_width(a)
            right = a.locator("[data-testid=files-panel]").bounding_box()
            # The dockview sash on the left column's right edge.
            sash = a.evaluate(
                """(edge) => {
                  const all = [...document.querySelectorAll('.dv-sash, .sash')].map((el) => el.getBoundingClientRect())
                    .filter((r) => r.height > r.width && r.height > 100);
                  all.sort((p, q) => Math.abs(p.x + p.width / 2 - edge) - Math.abs(q.x + q.width / 2 - edge));
                  const r = all[0];
                  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
                }""",
                right["x"] + right["width"],
            )
            check("found the left column's sash", sash is not None)
            a.mouse.move(sash["x"], sash["y"])
            a.mouse.down()
            a.mouse.move(sash["x"] + 60, sash["y"], steps=6)
            a.mouse.move(sash["x"] + 120, sash["y"], steps=6)
            a.mouse.up()
            w1 = wait_for(lambda: (w := left_width(a)) > w0 + 60 and w, "the left column to widen")
            check("dragging the sash widens the left column", w1 > w0 + 60, f"{w0:.0f} → {w1:.0f}px")
            prefs = wait_for(lambda: (p := server_prefs(a)).get(LAYOUT_KEY) and p, f"{LAYOUT_KEY} on the server", timeout=10)
            check(f"the layout is saved server-side as {LAYOUT_KEY} (after the 500 ms debounce)", LAYOUT_KEY in prefs, ", ".join(sorted(prefs)))

            # A second device: a fresh context, nothing in localStorage.
            second = open_studio(browser, args.port, DATASET, init_script=cookie)
            b = second.page
            b.wait_for_selector("[data-testid=image-canvas] canvas", timeout=30000)
            b.wait_for_selector("[data-testid=files-panel]", timeout=20000)
            check("the second context starts with no cached layout", b.evaluate("() => Object.keys(localStorage).filter((k) => k.includes('-layout-')).length") <= 1)
            w2 = wait_for(lambda: (w := left_width(b)) and abs(w - w1) <= 4 and w, "the second context to apply the layout", timeout=10)
            check("the second context opens with the first one's layout", abs(w2 - w1) <= 4, f"{w1:.0f} vs {w2:.0f}px")
            check("no page errors", not first.errors and not second.errors, "; ".join((first.errors + second.errors)[:3]))
            second.page.context.close()
        except Exception as e:  # noqa: BLE001
            check("ran to the end", False, repr(e))
        finally:
            a.context.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
