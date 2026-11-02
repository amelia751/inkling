"""todo7 Phase 4 exit: Trash and undo in Files, against the kernel.

Trash a folder of 500 files with ⌘⌫, reload, restore it from the Trash view, and it's back with
its counts. Undo (⌘Z) works after a reload, because the journal is on the server. An undo after a
colleague (a second principal) renamed one of the files is refused, naming it. Empty Trash keeps
bytes a version still uses, and its confirmation says so.

    STUDIO_API_URL=http://127.0.0.1:8000 STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_trash_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from files_helpers import add_member, api, check, toasts, child, kernel_ok, launch, list_view, make_folder, names, new_project, open_folder, parse_args, png, row, summary, sync_playwright, toast_with, wait  # noqa: E402

BIG = 500
COLLEAGUE = "user:e2e-colleague"


def as_colleague(page, path: str, body: dict) -> dict:
    """A write by a second person (dev trust headers: `X-Dev-Principal`)."""
    return page.evaluate(
        "async ([path, body, who]) => { const r = await fetch('/api/v1' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-Principal': who }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; }",
        [path, body, COLLEAGUE],
    )


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    files: dict[str, bytes | str] = {f"big/f{i:03d}.txt": f"row {i}\n" for i in range(BIG)}
    files.update({"notes.txt": "notes", "report.txt": "report", "a.png": png(8, 8, 1), "x/a.png": png(9, 9, 2)})
    folder = make_folder(files)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if not kernel_ok(page, base):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        pid, study = new_project(page, base, "Files trash e2e", folder)
        big = child(page, pid, study, "big")
        check(f"the upload made a folder of {BIG} files", bool(big) and big.get("childCount") == BIG, str(big and {k: big.get(k) for k in ('childCount', 'descendantCount', 'totalBytes')}))
        big_id = big["id"]

        # ---- ⌘⌫ moves the folder to Trash; reload; restore from the Trash view --------------
        open_folder(page, base, pid, study)
        list_view(page)
        row(page, "big").click()
        page.keyboard.press("ControlOrMeta+Backspace")
        toast = toast_with(page, "Trash")
        check("⌘⌫ moves it to Trash with an Undo toast", bool(toast) and "big" in toast and "Undo" in toast, str(toast))
        check("it's gone from the folder", bool(wait(lambda: "big" not in names(page, pid, study), 10)), str(names(page, pid, study)))
        page.reload()
        page.wait_for_selector("[data-testid=sources-listing]", timeout=20000)
        count = page.get_by_test_id("trash-count")
        check("after a reload the tree footer counts 1 item in Trash", bool(wait(lambda: count.inner_text().strip() == "1", 10)), count.inner_text() if count.count() else "no trash count")
        page.get_by_test_id("tree-footer").get_by_text("Trash", exact=True).first.click()
        page.wait_for_selector("[data-testid=trash-view]", timeout=10000)
        check("the Trash view has its own address", page.url.rstrip("/").endswith(f"/projects/{pid}/sources/trash"), page.url)
        trow = page.locator("[data-testid=trash-row]").filter(has_text="big")
        check("the Trash lists the folder (not its 500 files)", bool(wait(lambda: page.locator("[data-testid=trash-row]").count() == 1 and trow.count() == 1, 10)), str(page.locator("[data-testid=trash-row]").all_inner_texts()))
        check("with where it was", "study" in trow.inner_text(), trow.inner_text())
        trow.get_by_test_id("trash-restore").click()
        check("Restore says so", bool(toast_with(page, "Restored")), str(page.locator("[data-sonner-toast]").all_inner_texts()))
        back = wait(lambda: (lambda n: n if n and n["id"] == big_id else None)(child(page, pid, study, "big")), 10)
        check(f"it's back in study with its {BIG} files", bool(back) and back.get("childCount") == BIG, str(back and back.get("childCount")))
        check("the Trash is empty again", bool(wait(lambda: page.get_by_test_id("trash-empty-state").is_visible(), 10)))

        # ---- Undo works after a reload ------------------------------------------------------
        open_folder(page, base, pid, study)
        list_view(page)
        row(page, "notes.txt").click()
        page.keyboard.press("F2")
        page.locator("[data-testid=listing-rename-input]").wait_for(timeout=5000)
        page.keyboard.type("summary")
        page.keyboard.press("Enter")
        check("renamed notes.txt → summary.txt", bool(wait(lambda: child(page, pid, study, "summary.txt"), 10)), str(names(page, pid, study)))
        page.reload()
        page.wait_for_selector("[data-testid=sources-listing]", timeout=20000)
        page.wait_for_timeout(800)
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+z")
        check("⌘Z after a reload undoes the rename (the journal is on the server)", bool(wait(lambda: child(page, pid, study, "notes.txt"), 10)), str(names(page, pid, study)))
        check("and says so", bool(wait(lambda: any(t.startswith(("Undone", "Undid")) for t in toasts(page)), 10)), str(toasts(page)))

        # ---- An undo after a colleague's change is refused, naming the file ------------------
        report = child(page, pid, study, "report.txt")
        x = child(page, pid, study, "x")
        page.wait_for_timeout(2500)  # past the toast collapse window
        row(page, "report.txt").click()
        page.get_by_test_id("selection-move").click()
        dlg = page.get_by_test_id("move-dialog")
        dlg.wait_for(timeout=5000)
        dlg.get_by_test_id("move-dialog-folder").filter(has_text="x").first.click()
        page.wait_for_timeout(300)
        dlg.get_by_test_id("move-dialog-confirm").click()
        check("I move report.txt into x", bool(wait(lambda: child(page, pid, x["id"], "report.txt"), 10)), str(names(page, pid, x["id"])))
        if not add_member(pid, COLLEAGUE):
            print("  (STUDIO_API_DATA_DIR not set: the colleague can't be made a member; the next checks fail)")
        r = as_colleague(page, f"/projects/{pid}/fs/ops", {"ops": [{"kind": "rename", "nodeId": report["id"], "name": "report-final.txt"}]})
        check("a colleague renames it", r["status"] == 200, str(r)[:200])
        page.wait_for_timeout(2500)
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+z")
        refused = toast_with(page, "Can't undo")
        check("my undo is refused, naming the file", bool(refused) and "report-final.txt" in refused, str(page.locator("[data-sonner-toast]").all_inner_texts()))
        check("and nothing moved back", child(page, pid, x["id"], "report-final.txt") is not None)

        # ---- Empty Trash keeps bytes a version uses -----------------------------------------
        a = child(page, pid, study, "a.png")
        xa = child(page, pid, x["id"], "a.png")
        # x/a.png's bytes become version 2 of a.png (move with Replace; the mover goes to Trash),
        # then version 1 is restored (version 3): only version 2 still uses x/a.png's bytes.
        r = api(page, f"/projects/{pid}/fs/ops", "POST", {"ops": [{"kind": "move", "nodeIds": [xa["id"]], "parentId": study}], "resolutions": {"*": "replace"}})
        check("move with Replace makes a new version", r["status"] == 200, str(r)[:200])
        api(page, f"/source-nodes/{a['id']}/versions/1/restore", "POST")
        versions = api(page, f"/source-nodes/{a['id']}/versions")["json"]["versions"]
        check("a.png has three versions", [v["version"] for v in versions] == [3, 2, 1], str([v["version"] for v in versions]))
        page.goto(f"{base}/projects/{pid}/sources/trash")
        page.wait_for_selector("[data-testid=trash-row]", timeout=10000)
        page.get_by_test_id("trash-empty-button").click()
        kept = page.get_by_test_id("trash-kept-bytes")
        check("Empty Trash's confirmation names the bytes it keeps", bool(wait(lambda: kept.is_visible(), 10)) and "a.png" in kept.inner_text() and "version" in kept.inner_text(), kept.inner_text() if kept.count() else "")
        check("…in one sentence (no doubled “Kept:”)", "Kept: Kept" not in (kept.inner_text() if kept.count() else ""), kept.inner_text() if kept.count() else "")
        page.get_by_test_id("trash-empty-confirm-button").click()
        check("the Trash is empty", bool(wait(lambda: page.get_by_test_id("trash-empty-state").is_visible(), 10)) and api(page, f"/projects/{pid}/trash")["json"]["items"] == [])
        r = api(page, f"/source-nodes/{a['id']}/versions/2/restore", "POST")
        check("version 2's bytes were kept (it restores)", r["status"] == 200, str(r)[:200])

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return summary()


if __name__ == "__main__":
    sys.exit(main())
