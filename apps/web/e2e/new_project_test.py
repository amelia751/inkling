"""New project is a name dialog, like making a folder (seed mode).

Sidebar New -> name -> Create -> the project opens on its Overview, the chat drawer shut; an empty
project's Overview is only its composer, focused. `N` opens the dialog on Projects; Cancel creates
nothing. The seed stand-in can't create projects (501), so `POST /api/v1/projects` is answered by
a Playwright route with the 2d-xray sample as "the new project" (like entry_test.py).

    python3 e2e/new_project_test.py --port 5199
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def json_route(body, status: int = 200):
    return lambda route: route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)

        def fresh(created: list):
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.route(
                "**/api/v1/projects",
                lambda r: (created.append(r.request.post_data_json), json_route({"id": P, "title": r.request.post_data_json.get("title")}, 201)(r))
                if r.request.method == "POST"
                else r.continue_(),
            )
            return ctx, page, errors

        # ---- Sidebar New -> name -> Create -> the Overview, the drawer shut --------------------
        created: list[dict] = []
        ctx, page, errors = fresh(created)
        page.goto(f"{base}/projects")
        page.wait_for_selector("[data-testid=sidebar-new]", timeout=20000)
        page.locator("[data-testid=sidebar-new]").click()
        page.wait_for_selector("[data-testid=new-project-dialog]", timeout=5000)
        page.locator("[data-testid=new-project-name]").fill("Liver CT")
        page.locator("[data-testid=new-project-name]").press("Enter")
        page.wait_for_url(f"**/projects/{P}/**", timeout=10000)
        check("Create names the project as typed", bool(created) and created[0]["title"] == "Liver CT", json.dumps(created))
        page.wait_for_url(f"**/projects/{P}/overview", timeout=10000)
        page.wait_for_selector("[data-testid=agent-drawer-collapsed]", timeout=10000)
        check("the project opens on its Overview with the drawer shut", page.locator("[data-testid=agent-drawer]").count() == 0)
        check("no page errors (sidebar new)", not errors, "; ".join(errors))
        ctx.close()

        # ---- N on Projects opens the dialog; Cancel creates nothing --------------------------
        created = []
        ctx, page, errors = fresh(created)
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=projects-new-project]", timeout=20000)
        page.locator("body").click(position={"x": 5, "y": 5})
        page.evaluate("() => document.activeElement?.blur()")
        page.keyboard.press("n")
        check("N opens the dialog on Projects", bool(page.wait_for_selector("[data-testid=new-project-dialog]", timeout=5000)))
        page.locator("[data-testid=new-project-cancel]").click()
        page.wait_for_timeout(300)
        check("Cancel creates nothing", not created, json.dumps(created))
        ctx.close()

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
