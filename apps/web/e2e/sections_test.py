"""Datasets, Review, Activity and Settings in seed mode (todo6 Phase 8).

- Datasets lists the sample's dataset and task; Open Studio opens the task; the dataset's tabs
  are Tasks · Versions · Publish & export (the old export page, with its formats); New dataset
  has the folder picker (breadcrumb + flat list) and a preset picker, and says it needs the API.
- Review: empty for a seed; an annotation suggestion (written to the e2e copy of the annotations)
  shows as a row that opens the task's Studio, and the same row is Overview's attention; the
  annotation review per task is the old review page.
- Activity names the sample loader; Settings › General is read-only for a sample;
  Settings › Plugins hosts the plugins page.

    python3 e2e/sections_test.py --port 5199
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


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        original = None
        try:
            # ---- Datasets ----
            page.goto(f"{base}/projects/{P}/datasets")
            page.wait_for_selector("[data-testid=dataset-card]", timeout=20000)
            card = page.locator(f"[data-testid=dataset-card][data-dataset-id='{P}']")
            check("Datasets lists the sample dataset", card.count() == 1)
            check("the dataset shows its task", card.locator(f"[data-testid=task-row][data-task-id='{P}']").count() == 1)
            card.locator("[data-testid=open-studio]").click()
            page.wait_for_url(f"**/projects/{P}/studio/{P}", timeout=10000)
            page.wait_for_selector("main[aria-label='Viewer']", timeout=30000)
            check("Open Studio opens the task", True)

            page.goto(f"{base}/projects/{P}/datasets?hint=no-task")
            page.wait_for_selector("[data-testid=no-task-hint]", timeout=10000)
            check("the no-task hint shows", True)

            page.goto(f"{base}/projects/{P}/datasets/{P}")
            page.wait_for_selector("[data-testid=dataset-tasks]", timeout=10000)
            check("dataset detail: Tasks tab", page.locator("[data-testid=dataset-detail]").get_attribute("data-tab") == "tasks")
            page.get_by_role("link", name="Versions", exact=True).click()
            page.wait_for_url(f"**/datasets/{P}/versions", timeout=10000)
            page.wait_for_selector("text=/Versioning is off|Every save is a commit/", timeout=10000)
            check("dataset detail: Versions tab hosts the versions page", page.locator("[data-testid=dataset-detail][data-tab=versions]").count() == 1)
            page.get_by_role("link", name="Publish & export").click()
            page.wait_for_selector("text=Standard formats", timeout=20000)
            check("dataset detail: Publish & export hosts the export page", page.get_by_role("button", name="Download").count() >= 1)
            check("one shell around the tab (no nested layout)", page.locator("header").count() == 1, str(page.locator("header").count()))

            page.goto(f"{base}/projects/{P}/datasets")
            page.get_by_test_id("new-dataset").click()
            dlg = page.get_by_test_id("new-dataset-dialog")
            dlg.wait_for(timeout=10000)
            dlg.locator("[data-testid=folder-row]").first.wait_for(timeout=10000)
            first = dlg.locator("[data-testid=open-folder]").first
            name = first.inner_text().split("\n")[0]
            first.click()
            page.wait_for_timeout(500)
            crumb = dlg.get_by_test_id("folder-breadcrumb").inner_text()
            check("folder picker opens a folder into the breadcrumb", bool(name) and name in crumb, f"{name!r} in {crumb!r}")
            dlg.locator("#pick-here").click()
            check("picking a folder is summarised", "1 picked" in dlg.get_by_test_id("picked-summary").inner_text(), dlg.get_by_test_id("picked-summary").inner_text())
            dlg.get_by_test_id("preset-picker").click()
            opts = page.get_by_role("option").count()
            check("preset picker lists the presets", opts >= 5, f"{opts} presets")
            page.get_by_role("option").first.click()
            dlg.locator("#dataset-title").fill("Batch one")
            dlg.get_by_test_id("create-dataset").click()
            dlg.get_by_role("alert").wait_for(timeout=10000)
            check("creating needs the full stack in seed mode", "full stack" in dlg.get_by_role("alert").inner_text())
            page.keyboard.press("Escape")

            # ---- Review ----
            page.goto(f"{base}/projects/{P}/review")
            page.wait_for_selector("[data-testid=review-empty]", timeout=10000)
            check("Review: nothing waits for a seed", page.locator("[data-testid=review-row]").count() == 0)
            page.locator(f"[data-testid=annotation-review-task][data-task-id='{P}']").click()
            page.wait_for_url(f"**/projects/{P}/review/{P}", timeout=10000)
            page.wait_for_selector("text=Validation", timeout=20000)
            check("annotation review per task is the old review page", page.get_by_role("heading", name="Annotations").count() >= 1 or page.locator("text=Annotations").count() >= 1)

            # An assistant suggestion nobody reviewed yet (written to the e2e temp copy).
            original = page.evaluate(f"async () => (await fetch('/api/annotations/{P}')).json()")
            doc = json.loads(json.dumps(original))
            a = dict(doc["annotations"][0])
            a.update({"id": "e2e-suggestion", "provenance": "ai-suggested", "attributes": {"review_status": "pending"}})
            doc["annotations"].append(a)
            page.evaluate(f"async (d) => fetch('/api/annotations/{P}', {{ method: 'PUT', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify(d) }})", doc)
            page.goto(f"{base}/projects/{P}/review")
            row = page.locator("[data-testid=review-row][data-type=annotations]")
            row.wait_for(timeout=10000)
            check("an annotation suggestion is a review row", "1 annotation to review" in row.inner_text(), row.inner_text())
            page.get_by_test_id("filter-type").click()
            page.get_by_role("option", name="Privacy holds").click()
            page.wait_for_selector("[data-testid=review-empty]", timeout=10000)
            check("type filter hides other rows", page.locator("[data-testid=review-row]").count() == 0 and "type=privacy" in page.url, page.url)
            page.get_by_role("button", name="Clear filters").click()
            row.wait_for(timeout=10000)
            row.click()
            page.wait_for_url(f"**/projects/{P}/studio/{P}", timeout=10000)
            check("the row opens the task's Studio", True)
            page.goto(f"{base}/projects/{P}/overview")
            att = page.locator("[data-testid=attention-row][data-type=annotations]")
            att.wait_for(timeout=10000)
            check("Overview's attention is the same queue", att.count() == 1)

            # ---- Activity ----
            page.goto(f"{base}/projects/{P}/activity")
            page.wait_for_selector("[data-testid=activity-entry]", timeout=10000)
            e = page.locator("[data-testid=activity-entry]").first
            check("Activity names the sample loader", e.get_by_test_id("activity-actor").inner_text() == "Sample data" and page.locator("[data-testid=activity-day]").count() == 1, e.inner_text())

            # ---- Settings ----
            page.goto(f"{base}/projects/{P}/settings")
            page.wait_for_selector("[data-testid=settings-general]", timeout=10000)
            check("Settings › General: a sample is read-only", page.get_by_test_id("sample-readonly").count() == 1 and page.locator("#project-title").is_disabled())
            page.get_by_role("link", name="Plugins", exact=True).last.click()
            page.wait_for_url("**/settings/plugins", timeout=10000)
            page.wait_for_selector("[data-testid=builtin-plugins], [data-testid=installed-plugins]", timeout=10000)
            if page.get_by_test_id("builtin-plugins").count():
                # Without the API the bundled plugins are listed (they need no install).
                check("Settings › Plugins lists the built-in plugins", page.locator("[data-testid=builtin-plugins] [data-plugin]").count() >= 5, str(page.locator("[data-testid=builtin-plugins] [data-plugin]").count()))
            check("Settings › Plugins hosts the plugins page", page.locator("[data-testid=settings-page][data-tab=plugins]").count() == 1)
            check("no page errors", not errors, str(errors[:3]))
        finally:
            if original is not None:
                page.evaluate(f"async (d) => fetch('/api/annotations/{P}', {{ method: 'PUT', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify(d) }})", original)
            ctx.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
