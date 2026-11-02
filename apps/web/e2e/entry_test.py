"""todo13 Milestone 1 (`todo13-entry`) in seed mode: one composer, the sidebar, the empty states,
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


DROP_PNGS = """async ([selector, n]) => {
  const el = document.querySelector(selector);
  const dt = new DataTransfer();
  for (let i = 0; i < n; i++) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], `scan-${i}.png`, { type: 'image/png' }));
  for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}"""


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

        # ---- Home with no projects: the composer; a send creates the project (D1) ------------
        ctx, page, errors = fresh()
        created: list[dict] = []
        page.route("**/api/v1/projects?*", json_route({"projects": []}))
        page.route("**/api/v1/projects", lambda r: (created.append(r.request.post_data_json), json_route({"id": P, "title": "Segment liver CT"}, 201)(r)) if r.request.method == "POST" else json_route({"projects": []})(r))
        page.goto(f"{base}/?timeline=1")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        page.wait_for_selector("[data-testid=home-composer][data-align=center]", timeout=10000)
        check("with no projects, one centered composer", True)
        check("Home shows the composer", page.locator("[data-testid=home-composer] h2").first.inner_text() == "What are you working on?")
        check("Home has the goal field and no examples", page.locator("[data-testid=goal]").count() == 1 and page.locator("[data-testid=goal-example]").count() == 0)
        check("no project form on Home", page.locator("[data-testid=new-project]").count() == 0)
        shot(page, "home-empty")
        page.locator("[data-testid=goal]").fill("Segment liver CT")
        page.locator("[data-testid=goal]").press("Enter")
        page.wait_for_url(f"**/projects/{P}/overview", timeout=10000)
        check("send creates a project named from the goal", created and created[0]["title"] == "Segment liver CT", json.dumps(created))
        check("the project opens with the drawer", bool(page.wait_for_selector("[data-testid=agent-drawer]", timeout=10000)))
        pending = page.evaluate(f"async () => (await import('{PENDING}')).usePendingAsks.getState().asks")
        # Without the agent service the drawer can't send: the message waits for it, unlost.
        check("the message is queued for the conversation", (pending.get(P) or {}).get("text") == "Segment liver CT", json.dumps(pending))
        steps = page.evaluate(f"async () => (await import('{TIMELINE}')).dropTimeline().steps.map(s => s.step)")
        check("the timeline has the gesture and the project", steps[:2] == ["gesture", "project-created"], str(steps))
        check("?timeline=1 shows the overlay across pages", page.locator("[data-testid=drop-timeline] [data-step=project-created]").count() == 1)
        check("no page errors (home send)", not errors, "; ".join(errors))
        ctx.close()

        # ---- Home with no projects: a drop of 12 PNGs creates the project and hands the files over
        ctx, page, errors = fresh()
        created = []
        page.route("**/api/v1/projects?*", json_route({"projects": []}))
        page.route("**/api/v1/projects", lambda r: (created.append(r.request.post_data_json), json_route({"id": P, "title": "12 images"}, 201)(r)) if r.request.method == "POST" else json_route({"projects": []})(r))
        # The stand-in can't make drops (501): answer the drop as the API would.
        drops: list[dict] = []
        page.route(f"**/api/v1/projects/{P}/drops", lambda r: (drops.append(r.request.post_data_json), json_route({"id": r.request.post_data_json.get("id"), "state": "uploading", "files": []}, 201)(r)))
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        page.evaluate(DROP_PNGS, ["[data-testid=home-composer]", 12])
        page.wait_for_url(f"**/projects/{P}/overview", timeout=10000)
        check("a drop creates a project named from the kinds, not the names", created and created[0]["title"] == "12 images", json.dumps(created))
        page.wait_for_timeout(500)
        check("the drop is shared in the project's conversation (D1, D2)", len(drops) == 1 and drops[0].get("origin") == "home" and str(drops[0].get("conversationId", "")).startswith("conv-") and drops[0].get("files") == 12, json.dumps(drops)[:300])
        page.wait_for_selector("[data-testid=attestation]", timeout=10000)
        check("the files go to the uploader (attestation first)", "12" in page.locator("[data-testid=attestation]").inner_text())
        steps = page.evaluate(f"async () => (await import('{TIMELINE}')).dropTimeline().steps.map(s => s.step)")
        check("the timeline marks the upload start", "upload-start" in steps, str(steps))
        page.keyboard.press("Escape")
        check("no page errors (home drop)", not errors, "; ".join(errors))
        ctx.close()

        # ---- Home with projects: a send asks where it goes (§3.4) ----------------------------
        ctx, page, errors = fresh()
        page.goto(f"{base}/")
        page.wait_for_selector("[data-testid=project-card]", timeout=20000)
        shot(page, "home-with-projects")
        projects = page.evaluate("async () => (await (await fetch('/api/v1/projects')).json()).projects")
        if all(p.get("sample") for p in projects):
            # Samples are never the default target: the send creates a project straight away.
            page.route("**/api/v1/projects", lambda r: json_route({"id": P, "title": "x"}, 201)(r) if r.request.method == "POST" else r.continue_())
            page.locator("[data-testid=goal]").fill("Classify skin lesions")
            page.locator("[data-testid=composer-send]").click()
            page.wait_for_url(f"**/projects/{P}/overview", timeout=10000)
            check("with only samples, a send starts a new project", True)
        else:
            page.locator("[data-testid=goal]").fill("Classify skin lesions")
            page.locator("[data-testid=composer-send]").click()
            check("with projects, a send asks: last project or new", page.locator("[data-testid=home-target-dialog]").is_visible())
        check("no page errors (home with projects)", not errors, "; ".join(errors))
        ctx.close()

        # ---- Projects with none: the same composer --------------------------------------------
        ctx, page, errors = fresh()
        page.route("**/api/v1/projects?*", json_route({"projects": []}))
        page.goto(f"{base}/projects")
        page.wait_for_selector("[data-testid=home-composer]", timeout=20000)
        check("Projects with none shows Home's composer", page.locator("[data-testid=home-composer]").count() == 1)
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
        check("Overview keeps tell-assistant and the drop zone", page.locator("[data-testid=tell-assistant]").count() == 1 and page.locator("[data-testid=empty-project] [data-testid=drop-zone]").count() == 1)
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
        check("Files: Ask the assistant", page.locator("[data-testid=files-empty] [data-testid=composer-ask]").count() == 1)
        shot(page, "files-empty")
        ctx.close()

        ctx, page, errors = fresh()
        page.route(f"**/api/v1/projects/{P}/datasets", json_route({"datasets": []}))
        page.goto(f"{base}/projects/{P}/datasets")
        page.wait_for_selector("[data-testid=datasets-empty]", timeout=20000)
        t = page.locator("[data-testid=datasets-empty]").inner_text()
        check("Datasets: datasets-empty with drop, ask and create", "Drop files" in t and "Ask the assistant" in t and "Create dataset" in t, t)
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
        check("an empty canvas says how to start", "Drop files here to start" in t, t)
        shot(page, "studio-canvas-empty")
        check("no page errors (studio)", not errors, "; ".join(errors))
        ctx.close()

        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
