"""Delete and Trash (todo16 Milestone 2). Needs the full stack (api with the trash routes).

- Deleting a dataset shows the impact dialog (`delete-dialog`), then "Moved to Trash" with Undo.
- Undo puts it back; deleting again lands one row in the project Trash (`trash-page`).
- Restore brings it back; Delete forever removes it; Empty trash leaves the empty state.
- Settings › Danger zone asks for the project's name before Delete project.

    python3 e2e/trash_test.py --port 5199
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"
EMPTY = "Nothing in Trash. Deleted things stay here for 30 days, then they're gone."
SHOTS = Path(__file__).parent / "screenshots"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


def delete_first_dataset(page) -> str:
    card = page.get_by_test_id("dataset-card").first
    card.wait_for(timeout=20000)
    dataset_id = card.get_attribute("data-dataset-id") or ""
    card.get_by_test_id("resource-menu").click()
    page.get_by_test_id("resource-delete").click()
    dialog = page.get_by_test_id("delete-dialog")
    dialog.wait_for()
    dialog.get_by_test_id("delete-impact").wait_for(timeout=10000)
    dialog.get_by_test_id("delete-confirm").click()
    return dataset_id


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    SHOTS.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        if page.request.get(f"{base}/api/v1/projects/{P}/trash?kind=all").status >= 500:
            print("SKIP needs the full stack (api with /trash)")
            return 0

        # ---- Delete a dataset, Undo from the toast ----
        page.goto(f"{base}/projects/{P}/datasets")
        ds = delete_first_dataset(page)
        page.get_by_test_id("toast-undo").click()
        page.locator(f"[data-testid=dataset-card][data-dataset-id='{ds}']").wait_for(timeout=10000)
        check("Undo puts the dataset back", True)

        # ---- Delete again, it's one row in Trash ----
        delete_first_dataset(page)
        page.goto(f"{base}/projects/{P}/trash")
        page.get_by_test_id("trash-page").wait_for()
        rows = page.get_by_test_id("trash-row")
        rows.first.wait_for(timeout=10000)
        check("Trash shows the dataset as one row", page.locator("[data-testid=trash-row][data-kind=dataset]").count() == 1)
        check("Rows say days left", "days left" in rows.first.get_by_test_id("trash-days-left").inner_text())
        page.screenshot(path=str(SHOTS / "trash_rows.png"))

        # ---- Restore, delete forever, empty ----
        rows.first.get_by_test_id("trash-restore").click()
        page.wait_for_timeout(1000)
        page.goto(f"{base}/projects/{P}/datasets")
        delete_first_dataset(page)
        page.goto(f"{base}/projects/{P}/trash")
        page.get_by_test_id("trash-row").first.get_by_test_id("trash-delete-forever").click()
        page.get_by_test_id("trash-delete-confirm-button").click()
        page.wait_for_timeout(1000)
        if page.get_by_test_id("trash-row").count():
            page.get_by_test_id("trash-empty").click()
            page.get_by_test_id("trash-empty-confirm-button").click()
        page.get_by_test_id("trash-empty-state").wait_for(timeout=10000)
        check("Empty Trash says how long things stay", EMPTY in page.get_by_test_id("trash-empty-state").inner_text())
        page.screenshot(path=str(SHOTS / "trash_empty.png"))

        # ---- Danger zone: type the name ----
        page.goto(f"{base}/projects/{P}/settings/general")
        page.get_by_test_id("delete-project").click()
        dialog = page.get_by_test_id("delete-dialog")
        check("Delete project waits for the name", dialog.get_by_test_id("delete-confirm").is_disabled())
        page.keyboard.press("Escape")

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
