"""todo7 Phase 3 exit: move, copy and paste in Files, against the kernel.

Drag three files from the grid onto a tree folder and Undo from the toast; ⌥-drag copies; a
folder can't go into its own subfolder (the Move to… dialog says why); paste with name conflicts
and "Keep both" for all gives `(2)` names; a dataset made from files keeps the same files after
they move; the Move to… dialog works with the keyboard only.

    INKLING_API_URL=http://127.0.0.1:8000 INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_move_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from files_helpers import toasts, api, check, child, drag, grid_view, kernel_ok, launch, list_view, make_folder, mark, names, new_project, open_folder, parse_args, png, row, sel_row, summary, sync_playwright, toast_with, wait  # noqa: E402


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    folder = make_folder(
        {
            "inbox/apple.png": png(8, 8, 1),
            "inbox/berry.png": png(8, 8, 2),
            "inbox/cherry.png": png(8, 8, 3),
            "x/alpha.png": png(8, 8, 10),
            "x/bravo.png": png(8, 8, 11),
            "y/alpha.png": png(8, 8, 20),
            "y/bravo.png": png(8, 8, 21),
            "parent/child/keep.txt": "keep",
            "parent/note.txt": "note",
            "dest/readme.txt": "here",
        }
    )
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if not kernel_ok(page, base):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        pid, study = new_project(page, base, "Files move e2e", folder)
        ids = {n["name"]: n["id"] for n in api(page, f"/projects/{pid}/fs/children?node={study}")["json"]["items"]}
        inbox, dest, x, y, parent = ids["inbox"], ids["dest"], ids["x"], ids["y"], ids["parent"]
        inbox_files = [n["id"] for n in api(page, f"/projects/{pid}/fs/children?node={inbox}")["json"]["items"]]

        # A dataset made from the inbox files, before anything moves (D7: it freezes its files).
        ds = api(page, f"/projects/{pid}/datasets", "POST", {"title": "Fruit", "nodeIds": inbox_files, "task": {"title": "Annotate"}})["json"]
        ds_before = api(page, f"/projects/{pid}/datasets/{ds['id']}")["json"]

        # ---- Drag three files from the grid onto a tree folder; Undo from the toast ---------
        open_folder(page, base, pid, inbox)
        grid_view(page)
        row(page, "apple.png").click()
        row(page, "cherry.png").click(modifiers=["Shift"])
        check("⇧-click selects the three tiles", page.get_by_test_id("selection-count").inner_text() == "3 selected")
        page.wait_for_selector("[role=treeitem]:has-text('dest')", timeout=10000)
        mark(page, "apple.png")
        mark(page, "dest", "[role=treeitem] [data-node-id]")
        refusal = drag(page, sel_row("apple.png"), sel_row("dest"))
        check("the tree folder accepts the drop", not refusal, refusal)
        toast = toast_with(page, "Moved 3 items")
        check("toast: “Moved 3 items to dest · Undo”", bool(toast) and "dest" in toast and "Undo" in toast, str(toast))
        moved = wait(lambda: {"apple.png", "berry.png", "cherry.png"} <= set(names(page, pid, dest)), 10)
        check("the files are in dest", bool(moved), str(names(page, pid, dest)))
        page.locator("[data-sonner-toast]").filter(has_text="Moved 3 items").get_by_role("button", name="Undo").click()
        back = wait(lambda: set(names(page, pid, inbox)) == {"apple.png", "berry.png", "cherry.png"}, 10)
        check("Undo puts them back", bool(back), str(names(page, pid, inbox)))

        # ---- ⌥-drag copies ------------------------------------------------------------------
        open_folder(page, base, pid, inbox)
        page.wait_for_selector("[role=treeitem]:has-text('dest')", timeout=10000)
        row(page, "apple.png").click()
        mark(page, "apple.png")
        mark(page, "dest", "[role=treeitem] [data-node-id]")
        drag(page, sel_row("apple.png"), sel_row("dest"), alt=True)
        copied = wait(lambda: "apple.png" in names(page, pid, dest), 10)
        check("⌥-drag copies (the original stays)", bool(copied) and "apple.png" in names(page, pid, inbox), f"{names(page, pid, dest)} / {names(page, pid, inbox)}")
        a1 = child(page, pid, inbox, "apple.png")
        a2 = child(page, pid, dest, "apple.png")
        check("the copy is a new node with the same bytes (D5)", bool(a1 and a2) and a1["id"] != a2["id"] and a1["sha256"] == a2["sha256"])

        # ---- A folder can't go into its own subfolder ---------------------------------------
        open_folder(page, base, pid, study)
        list_view(page)
        row(page, "parent").click()
        page.get_by_test_id("selection-move").click()
        dlg = page.get_by_test_id("move-dialog")
        dlg.wait_for(timeout=5000)
        dlg.get_by_test_id("move-dialog-folder").filter(has_text="parent").click()
        reason = dlg.get_by_test_id("move-dialog-reason")
        check("Move to… refuses the folder itself, with the reason", wait(lambda: "into itself" in reason.inner_text(), 5), reason.inner_text() if reason.count() else "")
        dlg.get_by_test_id("move-dialog-folder").filter(has_text="child").click()
        check("and its subfolders", wait(lambda: "its own folders" in reason.inner_text(), 5), reason.inner_text() if reason.count() else "")
        check("Move here is inert there", dlg.get_by_test_id("move-dialog-confirm").get_attribute("aria-disabled") == "true")
        status = api(page, f"/projects/{pid}/fs/ops", "POST", {"ops": [{"kind": "move", "nodeIds": [parent], "parentId": child(page, pid, parent, "child")["id"]}]})
        check("the kernel refuses it too (422)", status["status"] == 422, str(status))
        page.keyboard.press("Escape")

        # ---- Paste with name conflicts: Keep both for all → (2) names -----------------------
        open_folder(page, base, pid, x)
        list_view(page)
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+a")
        page.keyboard.press("ControlOrMeta+x")
        check("cut rows are drawn at 50%", wait(lambda: page.locator("[data-testid=listing-row][data-cut]").count() == 2, 3))
        # In-app navigation (the clipboard is per tab and survives it; a reload would clear it).
        page.keyboard.press("Escape")  # clears the selection; the clipboard stays
        page.locator("[data-testid=path-segment]").filter(has_text="study").click()
        page.locator("[data-testid=listing-row] [data-testid=row-name]").filter(has_text=re.compile(r"^y$")).dblclick()
        page.wait_for_function("document.querySelector('[data-testid=path-current]')?.textContent === 'y'", timeout=10000)
        page.wait_for_timeout(800)
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+v")
        conflict = page.get_by_test_id("conflict-dialog")
        if not check("pasting over taken names opens the conflict dialog", wait(lambda: conflict.is_visible(), 10)):
            print("  toasts:", toasts(page), "y:", names(page, pid, y), "url:", page.url)
        check("it names the item and the folder", "alpha.png" in page.get_by_test_id("conflict-message").inner_text() and "y" in page.get_by_test_id("conflict-message").inner_text())
        page.get_by_test_id("conflict-apply-all").click()
        page.get_by_test_id("conflict-keep-both").click()
        got = wait(lambda: {"alpha (2).png", "bravo (2).png"} <= set(names(page, pid, y)), 10)
        check("Keep both for all gives (2) names", bool(got), str(names(page, pid, y)))
        check("x is empty now", names(page, pid, x) == [], str(names(page, pid, x)))

        # ---- The dataset still lists the same files ----------------------------------------
        r = api(page, f"/projects/{pid}/fs/ops", "POST", {"ops": [{"kind": "move", "nodeIds": inbox_files, "parentId": dest}], "resolutions": {"*": "keep_both"}})
        check("the dataset's files can move (one batch)", r["status"] == 200, str(r)[:200])
        ds_after = api(page, f"/projects/{pid}/datasets/{ds['id']}")["json"]
        same = ds_after["fileCount"] == ds_before["fileCount"] and sorted(f["nodeId"] for f in ds_after["definition"].get("files", [])) == sorted(f["nodeId"] for f in ds_before["definition"].get("files", []))
        check("a dataset made from the moved files still lists the same items (D7)", same, f"{ds_before['fileCount']} → {ds_after['fileCount']}")
        tasks = api(page, f"/projects/{pid}/datasets/{ds['id']}/tasks")["json"]["tasks"]
        check("its task is unchanged", tasks and tasks[0]["annotationCount"] == ds_before["tasks"][0]["annotationCount"])

        # ---- Move to… with the keyboard only ----------------------------------------------
        open_folder(page, base, pid, dest)
        list_view(page)
        listing = page.locator("[data-testid=sources-listing]")
        listing.focus()
        page.keyboard.press("Home")
        name = page.locator("[data-testid=listing-row][aria-selected=true] [data-testid=row-name]").inner_text()
        page.keyboard.press("Shift+F10")
        menu = page.locator("[data-testid=sources-context-menu]")
        check("Shift+F10 opens the row's menu", wait(lambda: menu.is_visible(), 5))
        for _ in range(12):
            if (page.evaluate("document.activeElement?.textContent ?? ''") or "").startswith("Move to"):
                break
            page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        dlg.wait_for(timeout=5000)
        page.keyboard.press("Backspace")  # up to study
        page.wait_for_timeout(600)
        for _ in range(12):
            active = dlg.locator("[role=option][aria-selected=true]")
            if active.count() and active.inner_text().startswith("inbox"):
                break
            page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")  # into inbox
        page.wait_for_timeout(500)
        page.keyboard.press("ControlOrMeta+Enter")
        check("keyboard only: the file moved where the dialog was", bool(wait(lambda: name in names(page, pid, inbox), 10)), f"{name} → {names(page, pid, inbox)}")

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return summary()


if __name__ == "__main__":
    sys.exit(main())
