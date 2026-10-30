"""Sources (todo6 Phase 4) in seed mode (the Vite seed server's read-only project API):
the tree and listing, keyboard navigation through the Sources commands, numbered-run
collapse, Quick Look, search with chips, the inspector, and no file names in the URL.

    python3 e2e/sources_test.py --port 5199
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


# The URL may only carry ids, sections and enums: no file or folder names (they can hold PHI).
NAMES = re.compile(r"HR0|HR%23|IM-0|normal|pneumonia|json|jpe?g", re.I)
SEQ = "HR00001.json–HR00010.json"


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        urls: list[str] = []
        page.on("framenavigated", lambda f: f == page.main_frame and urls.append(f.url))

        # One source: its root folder is the page; a numbered run collapses to one row.
        page.goto(f"{base}/projects/ecg-waveform/sources")
        page.wait_for_url(re.compile(r"/sources/nod-"), timeout=15000)
        check("one source opens its root folder", "/sources/nod-" in page.url, page.url)
        tree = page.locator("[data-testid=sources-tree] [role=tree]")
        tree.wait_for(timeout=15000)
        page.wait_for_selector("[data-testid=listing-row]", timeout=15000)
        rows = page.locator("[data-testid=listing-row]")
        check("run collapses into one listing row", rows.count() == 1 and SEQ in rows.first.inner_text(), rows.first.inner_text())
        check("run row says how many files", "· 10" in rows.first.inner_text())
        page.wait_for_selector(f"[role=treeitem]:has-text('{SEQ}')", timeout=10000)
        check("tree shows the run as one row", page.locator("[role=treeitem]").filter(has_text="HR0000").count() == 1)
        check("tree is ARIA complete", tree.locator("[role=treeitem][aria-level][aria-setsize][aria-posinset]").count() >= 2)

        # Keyboard in the tree: arrows, then Enter (openItem) opens the run in the listing.
        page.locator("[role=treeitem]").filter(has_text=SEQ).click()
        page.wait_for_url(re.compile(r"/sources/seq%3A|/sources/seq:"), timeout=10000)
        page.wait_for_function("document.querySelectorAll('[data-testid=listing-row]').length === 10", timeout=10000)
        check("opening the run lists its 10 files", rows.count() == 10)
        check("natural order in the run", rows.nth(0).locator("[data-testid=row-name]").inner_text() == "HR00001.json" and rows.nth(9).locator("[data-testid=row-name]").inner_text() == "HR00010.json")
        check("path bar shows the run", SEQ in page.locator("[data-testid=path-current]").inner_text())

        # ⌘↑ (parentFolder) goes back to the folder.
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+ArrowUp")
        page.wait_for_function("document.querySelectorAll('[data-testid=listing-row]').length === 1", timeout=10000)
        check("parent folder command goes up", rows.count() == 1)

        # Tree keyboard: focus the tree, arrow down to the run, Enter opens it.
        page.locator("[role=treeitem]").first.click()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        page.wait_for_function("document.querySelectorAll('[data-testid=listing-row]').length === 10", timeout=10000)
        check("arrows + Enter in the tree open the run", rows.count() == 10)

        # Listing keyboard: arrows select, Enter shows details, Space opens Quick Look, → steps.
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        sel = page.locator("[data-testid=listing-row][aria-selected=true] [data-testid=row-name]")
        check("arrows move the selection", sel.inner_text() == "HR00002.json", sel.inner_text())
        page.keyboard.press("Enter")
        page.wait_for_selector("[data-testid=inspector] [data-testid=inspector-kind]", timeout=10000)
        check("Enter shows the file's details", page.locator("[data-testid=inspector] h2").inner_text() == "HR00002.json")
        page.wait_for_selector("[data-testid=inspector-provenance]", timeout=10000)
        check("inspector has provenance", page.locator("[data-testid=inspector-provenance]").count() == 1)
        page.keyboard.press("Space")
        ql = page.locator("[data-testid=quick-look]")
        ql.wait_for(timeout=10000)
        check("Space opens Quick Look", "HR00002.json" in ql.inner_text())
        check("Quick Look shows the position", "2 of 10" in page.locator("[data-testid=quick-look-position]").inner_text())
        page.keyboard.press("ArrowRight")
        page.wait_for_function("document.querySelector('[data-testid=quick-look]')?.innerText.includes('HR00003.json')", timeout=5000)
        check("→ steps to the next file", "3 of 10" in page.locator("[data-testid=quick-look-position]").inner_text())
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("document.querySelector('[data-testid=quick-look]')?.innerText.includes('HR00001.json')", timeout=5000)
        check("← steps back", "1 of 10" in page.locator("[data-testid=quick-look-position]").inner_text())
        page.keyboard.press("Space")
        page.wait_for_timeout(400)
        check("Space closes Quick Look", page.locator("[data-testid=quick-look]").count() == 0)
        check("the selection followed Quick Look", sel.inner_text() == "HR00001.json", sel.inner_text())

        # Images: the grid shows thumbnails; Quick Look shows the image large.
        page.goto(f"{base}/projects/2d-xray/sources")
        page.wait_for_selector("[role=treeitem]:has-text('normal')", timeout=15000)
        page.locator("[role=treeitem]").filter(has_text="normal").click()
        page.wait_for_selector("[data-testid=sources-listing][data-view=grid] [data-testid=listing-tile]", timeout=15000)
        check("an image folder opens as a grid", page.locator("[data-testid=listing-tile]").count() == 10)
        page.wait_for_selector("[data-testid=listing-tile] img", timeout=15000)
        check("tiles have thumbnails", page.locator("[data-testid=listing-tile] img").count() >= 1)
        page.locator("[data-testid=listing-tile]").first.dblclick()
        page.wait_for_selector("[data-testid=quick-look] [data-testid=preview-image]", timeout=10000)
        check("double click opens Quick Look with the image", True)
        page.keyboard.press("Escape")
        page.get_by_role("radio", name="List view").click()
        page.wait_for_selector("[data-testid=sources-listing][data-view=list]", timeout=5000)
        check("view switch to list", page.locator("[data-testid=listing-row]").count() == 10)
        page.locator("[data-testid=sort-name]").click()
        first = page.locator("[data-testid=listing-row] [data-testid=row-name]").first.inner_text()
        check("sorting by name descending", first == "IM-0011-0001.jpeg", first)

        # Search (⌘F focuses it): server-side, results show their folder; chips filter.
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+f")
        check("focus search command", page.evaluate("document.activeElement?.dataset.testid") == "sources-search")
        page.keyboard.type("0011")
        page.wait_for_function("document.querySelectorAll('[data-testid=listing-row]').length === 3", timeout=10000)
        names = page.locator("[data-testid=listing-row]").all_inner_texts()
        check("search finds files across folders", len(names) == 3 and all("0011" in n for n in names), str(names))
        check("results show their folder", any("normal" in n for n in names))
        check("search text stays out of the URL", "0011" not in page.url, page.url)
        check("filter chips are shown", page.locator("[data-testid=chip-kind]").count() == 1 and page.locator("[data-testid=chip-attention]").count() == 1)
        page.locator("[data-testid=chip-attention]").click()
        page.wait_for_timeout(600)
        check("status chip filters (no seed file needs attention)", page.locator("[data-testid=listing-row]").count() == 0 and "status=attention" in page.url, page.url)
        page.get_by_role("button", name="Clear").click()
        page.wait_for_timeout(400)

        # Context menu is read-only: no rename, move or delete of a file.
        page.locator("[role=treeitem]").filter(has_text="pneumonia").click(button="right")
        menu = page.locator("[data-testid=sources-context-menu]")
        menu.wait_for(timeout=5000)
        items = menu.get_by_role("menuitem").all_inner_texts()
        check("context menu: open, explore, copy path", {"Open", "Show in Explore", "Copy path"} <= set(items), str(items))
        check("context menu has no rename/move/delete", not any(re.search(r"rename|move|delete", i, re.I) for i in items))
        page.keyboard.press("Escape")

        # Reveal: a link to a nested file opens its folders and selects it.
        node = page.evaluate("async () => (await (await fetch('/api/v1/projects/2d-xray/search?q=IM-0010')).json()).items[0].id")
        page.goto(f"{base}/projects/2d-xray/sources/{node}")
        page.wait_for_selector(f"[role=treeitem][aria-selected=true]:has-text('IM-0010-0001.jpeg')", timeout=15000)
        check("a deep link reveals the file in the tree", True)
        check("the file is selected in the listing", page.locator("[data-testid=inspector] h2").inner_text() == "IM-0010-0001.jpeg")

        # A file inside a numbered run: the run is listed and the file selected.
        hr = page.evaluate("async () => (await (await fetch('/api/v1/projects/ecg-waveform/search?q=HR00005')).json()).items[0].id")
        page.goto(f"{base}/projects/ecg-waveform/sources/{hr}")
        page.wait_for_function("document.querySelectorAll('[data-testid=listing-row]').length === 10", timeout=15000)
        check("a file in a run lists the run", SEQ in page.locator("[data-testid=path-current]").inner_text())
        check("and selects the file", page.locator("[data-testid=listing-row][aria-selected=true] [data-testid=row-name]").inner_text() == "HR00005.json")
        page.wait_for_selector("[role=treeitem][aria-selected=true]:has-text('HR00005.json')", timeout=15000)
        check("and reveals it inside the run in the tree", True)

        check("no names in any URL", not [u for u in urls if NAMES.search(u.split("?")[0]) or NAMES.search(u.split("?")[-1] if "?" in u else "")], str([u for u in urls if NAMES.search(u)][:3]))
        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
