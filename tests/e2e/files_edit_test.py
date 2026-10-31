"""todo7 Phase 2 exit: create, rename and select in Files, keyboard only, against the kernel.

Make a folder (⇧⌘N, type, Enter), rename a file with F2 (only the stem is selected), get refused
on a duplicate name with the sentence shown, confirm an extension change, drop an untouched new
folder with Esc, and select three files with ⇧↓ so the selection bar says "3 selected".

    INKLING_API_URL=http://127.0.0.1:8000 INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_edit_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from files_helpers import api, check, child, kernel_ok, launch, list_view, make_folder, names, new_project, open_folder, parse_args, png, row, summary, sync_playwright, toast_with, wait  # noqa: E402


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    folder = make_folder({"alpha.png": png(8, 8, 1), "bravo.png": png(8, 8, 2), "charlie.png": png(8, 8, 3), "notes.csv": "a,b\n1,2\n", "readme.txt": "hello"})
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if not kernel_ok(page, base):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        pid, study = new_project(page, base, "Files edit e2e", folder)
        open_folder(page, base, pid, study)
        list_view(page)
        listing = page.locator("[data-testid=sources-listing]")

        # ---- New folder: ⇧⌘N, "Untitled folder" in rename mode, type, Enter ------------------
        listing.focus()
        page.keyboard.press("ControlOrMeta+Shift+n")
        field = page.locator("[data-testid=listing-rename-input]")
        field.wait_for(timeout=5000)
        check("new folder starts as “Untitled folder” in rename mode", field.input_value() == "Untitled folder", field.input_value())
        page.keyboard.type("patient_002")
        page.keyboard.press("Enter")
        made = wait(lambda: child(page, pid, study, "patient_002"), 10)
        check("Enter makes the folder with the typed name", bool(made) and made["kind"] == "folder", str(names(page, pid, study)))
        check("the toast says what happened", bool(toast_with(page, "patient_002")))

        # ---- Esc on an untouched new folder drops it ----------------------------------------
        listing.focus()
        page.keyboard.press("ControlOrMeta+Shift+n")
        field.wait_for(timeout=5000)
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)
        check("Esc on an untouched new folder removes it", "Untitled folder" not in page.locator("[data-testid=sources-listing]").inner_text() and "Untitled folder" not in names(page, pid, study))

        # ---- Rename with F2: the stem is selected -------------------------------------------
        row(page, "notes.csv").click()
        page.keyboard.press("F2")
        field.wait_for(timeout=5000)
        sel = page.evaluate("() => { const e = document.activeElement; return [e.value, e.selectionStart, e.selectionEnd]; }")
        check("F2 opens rename with only the stem selected", sel == ["notes.csv", 0, 5], str(sel))
        page.keyboard.type("summary")
        page.keyboard.press("Enter")
        check("Enter renames the file (extension kept)", bool(wait(lambda: child(page, pid, study, "summary.csv"), 10)), str(names(page, pid, study)))

        # ---- Duplicate name: refused, with the sentence under the field ---------------------
        page.wait_for_timeout(500)
        row(page, "readme.txt").click()
        page.keyboard.press("F2")
        field.wait_for(timeout=5000)
        page.keyboard.press("ControlOrMeta+a")
        page.keyboard.type("SUMMARY.csv")
        err = page.locator("[data-testid=rename-error]")
        check("a duplicate name (any case) is refused with the reason", wait(lambda: err.is_visible(), 3) and "already here" in err.inner_text(), err.inner_text() if err.count() else "")
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        check("Enter does nothing while the name is taken", field.count() == 1 and "readme.txt" in names(page, pid, study))
        page.keyboard.press("Escape")

        # ---- Extension change asks first ------------------------------------------------------
        page.wait_for_timeout(300)
        row(page, "readme.txt").click()
        page.keyboard.press("F2")
        field.wait_for(timeout=5000)
        page.keyboard.press("ControlOrMeta+a")
        page.keyboard.type("readme.md")
        page.keyboard.press("Enter")
        confirm = page.locator("[data-testid=extension-confirm]")
        check("changing the extension asks first", wait(lambda: confirm.is_visible(), 5) and ".md" in confirm.inner_text(), confirm.inner_text() if confirm.count() else "")
        page.get_by_test_id("extension-confirm-yes").click()
        renamed = wait(lambda: child(page, pid, study, "readme.md"), 10)
        check("confirming renames it", bool(renamed), str(names(page, pid, study)))

        # ---- ⇧↓ selects three files; the selection bar replaces the toolbar -----------------
        page.wait_for_timeout(500)
        row(page, "alpha.png").click()
        page.keyboard.press("Shift+ArrowDown")
        page.keyboard.press("Shift+ArrowDown")
        count = page.locator("[data-testid=selection-count]")
        check("⇧↓ twice: the selection bar says 3 selected", wait(lambda: count.inner_text() == "3 selected", 5), count.inner_text() if count.count() else "no selection bar")
        check("the path bar gives way to the selection bar", page.locator("[data-testid=path-bar]").count() == 0)
        check("the inspector sums them up", "3 items" in page.locator("aside[data-testid=inspector]").inner_text())
        page.keyboard.press("ControlOrMeta+a")
        check("⌘A selects every row", wait(lambda: count.inner_text() == f"{len(names(page, pid, study))} selected", 5), count.inner_text())
        page.keyboard.press("Escape")
        check("Esc clears the selection", wait(lambda: page.locator("[data-testid=selection-bar]").count() == 0, 5))

        # ---- The journal has every change, newest first ------------------------------------
        hist = api(page, f"/projects/{pid}/fs/history")["json"]
        check("undo is offered for the last change", bool(hist and hist.get("undo")), str(hist))
        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return summary()


if __name__ == "__main__":
    sys.exit(main())
