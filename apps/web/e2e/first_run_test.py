"""todo14 Milestone 0 in seed mode: the first run, seen as a brand-new dev person.

The account menu's dev section ("Start as a new person") picks a random `user:dev-<id>` for the
tab; every api and agent request carries it as `X-Dev-Principal`. The seed stand-in answers like
the api in dev: only `user:local-expert` (no header) belongs to the Samples org, so the new person
sees an empty Home (the composer, no Recent projects), an empty sidebar (no Recent), and no
"Or try a sample project" line until the api offers samples (`GET /v1/samples`, absent here).
"Back to local-expert" brings the samples back.

    python3 e2e/first_run_test.py --port 5199 [--shots DIR]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"
SHOTS: Path | None = None
DEV_PRINCIPAL = "/src/studio/lib/dev-principal.ts"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def shot(page, name: str) -> None:
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


def json_route(body, status: int = 200):
    return lambda route: route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def close_menu(page) -> None:
    page.keyboard.press("Escape")
    page.wait_for_selector("[data-testid=user-menu-content]", state="detached", timeout=5000)


def menu_action(page, testid: str) -> None:
    page.locator("[data-testid=user-menu]").click()
    page.locator(f"[data-testid={testid}]").click()


def main() -> int:
    global SHOTS
    if "--shots" in sys.argv:
        i = sys.argv.index("--shots")
        SHOTS = Path(sys.argv[i + 1]).resolve()
        del sys.argv[i : i + 2]
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        sent: list[tuple[str, str | None]] = []
        page.on("request", lambda r: "/api/" in r.url and sent.append((r.url, r.headers.get("x-dev-principal"))))

        # ---- local-expert (no header) sees the samples, as today (F7) ----------------------------
        page.goto(f"{base}/projects/{P}/overview")
        page.wait_for_selector("[data-testid=project-sidebar]", timeout=20000)
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=project-card]", timeout=20000)
        check("local-expert: Home lists the samples", page.locator("[data-testid=project-card]").count() > 0)
        check("local-expert: the sidebar has its Recent projects", page.locator("[data-testid=project-sidebar] h2", has_text="Recent").count() == 1)
        check("local-expert: no try-sample line among projects", page.locator("[data-testid=try-sample]").count() == 0)
        check("local-expert: requests carry no dev principal", all(h is None for _, h in sent), str([u for u, h in sent if h][:3]))
        page.locator("[data-testid=user-menu]").click()
        check("the dev account menu says who you are", page.locator("[data-testid=dev-principal]").inner_text() == "user:local-expert")
        check("…and offers no way back when you're already local-expert", page.locator("[data-testid=dev-default-person]").count() == 0)
        close_menu(page)

        # ---- Start as a new person: an empty product ----------------------------------------------
        sent.clear()
        menu_action(page, "dev-new-person")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        page.wait_for_selector("[data-testid=home-composer][data-align=center]", timeout=10000)
        principal = page.evaluate("() => Object.entries(sessionStorage).find(([k]) => k.endsWith('-dev-principal'))?.[1] ?? null")
        check("a random user:dev-<id> principal for this tab", bool(principal) and principal.startswith("user:dev-"), str(principal))
        page.wait_for_load_state("networkidle")
        project_reqs = [h for u, h in sent if "/api/v1/projects" in u]
        check("api requests carry X-Dev-Principal", bool(project_reqs) and all(h == principal for h in project_reqs), str(project_reqs[:3]))
        check("empty Home: the composer asks what you're working on", page.locator("[data-testid=home-composer] h2").first.inner_text() == "What are you working on?")
        check("empty Home: no project cards", page.locator("[data-testid=project-card]").count() == 0)
        check("empty Home: no Recent projects", page.get_by_text("Recent projects").count() == 0)
        check("try-sample stays hidden while the api offers no samples", page.locator("[data-testid=try-sample]").count() == 0)
        side = page.locator("[data-testid=project-sidebar]")
        headings = [t.strip() for t in side.locator("h2").all_inner_texts()]
        check("empty sidebar: Workspace and Settings, no Recent or conversations", headings == ["Workspace", "Settings"], str(headings))
        check("empty sidebar: Home and Projects stay reachable", side.get_by_role("link", name="Home", exact=True).count() == 1 and side.get_by_role("link", name="Projects", exact=True).count() == 1)
        shot(page, "first-run-home-empty")
        page.locator("[data-testid=user-menu]").click()
        check("the menu shows the new principal", page.locator("[data-testid=dev-principal]").inner_text() == principal)
        shot(page, "first-run-account-menu")
        close_menu(page)

        # The samples belong to the Samples org: a new person gets 404s (stand-in, like the api).
        r = page.request.get(f"{base}/api/v1/projects/{P}", headers={"X-Dev-Principal": principal})
        check("a sample project is a 404 for the new person", r.status == 404, str(r.status))
        r = page.request.get(f"{base}/api/v1/projects/{P}")
        check("…and still opens for local-expert", r.status == 200, str(r.status))

        # Projects with none: the same composer.
        page.goto(f"{base}/projects")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        check("Projects with none shows Home's composer", page.locator("[data-testid=project-card]").count() == 0)
        check("the principal survives navigation in the tab", page.evaluate(f"async () => (await import('{DEV_PRINCIPAL}')).devPrincipal()") == principal)

        # Once the api offers samples (M1), the quiet line appears under the empty composer.
        page.route("**/api/v1/samples", json_route({"enabled": True, "samples": [{"id": P, "title": "Chest X-rays", "modality": "X-ray", "license": "CC BY 4.0", "restricted": False}]}))
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=try-sample]", timeout=10000)
        check("try-sample shows when GET /v1/samples is enabled", page.locator("[data-testid=try-sample]").inner_text().strip() == "Or try a sample project")
        shot(page, "first-run-home-samples-enabled")
        page.unroute("**/api/v1/samples")
        page.route("**/api/v1/samples", json_route({"enabled": False, "samples": []}))
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        page.wait_for_load_state("networkidle")
        check("…and hides when it says disabled", page.locator("[data-testid=try-sample]").count() == 0)
        page.unroute("**/api/v1/samples")

        # ---- First send: the project opens empty with the drawer (todo13 D1) -----------------------
        # The stand-in can't create projects (501): answer as the api would, and let the new person
        # read the created project (the stand-in's sample, emptied) by dropping the header for it.
        created: list[dict] = []
        page.route("**/api/v1/projects", lambda r: (created.append(r.request.post_data_json), json_route({"id": P, "title": "Label chest X-rays"}, 201)(r)) if r.request.method == "POST" else r.fallback())

        def as_owner(route):
            headers = {k: v for k, v in route.request.headers.items() if k.lower() != "x-dev-principal"}
            res = route.fetch(headers=headers)
            if route.request.url.split("?")[0].endswith(f"/projects/{P}/overview"):
                route.fulfill(response=res, body=json.dumps({**res.json(), "empty": True, "tasks": [], "resume": None, "data": []}))
            else:
                route.fulfill(response=res)

        page.route(f"**/api/v1/projects/{P}/**", as_owner)
        page.route(f"**/api/v1/projects/{P}", as_owner)
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=goal]", timeout=20000)
        page.locator("[data-testid=goal]").fill("Label chest X-rays")
        page.locator("[data-testid=goal]").press("Enter")
        page.wait_for_url(f"**/projects/{P}/overview", timeout=10000)
        check("send creates the first project", bool(created) and created[0].get("title") == "Label chest X-rays", json.dumps(created))
        check("the project opens with the drawer", bool(page.wait_for_selector("[data-testid=agent-drawer]", timeout=10000)))
        page.wait_for_selector("[data-testid=empty-project]", timeout=10000)
        check("Overview shows the todo13 empty state", page.locator("[data-testid=tell-assistant]").count() == 1)
        page.wait_for_timeout(500)
        shot(page, "first-run-overview-drawer")
        page.unroute(f"**/api/v1/projects/{P}/**")
        page.unroute(f"**/api/v1/projects/{P}")
        page.unroute("**/api/v1/projects")

        # ---- Back to local-expert: the samples return -----------------------------------------------
        menu_action(page, "dev-default-person")
        page.wait_for_selector("[data-testid=project-card]", timeout=20000)
        check("back to local-expert: the samples are back", page.locator("[data-testid=project-card]").count() > 0)
        check("…the tab's dev principal is gone", page.evaluate(f"async () => (await import('{DEV_PRINCIPAL}')).devPrincipal()") is None)
        check("…and local-expert's Recent projects are intact", page.locator("[data-testid=project-sidebar] h2", has_text="Recent").count() == 1)
        check("no page errors", not errors, "; ".join(errors))
        ctx.close()
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
