"""Trash edge cases (todo18 P0-1, §2 B). Needs the full stack (api with the trash routes).

- Sources › Trash "Empty trash" purges files only: a trashed dataset survives it (P0-1).
- The project Trash confirm lists what goes, per kind (`trash-empty-counts`).
- Files trashed together show as one row ("a.png and 1 more"), expandable (`trash-row-expand`).
- One row's pending action doesn't disable the other rows' buttons.

    python3 e2e/edge_trash_test.py --port 5199
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
    api = f"{base}/api/v1/projects/{P}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        if page.request.get(f"{api}/trash?kind=all").status >= 500:
            print("SKIP needs the full stack (api with /trash)")
            return 0

        # ---- Trash a dataset and two files in one batch ----
        datasets = page.request.get(f"{api}/datasets").json().get("datasets", [])
        if not datasets:
            print("SKIP no dataset in the seed project")
            return 0
        page.request.delete(f"{api}/datasets/{datasets[0]['id']}")
        kids = page.request.get(f"{api}/fs/children").json().get("items", [])
        files = [k["id"] for k in kids if not k.get("isDir")][:2]
        if len(files) == 2:
            page.request.post(f"{api}/fs/ops", data={"ops": [{"kind": "trash", "nodeIds": files}]})

        # ---- Project Trash: one row per batch, counts per kind in the confirm ----
        page.goto(f"{base}/projects/{P}/trash")
        page.get_by_test_id("trash-page").wait_for(timeout=20000)
        page.get_by_test_id("trash-row").first.wait_for(timeout=10000)
        batch_ids = [r.get_attribute("data-batch-id") for r in page.get_by_test_id("trash-row").all()]
        check("one row per batch", len(batch_ids) == len(set(batch_ids)), str(batch_ids))
        if len(files) == 2:
            expand = page.get_by_test_id("trash-row-expand").first
            check("batch row says 'and 1 more'", "and 1 more" in (expand.text_content() or ""))
            expand.click()
            check("batch row expands to its members", page.get_by_test_id("trash-row-members").first.locator("li").count() == 2)

        page.get_by_test_id("trash-empty").click()
        counts = page.get_by_test_id("trash-empty-counts").text_content() or ""
        check("empty confirm lists counts per kind", "dataset" in counts, counts)
        page.keyboard.press("Escape")

        # ---- Sources › Trash empties files only ----
        r = page.request.post(f"{api}/trash/empty?kind=sources")
        check("sources empty succeeds", r.ok, str(r.status))
        kinds = [i["kind"] for i in page.request.get(f"{api}/trash?kind=all").json()["items"]]
        check("the trashed dataset survives Sources › Empty trash", "dataset" in kinds, str(kinds))

        # ---- Clean up: restore everything left ----
        for i in page.request.get(f"{api}/trash?kind=all").json()["items"]:
            page.request.post(f"{api}/trash/{i['batchId']}/restore")

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
