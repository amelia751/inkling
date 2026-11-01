"""Datasets, Phase 1 of docs/datasets.md, in seed mode.

- The landing page says what each dataset holds, counted at a stated level (§15.2), filters by
  modality and status, and switches between cards and a list.
- A dataset opens on its Overview (collections with previews); Structure lists collections and
  connections, and a row opens the inspector by keyboard (§15.18); Fields & Formats shows format
  apart from fields (§15.4) and a field's stable id; Annotations shows label classes by stable id;
  Quality says "No problems found" for a vetted sample; History names draft, main and release.
- The snapshot picker shows the working draft and never offers a draft as published.
- On a phone the inspector is a drawer.

    python3 e2e/datasets_test.py --port 5199
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        profile = page.request.get(f"{base}/api/v1/projects/{P}/datasets/{P}/profile").json()
        images = next(c for c in profile["collections"] if c["kind"] == "image")

        # ---- Landing ----
        page.goto(f"{base}/projects/{P}/datasets")
        card = page.locator(f"[data-testid=dataset-card][data-dataset-id='{P}']")
        card.wait_for(timeout=20000)
        check("Datasets is in the project sidebar", page.locator("aside nav, nav").get_by_role("link", name="Datasets", exact=True).count() >= 1)
        content = card.get_by_test_id("dataset-content")
        content.wait_for(timeout=10000)
        check("the card counts items at a stated level", f"{images['count']:,} images" in content.inner_text(), content.inner_text())
        check("the card has a status in words", card.get_by_test_id("dataset-status").inner_text() in ("Ready", "Draft", "Needs attention", "Processing"))
        page.get_by_test_id("filter-modality").click()
        page.get_by_role("option", name="Video").click()
        page.get_by_test_id("no-results").wait_for(timeout=5000)
        check("a modality filter that matches nothing says so", page.locator("[data-testid=dataset-card]").count() == 0)
        page.get_by_test_id("no-results").get_by_role("button", name="Clear filters").click()
        card.wait_for(timeout=5000)
        check("Clear filters brings the datasets back", card.count() == 1)
        page.get_by_role("radio", name="List").click()
        check("the list view shows one row per dataset", page.locator(f"[data-testid=dataset-row][data-dataset-id='{P}']").count() == 1)
        page.get_by_role("radio", name="Cards").click()

        # ---- Overview ----
        card.get_by_test_id("open-dataset").click()
        page.wait_for_url(f"**/projects/{P}/datasets/{P}", timeout=10000)
        page.get_by_test_id("dataset-overview").wait_for(timeout=10000)
        cc = page.locator("[data-testid=collection-card][data-collection='kind:image']")
        cc.wait_for(timeout=10000)
        check("Overview shows the image collection", cc.count() == 1)
        check("a collection says it was inferred", cc.get_by_test_id("suggested").count() == 1)
        check("a vetted sample has no problems", page.get_by_test_id("dataset-all-clear").count() == 1)
        check("the task is one click away", page.locator(f"[data-testid=dataset-tasks] [data-testid=task-row][data-task-id='{P}']").count() == 1)
        check("the latest release line is there", page.get_by_test_id("latest-release").count() == 1)

        # ---- Snapshot picker ----
        page.get_by_test_id("snapshot-picker").click()
        menu = page.get_by_role("menu")
        menu.wait_for(timeout=5000)
        check("the picker shows the working draft", "Working draft" in menu.inner_text() and "not published" in menu.inner_text())
        page.keyboard.press("Escape")

        # ---- Structure ----
        page.get_by_role("link", name="Structure", exact=True).click()
        page.wait_for_url(f"**/datasets/{P}/structure", timeout=10000)
        row = page.locator("[data-testid=structure-collection][data-collection='kind:image']")
        row.wait_for(timeout=10000)
        row.focus()
        page.keyboard.press("Enter")
        page.get_by_test_id("dataset-inspector").wait_for(timeout=5000)
        check("a collection opens its inspector from the keyboard", "Images" in page.get_by_test_id("dataset-inspector").inner_text())
        check("the selection is in the URL", "select=kind%3Aimage" in page.url or "select=kind:image" in page.url, page.url)
        page.get_by_test_id("inspector-close").click()
        check("the inspector closes", page.get_by_test_id("dataset-inspector").count() == 0)
        page.get_by_test_id("structure-search").fill("zzz")
        check("a search with no match says so", page.get_by_test_id("no-results").count() == 1)

        # ---- Fields & Formats ----
        page.get_by_role("link", name="Fields & Formats").click()
        page.wait_for_url(f"**/datasets/{P}/fields", timeout=10000)
        page.get_by_test_id("collection-shape").wait_for(timeout=10000)
        check("format is shown apart from fields", page.get_by_test_id("collection-format").count() == 1)
        fields = page.locator("[data-testid=field-row]")
        if fields.count():
            fields.first.get_by_role("button").click()
            page.get_by_test_id("field-facts").wait_for(timeout=5000)
            check("a field shows its stable id", "fact:" in page.get_by_test_id("dataset-inspector").inner_text())
        else:
            check("a collection without recorded facts says so", "didn't record" in page.get_by_test_id("collection-format").inner_text())

        # ---- Annotations ----
        page.get_by_role("link", name="Annotations", exact=True).click()
        page.wait_for_url(f"**/datasets/{P}/annotations", timeout=10000)
        page.locator("[data-testid=label-class]").first.wait_for(timeout=20000)
        ids = page.locator("[data-testid=label-class]").evaluate_all("els => els.map(e => e.dataset.labelId)")
        check("label classes carry their stable ids", "normal" in ids and "pneumonia" in ids, str(ids))

        # ---- Quality ----
        page.get_by_role("link", name="Quality", exact=True).click()
        page.wait_for_url(f"**/datasets/{P}/quality", timeout=10000)
        page.get_by_test_id("quality-clean").wait_for(timeout=10000)
        check("Quality: no problems found", True)

        # ---- History ----
        page.get_by_role("link", name="History", exact=True).click()
        page.get_by_test_id("dataset-history").wait_for(timeout=10000)
        legend = page.get_by_role("list", name="Kinds of version").inner_text()
        check("History names draft, main and release", all(w in legend for w in ("Working draft", "main", "Release")))

        # ---- Phone: the inspector is a drawer ----
        phone = browser.new_context(viewport={"width": 390, "height": 844})
        m = phone.new_page()
        m.on("pageerror", lambda e: errors.append(str(e)))
        m.goto(f"{base}/projects/{P}/datasets/{P}/structure")
        m.locator("[data-testid=structure-collection]").first.wait_for(timeout=20000)
        m.locator("[data-testid=structure-collection]").first.click()
        m.get_by_role("dialog").get_by_test_id("dataset-inspector").wait_for(timeout=5000)
        check("on a phone the inspector is a drawer", True)
        m.goto(f"{base}/projects/{P}/datasets/{P}")
        m.get_by_test_id("dataset-overview").wait_for(timeout=20000)
        m.wait_for_timeout(500)
        width = m.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        check("on a phone the page doesn't scroll sideways", width[0] <= width[1], str(width))
        phone.close()

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
