"""The way in, in seed mode: Home lists projects and starts one only through "New project" (a name,
then its Overview, which for an empty project is only the chat); the sidebar, the empty states,
the canvas drop target, the feature flags and the drop timeline overlay.

The seed stand-in is read-only (creating projects answers 501), so the writes are answered by
Playwright routes: `POST /api/v1/projects` returns the 2d-xray sample as "the new project", and
the empty states come from emptied copies of the stand-in's answers. Uploads stop at the
attestation dialog (the uploader itself is the drops workstream's and the full-stack e2e's).

    python3 e2e/entry_test.py --port 5199 [--shots DIR]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"
PENDING = "/src/studio/app/entry/pending-ask.ts"
TIMELINE = "/src/studio/lib/drop-timeline.ts"
SHOTS: Path | None = None


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def shot(page, name: str) -> None:
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


def json_route(body, status: int = 200):
    return lambda route: route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def patched(transform):
    """Answer with the stand-in's own response, transformed."""

    def handle(route):
        r = route.fetch()
        route.fulfill(response=r, body=json.dumps(transform(r.json())))

    return handle


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

        def fresh():
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            return ctx, page, errors

        # ---- No projects: `/` is Projects, no composer, one way in ("New project") ------------
        ctx, page, errors = fresh()
        created: list[dict] = []
        empty_overview = patched(lambda o: {**o, "empty": True, "data": [], "tasks": [], "resume": None, "latestImport": None, "project": {**o["project"], "title": "Liver CT"}})
        page.route("**/api/v1/projects?*", json_route({"projects": []}))
        page.route("**/api/v1/projects", lambda r: (created.append(r.request.post_data_json), json_route({"id": P, "title": "Liver CT"}, 201)(r)) if r.request.method == "POST" else json_route({"projects": []})(r))
        page.route(f"**/api/v1/projects/{P}/overview", empty_overview)
        page.goto(f"{base}/?timeline=1")
        page.wait_for_selector("[data-testid=no-projects]", timeout=20000)
        check("/ opens Projects", page.url.split("?")[0].endswith("/projects"), page.url)
        check("no composer before a project exists", page.locator("[data-testid=home-composer], [data-testid=goal]").count() == 0)
        check("with no projects, New project is the way in", page.locator("[data-testid=no-projects] [data-testid=new-project]").count() == 1)
        shot(page, "home-empty")
        page.locator("[data-testid=no-projects] [data-testid=new-project]").click()
        page.wait_for_selector("[data-testid=new-project-dialog]", timeout=10000)
        page.locator("[data-testid=new-project-name]").fill("Liver CT")
        check("nothing is created before Create", not created, json.dumps(created))
        page.locator("[data-testid=new-project-create]").click()
        page.wait_for_url(f"**/projects/{P}/overview", timeout=10000)
        check("Create makes the project with its name", created and created[0]["title"] == "Liver CT", json.dumps(created))
        page.wait_for_selector("[data-testid=empty-project]", timeout=10000)
        check("an empty project's Overview is only the chat", page.locator("[data-testid=empty-project-input]").count() == 1 and page.locator("[data-testid=data-card], [data-testid=attention]").count() == 0)
        check("the drawer doesn't open on its own", page.locator("[data-testid=agent-drawer-collapsed]").count() == 1)
        check("the empty Overview carries the AI notice", page.locator("[data-testid=empty-project] [data-testid=ai-notice]").count() == 1)
        check("the Overview composer has focus", page.evaluate("document.activeElement?.getAttribute('data-testid')") == "empty-project-input")
        page.route("**/api/agent/sessions", json_route({"error": "The agent service isn't running"}, 502))
        page.locator("[data-testid=empty-project-input]").fill("Segment liver CT")
        page.locator("[data-testid=empty-project-input]").press("Enter")
        check("a send opens the drawer", bool(page.wait_for_selector("[data-testid=agent-drawer]", timeout=10000)))
        pending = page.evaluate(f"async () => (await import('{PENDING}')).usePendingAsks.getState().asks")
        check("the message is queued for the conversation", (pending.get(P) or {}).get("text") == "Segment liver CT", json.dumps(pending))
        check("no page errors (new project)", not errors, "; ".join(errors))
        ctx.close()

        # ---- With projects: the cards and New project, nothing else, no Home in the sidebar ----
        ctx, page, errors = fresh()
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=project-card]", timeout=20000)
        shot(page, "home-with-projects")
        check("Projects: cards and New project, no composer", page.locator("[data-testid=projects-new-project]").count() == 1 and page.locator("[data-testid=home-composer]").count() == 0)
        check("the sidebar has Projects and no Home", page.locator("[data-testid=project-sidebar]").get_by_role("link", name="Home", exact=True).count() == 0 and page.locator("[data-testid=project-sidebar]").get_by_role("link", name="Projects", exact=True).count() == 1)
        page.locator("[data-testid=projects-new-project]").click()
        check("Projects' New project opens the name dialog", bool(page.wait_for_selector("[data-testid=new-project-dialog]", timeout=10000)))
        check("no page errors (projects)", not errors, "; ".join(errors))
        ctx.close()

        # ---- Sidebar (D10) and the datasets flag (§7.1) ----------------------------------------
        ctx, page, errors = fresh()
        page.goto(f"{base}/projects/{P}/overview")
        side = page.locator("[data-testid=project-sidebar]")
        side.wait_for(timeout=20000)
        labels = [t.strip() for t in side.locator("nav > ul").first.locator("a").all_inner_texts()]
        check("sidebar: Overview, Sources, Datasets, Studio, Review, Activity", labels == ["Overview", "Sources", "Datasets", "Studio", "Review", "Activity"], str(labels))
        check("Sources keeps the sources route", side.get_by_role("link", name="Sources", exact=True).get_attribute("href") == f"/projects/{P}/sources")
        ctx.close()
        ctx, page, errors = fresh()
        page.route("**/api/v1/features", json_route({"chatDrops": False, "autoApply": False, "fastPath": False, "datasetsTab": False}))
        page.goto(f"{base}/projects/{P}/overview")
        side = page.locator("[data-testid=project-sidebar]")
        side.wait_for(timeout=20000)
        labels = [t.strip() for t in side.locator("nav > ul").first.locator("a").all_inner_texts()]
        check("flags off: no Datasets in the sidebar (J12)", "Datasets" not in labels and "Sources" in labels, str(labels))
        check("flags off: the Datasets route still opens", (page.goto(f"{base}/projects/{P}/datasets"), page.wait_for_selector("[data-testid=datasets-page]", timeout=10000))[1] is not None)
        ctx.close()

        # ---- Empty states (§3.1) ---------------------------------------------------------------
        ctx, page, errors = fresh()
        page.route(f"**/api/v1/projects/{P}/overview", patched(lambda o: {**o, "empty": True, "tasks": [], "resume": None, "data": []}))
        page.goto(f"{base}/projects/{P}/overview")
        page.wait_for_selector("[data-testid=empty-project]", timeout=20000)
        check("Overview: empty-project with the composer", page.locator("[data-testid=empty-project] textarea").count() == 1)
        check("Overview keeps the drop zone",  page.locator("[data-testid=empty-project] [data-testid=drop-zone]").count() == 1)
        shot(page, "overview-empty")
        page.locator("[data-testid=empty-project-input]").fill("Outline the liver")
        page.locator("[data-testid=empty-project-input]").press("Enter")
        check("Overview's composer opens the drawer with the message", bool(page.wait_for_selector("[data-testid=agent-drawer]", timeout=10000)))
        pending = page.evaluate(f"async () => (await import('{PENDING}')).usePendingAsks.getState().asks")
        check("…queued for the conversation", (pending.get(P) or {}).get("text") == "Outline the liver", json.dumps(pending))

        page.goto(f"{base}/projects/{P}/studio")
        page.wait_for_selector("[data-testid=studio-empty]", timeout=20000)
        check("Studio entry with no task: studio-empty, not a redirect", page.url.endswith(f"/projects/{P}/studio"), page.url)
        shot(page, "studio-empty")
        ctx.close()

        ctx, page, errors = fresh()
        page.route(f"**/api/v1/projects/{P}/fs/children*", patched(lambda o: {**o, "items": [], "total": 0, "next": None}))
        page.goto(f"{base}/projects/{P}/sources")
        page.wait_for_selector("[data-testid=files-empty]", timeout=20000)
        check("Files: files-empty keeps drop-zone and the pickers", page.locator("[data-testid=files-empty] [data-testid=drop-zone]").count() == 1 and page.locator("[data-testid=files-empty] [data-testid=pick-folder]").count() == 1)
        check("Files: one Add files action", page.locator("[data-testid=files-empty] [data-testid=composer-add-files]").count() == 1)
        shot(page, "files-empty")
        ctx.close()

        ctx, page, errors = fresh()
        page.route(f"**/api/v1/projects/{P}/datasets", json_route({"datasets": []}))
        page.goto(f"{base}/projects/{P}/datasets")
        page.wait_for_selector("[data-testid=datasets-empty]", timeout=20000)
        t = page.locator("[data-testid=datasets-empty]").inner_text()
        check("Datasets: datasets-empty with create and ask", "Ask the assistant" in t and "Create dataset" in t, t)
        shot(page, "datasets-empty")
        ctx.close()

        # ---- The Studio canvas (D11) -------------------------------------------------------------
        ctx, page, errors = fresh()
        page.goto(f"{base}/projects/{P}/studio/{P}")
        page.wait_for_selector("[data-testid=studio-canvas-drop]", timeout=30000)
        check("the canvas with an item is a drop target", True)
        ctx.close()
        ctx, page, errors = fresh()
        page.route(f"**/api/v1/tasks/{P}/document*", patched(lambda d: {**d, "assets": []}))
        page.goto(f"{base}/projects/{P}/studio/{P}")
        page.wait_for_selector("[data-testid=studio-canvas-empty]", timeout=30000)
        t = page.locator("[data-testid=studio-canvas-empty]").inner_text()
        check("an empty canvas says how to start", "Add files" in t and page.locator("[data-testid=studio-canvas-empty] [data-testid=drop-zone]").count() == 1, t)
        shot(page, "studio-canvas-empty")
        check("no page errors (studio)", not errors, "; ".join(errors))
        ctx.close()

        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
