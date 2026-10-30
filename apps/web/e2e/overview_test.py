"""Project Overview in seed mode (todo6 Phase 3): the resume card restores item and tool after a
reload, data cards link to Sources, attention is empty for seeds, and no element shows a number
the API didn't return.

    python3 e2e/overview_test.py --port 5199
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import STORE, launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


def store(page, expr: str):
    return page.evaluate(f"async () => {{ const m = await import('{STORE}'); return ({expr})(m.useStudio.getState()); }}")


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Saves are answered in memory (as in harness.open_studio), so nothing is written.
        page.route("**/api/annotations/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({**json.loads(r.request.post_data or "{}"), "revision": 2})) if r.request.method == "PUT" else r.continue_())
        api_numbers: set[str] = set()

        def record(resp):
            if "/api/" in resp.url and resp.request.method == "GET" and "json" in (resp.headers.get("content-type") or ""):
                try:
                    api_numbers.update(re.findall(r"\d+", resp.text()))
                except Exception:  # noqa: BLE001
                    pass

        page.on("response", record)

        # Home lists the samples, with the Sample badge and no metrics.
        page.goto(base + "/")
        page.wait_for_selector("[data-testid=project-card]", timeout=20000)
        check("Home asks what you're working on", page.get_by_role("heading", name="What are you working on?").count() == 1)
        check("Home shows recent project cards", page.locator("[data-testid=project-card]").count() >= 1)
        check("sample projects are badged", page.locator("[data-testid=project-card]").first.get_by_text("Sample").count() == 1)

        # Work in the Studio: item 3, the box tool. Resume is written as you go.
        page.goto(f"{base}/projects/2d-xray/studio/2d-xray")
        page.wait_for_selector("main[aria-label='Viewer']", timeout=30000)
        page.wait_for_timeout(1500)
        page.evaluate(f"async () => {{ const m = await import('{STORE}'); const s = m.useStudio.getState(); s.setItemIndex(3); s.setTool('box'); }}")
        page.wait_for_timeout(2500)
        item = store(page, "s => s.itemIndex")

        # Overview: the resume card names the item and opens it again with the same tool.
        page.goto(f"{base}/projects/2d-xray/overview")
        page.wait_for_selector("[data-testid=resume-card]", timeout=20000)
        page.reload()
        page.wait_for_selector("[data-testid=resume-progress]", timeout=20000)
        check("resume card shows progress from the API", re.fullmatch(r"\d+ of \d+ annotated", page.locator("[data-testid=resume-progress]").inner_text()) is not None, page.locator("[data-testid=resume-progress]").inner_text())
        check("resume card names the item", "IM-0006-0001.jpeg" in page.locator("[data-testid=resume-item]").inner_text(), page.locator("[data-testid=resume-item]").inner_text())
        page.locator("[data-testid=resume-card] [data-testid=open-studio]").click()
        page.wait_for_selector("main[aria-label='Viewer']", timeout=30000)
        page.wait_for_timeout(1500)
        check("Open Studio restores the item", store(page, "s => s.itemIndex") == item == 3, str(store(page, "s => s.itemIndex")))
        check("Open Studio restores the tool", store(page, "s => s.tool") == "box", store(page, "s => s.tool"))

        # Data cards open Sources; nothing needs attention in a seed.
        page.goto(f"{base}/projects/2d-xray/overview")
        page.wait_for_selector("[data-testid=data-card]", timeout=20000)
        href = page.locator("[data-testid=data-card]").first.get_attribute("href") or ""
        check("data cards link to Sources", "/projects/2d-xray/sources/" in href, href)
        check("attention is empty for seeds", page.locator("[data-testid=all-caught-up]").inner_text() == "You're all caught up.")

        # Every number on the page came from an API response (never a placeholder 0).
        text = page.locator("[data-testid=overview]").inner_text()
        shown = set(re.findall(r"\d+", text))
        unexplained = sorted(n for n in shown if n not in api_numbers and n not in re.findall(r"\d+", "2d-xray IM-0006-0001.jpeg Chest X-ray"))
        check("no number the API didn't return", not unexplained, ", ".join(unexplained))

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
