"""todo21 W1 (D1, D2) in seed mode: New project is a name dialog.

Sidebar New -> name -> Create -> the project opens with its chat panel open and focused. A Home
drop opens the same dialog prefilled from the files' kinds; Create lands them in the new
project's first chat; Cancel creates nothing and says "Not uploaded". `N` opens the dialog on
Home. The seed stand-in can't create projects (501), so `POST /api/v1/projects` is answered by a
Playwright route with the 2d-xray sample as "the new project" (like entry_test.py).

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


DROP_XRAYS = """async ([selector, n]) => {
  const el = document.querySelector(selector);
  const dt = new DataTransfer();
  for (let i = 0; i < n; i++) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], `cxr-${i}.png`, { type: 'image/png' }));
  for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}"""


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

        # ---- Sidebar New -> name -> Create -> the chat opens focused (D1) ----------------------
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
        check("the project opens with the chat panel", bool(page.wait_for_selector("[data-testid=agent-drawer]", timeout=10000)))
        page.wait_for_timeout(500)
        # Without the agent service (seed e2e) the drawer says so and has no composer to focus.
        has_composer = page.locator("[data-testid=agent-drawer] textarea").count() > 0
        focused = page.evaluate("() => !!document.activeElement?.closest('[data-testid=agent-drawer]')")
        check("the chat composer is focused (when the drawer has one)", focused or not has_composer, f"composer={has_composer}")
        check("no page errors (sidebar new)", not errors, "; ".join(errors))
        ctx.close()

        # ---- N on Home opens the dialog; Cancel creates nothing ------------------------------
        created = []
        ctx, page, errors = fresh(created)
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        page.locator("body").click(position={"x": 5, "y": 5})
        page.evaluate("() => document.activeElement?.blur()")
        page.keyboard.press("n")
        check("N opens the dialog on Home", bool(page.wait_for_selector("[data-testid=new-project-dialog]", timeout=5000)))
        page.locator("[data-testid=new-project-cancel]").click()
        page.wait_for_timeout(300)
        check("Cancel creates nothing", not created, json.dumps(created))
        ctx.close()

        # ---- A Home drop opens the dialog prefilled; Cancel uploads nothing (D2) -------------
        created = []
        ctx, page, errors = fresh(created)
        # Like entry_test.py: with no projects the composer is the page's drop target.
        page.route("**/api/v1/projects?*", json_route({"projects": []}))
        drops: list[dict] = []
        page.route(f"**/api/v1/projects/{P}/drops", lambda r: (drops.append(r.request.post_data_json), json_route({"id": r.request.post_data_json.get("id"), "state": "uploading", "files": []}, 201)(r)))
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        page.evaluate(DROP_XRAYS, ["[data-testid=home-drop]", 3])
        page.wait_for_selector("[data-testid=new-project-dialog]", timeout=5000)
        value = page.locator("[data-testid=new-project-name]").input_value()
        check("the dialog is prefilled from the kinds, never 'N files'", value == "Chest X-rays", value)
        page.locator("[data-testid=new-project-cancel]").click()
        page.wait_for_timeout(300)
        check("Cancel on a drop creates nothing and uploads nothing", not created and not drops, json.dumps([created, drops]))
        check("the composer says the files weren't uploaded", "Not uploaded" in page.locator("[data-testid=home-composer]").inner_text())

        # ---- ...and Create lands the files in the new project's first chat ------------------
        page.evaluate(DROP_XRAYS, ["[data-testid=home-drop]", 3])
        page.wait_for_selector("[data-testid=new-project-dialog]", timeout=5000)
        page.locator("[data-testid=new-project-create]").click()
        page.wait_for_url(f"**/projects/{P}/**", timeout=10000)
        page.wait_for_timeout(800)
        check("Create makes the project with the suggestion", bool(created) and created[0]["title"] == "Chest X-rays", json.dumps(created))
        check("the drop is shared in the new project's chat", len(drops) == 1 and bool(drops[0].get("conversationId")), json.dumps(drops)[:300])
        check("no page errors (home drop)", not errors, "; ".join(errors))
        ctx.close()
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
