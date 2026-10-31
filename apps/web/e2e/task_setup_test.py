"""todo8 D7: Task setup, a page instead of the Studio's settings dialog.

Injects a classification task on the 2D X-ray images (a `Choices` question plus a region group,
so the paint tools are usable), then on /projects/<id>/tasks/<id>/setup:

- adds a class with a key → the Studio shows it (and the decision bar, when that bar exists) and
  the key picks it;
- unticks the Paint group (Brush and its siblings) → the toolbar has no paint tools;
- Undo in the "Task setup changed" toast restores both;
- module ids show only after opening Technical details.

Environment saves are answered in memory by the test (GET/PUT /api/environments/<id>), so the
seed server's seed-data/.environments/ is never written.

    python3 e2e/task_setup_test.py --port 5199
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import NAMING, launch, open_studio, parse_args, sync_playwright  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
NS = NAMING["namespace"]
PID = "task-setup-demo"
RENDERER = f"{NS}.image2d.renderers.cornerstone-stack"
PAINT = {"brush", "eraser", "wand"}
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=30.0, every=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001 — page may be mid-load
            pass
        time.sleep(every)
    return last


def demo_project() -> dict:
    manifest = json.loads((REPO / "seed-data" / "manifest.json").read_text())
    xray = next(p for p in manifest["projects"] if p["id"] == "2d-xray")
    return {
        "id": PID,
        "title": "Task setup demo",
        "source": "seed reuse",
        "license": xray["license"],
        "status": "available",
        "assets": xray["assets"][:4],
        "environment": {
            "extends": "preset:image-2d",
            "task": "classification",
            "labels": [
                {"name": "finding", "control": "Choices", "classes": [{"id": "normal", "color": "chart-1"}, {"id": "pneumonia", "color": "chart-2"}]},
                {"name": "regions", "control": "Labels", "classes": [{"id": "opacity", "color": "chart-3"}]},
            ],
        },
    }


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        st = open_studio(browser, args.port, PID, extra_projects=[demo_project()], fixture_annotations=[])
        page = st.page
        # In-memory environment edits for this task (the real endpoint writes seed-data/.environments/).
        saved: dict = {"doc": {"revision": 0, "environment": None}}
        puts: list[dict] = []

        def environments(route) -> None:
            req = route.request
            if req.method == "PUT":
                body = json.loads(req.post_data or "{}")
                puts.append(body)
                saved["doc"] = {"revision": saved["doc"]["revision"] + 1, "environment": body.get("environment"), "author": body.get("author")}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(saved["doc"]))

        page.route(f"**/api/environments/{PID}", environments)
        base = f"http://localhost:{args.port}"
        studio_url = f"{base}/projects/{PID}/studio/{PID}"
        setup_url = f"{base}/projects/{PID}/tasks/{PID}/setup"

        def tools() -> list[str]:
            return st.store("s => s.env ? s.env.tools.map(t => t.name) : null") or []

        def toolbar_tools() -> set[str]:
            return set(page.eval_on_selector_all("[role=toolbar][aria-label='Annotation tools'] [data-tool]", "els => els.map(e => e.dataset.tool)"))

        try:
            # 0. The Studio: no settings button any more; the paint tools are there.
            page.wait_for_selector("[role=toolbar][aria-label='Annotation tools'] [data-tool]", timeout=90000)  # a cold dev server compiles first
            check("Studio header has no Environment settings button", page.locator("[aria-label='Environment settings']").count() == 0)
            # The Paint group folds into one split button (todo8 D4 Rule 2): its face is in the toolbar, all three in env.tools.
            check("paint tools in the toolbar before", PAINT <= set(tools()) and bool(PAINT & toolbar_tools()), str(sorted(toolbar_tools())))

            # 1. Task setup page.
            page.goto(setup_url)
            page.wait_for_selector("[data-testid=setup-section-labels]", timeout=30000)
            text = page.inner_text("[data-testid=task-setup-page]")
            check("sections in plain words", all(s in text for s in ["Labels", "Tools", "Viewer", "Panels", "Export formats", "Annotators see", "Technical details"]), text[:200])
            check("module ids hidden until Technical details opens", RENDERER not in text and page.get_by_text(RENDERER).count() == 0)
            page.get_by_test_id("technical-details").click()
            page.wait_for_selector("[data-testid=technical-details-body]")
            check("Technical details shows module ids and JSON Pointers", RENDERER in page.inner_text("[data-testid=technical-details-body]") and "/viewports/0/renderer" in page.inner_text("[data-testid=technical-details-body]"))
            page.get_by_test_id("view-json").click()
            check("View JSON shows the spec as written", '"preset:image-2d"' in page.inner_text("[data-testid=setup-json]"))
            page.get_by_test_id("technical-details").click()
            check("closing Technical details hides the ids again", page.get_by_text(RENDERER).count() == 0)
            check("blind by default: source labels unticked for classification", page.get_by_test_id("show-source-labels").get_attribute("data-state") == "unchecked")

            # 2. Add a class with a key; a conflicting key is caught first.
            group = page.locator("[data-testid=label-group][data-group=finding]")
            group.get_by_test_id("add-class").click()
            row = group.locator("[data-testid=class-row]").last
            row.get_by_test_id("class-name").fill("Effusion")
            brush_key = st.store("s => s.env.tools.find(t => t.name === 'brush')?.hotkey")
            row.get_by_test_id("class-key").fill(brush_key)
            conflict = wait(lambda: row.get_by_test_id("class-key-conflict").count() == 1, 5)
            check("a key the Brush tool uses is flagged and blocks Save", bool(conflict) and page.get_by_test_id("setup-save").is_disabled(), row.inner_text())
            row.get_by_test_id("class-key").fill("3")
            check("key 3 (its own position) is fine", wait(lambda: row.get_by_test_id("class-key-conflict").count() == 0, 5) is True)

            # 3. Untick the Paint group.
            page.locator("[data-testid=tool-group-toggle][data-group=mask]").click()
            unticked = [page.locator(f"[data-testid=tool-toggle][data-tool={t}]").get_attribute("data-state") for t in sorted(PAINT)]
            check("Paint group unticks Brush, Eraser and Magic wand", unticked == ["unchecked"] * 3, str(unticked))

            # 4. One Save.
            page.get_by_test_id("setup-save").click()
            toast = page.locator("[data-sonner-toast]", has_text="Task setup changed")
            check("toast: Task setup changed · Undo", bool(wait(lambda: toast.count() == 1 and toast.locator("button", has_text="Undo").count() == 1, 15)))
            env_after = st.store("s => ({ classes: s.env.labels[0].classes.map(c => [c.id, c.hotkey ?? null]), tools: s.env.tools.map(t => t.name) })")
            check("saved through patchEnvironment: class added, paint tools off", ["effusion", "3"] in env_after["classes"] and not (PAINT & set(env_after["tools"])), str(env_after))
            check("saved as an environment revision (PUT) with an author", len(puts) == 1 and puts[0]["environment"]["labels"][0]["classes"][-1]["id"] == "effusion" and bool(puts[0].get("author")), str(puts[-1:])[:300])

            # 5. In the Studio (a client-side link, like a person would).
            page.get_by_test_id("setup-open-studio").click()
            page.wait_for_selector("[role=toolbar][aria-label='Annotation tools'] [data-tool]", timeout=30000)
            check("Studio toolbar has no paint tools", not (PAINT & toolbar_tools()), str(sorted(toolbar_tools())))
            page.get_by_role("tab", name="Labels").first.click()
            check("Studio's Labels panel lists Effusion", bool(wait(lambda: page.get_by_text("effusion", exact=False).count() > 0, 10)))
            bar = page.locator("[data-testid=decision-bar]")
            if bar.count():
                check("decision bar offers Effusion", "effusion" in bar.inner_text().lower(), bar.inner_text())
            else:
                print("SKIP decision bar not in this build", flush=True)
            # Keys reach the Studio once the viewer is up (a key pressed while it mounts is lost).
            page.wait_for_selector("[data-testid=image-canvas] canvas", timeout=30000)
            page.wait_for_timeout(500)
            page.locator("main[aria-label=Viewer]").click(position={"x": 5, "y": 5})
            page.keyboard.press("3")
            picked = wait(lambda: st.store("s => s.activeLabel === 'effusion' || s.annotations.some(a => a.label === 'effusion')"), 5)
            check("key 3 picks Effusion in the Studio", bool(picked), str(st.store("s => s.activeLabel")))

            # 6. Undo: the same edit from a fresh page (the task back at its manifest setup), undone from its toast.
            page.goto(setup_url)
            page.wait_for_selector("[data-testid=setup-section-labels]", timeout=30000)
            check("setup page shows the saved class", page.locator("[data-testid=class-row][data-class=effusion]").count() == 1)
            saved["doc"] = {"revision": saved["doc"]["revision"] + 1, "environment": None}
            page.reload()
            page.wait_for_selector("[data-testid=setup-section-labels]", timeout=30000)
            group = page.locator("[data-testid=label-group][data-group=finding]")
            group.get_by_test_id("add-class").click()
            row = group.locator("[data-testid=class-row]").last
            row.get_by_test_id("class-name").fill("Effusion")
            row.get_by_test_id("class-key").fill("3")
            page.locator("[data-testid=tool-group-toggle][data-group=mask]").click()
            page.get_by_test_id("setup-save").click()
            toast = page.locator("[data-sonner-toast]", has_text="Task setup changed")
            wait(lambda: toast.count() == 1, 15)
            toast.locator("button", has_text="Undo").click()
            restored = wait(lambda: (lambda e: e if e and "effusion" not in e["classes"] and PAINT <= set(e["tools"]) else None)(st.store("s => s.env && ({ classes: s.env.labels[0].classes.map(c => c.id), tools: s.env.tools.map(t => t.name) })")), 10)
            check("Undo restores the classes and the paint tools", bool(restored), str(restored))
            check("the undo is saved too", bool(wait(lambda: saved["doc"]["environment"] is not None and "effusion" not in json.dumps(saved["doc"]["environment"]), 10)), json.dumps(saved["doc"])[:200])
            check("setup page shows the restored state", bool(wait(lambda: page.locator("[data-testid=class-row][data-class=effusion]").count() == 0 and page.locator("[data-testid=tool-toggle][data-tool=brush]").get_attribute("data-state") == "checked", 10)))
            page.goto(studio_url)
            page.wait_for_selector("[role=toolbar][aria-label='Annotation tools'] [data-tool]", timeout=30000)
            check("after Undo the Studio has the paint tools again", bool(wait(lambda: PAINT <= set(tools()) and bool(PAINT & toolbar_tools()), 10)), str(sorted(toolbar_tools())))
            check("after Undo the Studio has no Effusion", "effusion" not in (st.store("s => s.env.labels.flatMap(g => g.classes.map(c => c.id))") or []))
            check("no console errors", not st.errors, str(st.errors[:3]))
        finally:
            page.context.close()
            browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
