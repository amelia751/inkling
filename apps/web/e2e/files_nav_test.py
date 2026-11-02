"""Files: finding your way (todo7 Phase 5 exit) in seed mode, where the drive is read-only.

Sort by size (server-side, folders first, across pages; remembered after a reload), the tree
filter narrows the loaded tree and clears, a starred folder shows in the tree footer and survives
a reload (the stand-in keeps stars in localStorage), breadcrumb segments are drop targets of the
drag controller (the move itself needs the API: see tests/e2e/files_move_test.py), OS files show
the drop veil over the listing only, and edit actions say "Needs the full stack".

    python3 e2e/files_nav_test.py --port 5199
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail and not ok else ''}")


def get(page, path: str):
    return page.evaluate("async (p) => (await fetch('/api/v1' + p)).json()", path)


DRAG = """async ([srcSel, dstSel, alt]) => {
  const dt = new DataTransfer();
  const src = document.querySelector(srcSel);
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 250));
  const dst = document.querySelector(dstSel);
  const r = dst.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + r.height / 2, altKey: alt };
  dst.dispatchEvent(new DragEvent('dragenter', o));
  dst.dispatchEvent(new DragEvent('dragover', o));
  await new Promise((r) => setTimeout(r, 250));
  const out = { reason: document.querySelector('[data-testid=drag-chip-reason]')?.textContent ?? '', lit: dst.className.includes('ring-ring') };
  dst.dispatchEvent(new DragEvent('drop', o));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return out;
}"""

OS_DRAG = """async ([sel]) => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new DragEvent('dragenter', o));
  el.dispatchEvent(new DragEvent('dragover', o));
  await new Promise((r) => setTimeout(r, 200));
  const overlay = document.querySelector('[data-testid=drop-overlay]');
  const inListing = !!overlay && !!overlay.closest('#listing, [data-panel][id=listing]');
  const lit = document.querySelector('[data-testid=sources-tree] [data-node-id].ring-ring')?.textContent ?? '';
  el.dispatchEvent(new DragEvent('dragleave', { ...o, relatedTarget: null }));
  return { overlay: !!overlay, inListing, lit };
}"""


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ---- Sort: server-side, folders first on every page ----------------------------------
        page.goto(f"{base}/projects/pathology-wsi/sources")
        page.wait_for_selector("[data-testid=listing-row], [data-testid=listing-tile]", timeout=20000)
        bad = []
        for proj in ("2d-xray", "3d-brain-mri", "pathology-wsi", "4d-cardiac", "ecg-waveform"):
            root = get(page, f"/projects/{proj}/fs")["rootNodeId"]
            top = get(page, f"/projects/{proj}/fs/children?node={root}")["items"][0]["id"]
            seen, cursor = [], None
            while True:
                q = f"/projects/{proj}/fs/children?node={top}&sort=size&dir=desc&limit=1" + (f"&cursor={cursor}" if cursor else "")
                pg = get(page, q)
                seen += pg["items"]
                cursor = pg["nextCursor"]
                if not cursor or len(seen) > 50:
                    break
            kinds = [0 if n["kind"] != "file" else 1 for n in seen]
            sizes = [n["size"] or 0 for n in seen if n["kind"] == "file"]
            if kinds != sorted(kinds) or sizes != sorted(sizes, reverse=True):
                bad.append(proj)
        check("size sort pages one row at a time with folders first and files largest first", not bad, str(bad))

        page.get_by_test_id("tree-sort").click()
        page.get_by_test_id("tree-sort-size").click()
        page.wait_for_function("document.querySelector('[data-testid=tree-sort]')?.dataset.sort === 'size'", timeout=5000)
        page.get_by_role("radio", name="List view").click()
        page.wait_for_timeout(800)
        first = page.locator("[data-testid=listing-row] [data-testid=row-name]").first.inner_text()
        check("Sort ▾ Size orders the listing largest first", first.endswith(".dzi"), first)
        page.reload()
        page.wait_for_selector("[data-testid=listing-row]", timeout=20000)
        check("the sort is remembered after a reload", page.get_by_test_id("tree-sort").get_attribute("data-sort") == "size")
        page.get_by_test_id("tree-sort").click()
        page.get_by_test_id("tree-sort-name").click()

        # ---- Tree filter: narrows the loaded tree, Esc and ✕ clear it -----------------------
        page.goto(f"{base}/projects/2d-xray/sources")
        page.wait_for_selector("[role=treeitem]:has-text('pneumonia')", timeout=20000)
        filt = page.get_by_test_id("tree-filter")
        check("the two fields say which is which", filt.get_attribute("placeholder") == "Filter folders shown" and page.get_by_test_id("sources-search").get_attribute("placeholder") == "Search Sources")
        before = page.locator("[role=treeitem]").count()
        filt.fill("pneu")
        page.wait_for_timeout(400)
        shown = page.locator("[role=treeitem]").all_inner_texts()
        check("the filter narrows the tree", any("pneumonia" in t for t in shown) and not any(t.startswith("normal") for t in shown), str(shown))
        filt.press("Escape")
        page.wait_for_timeout(400)
        check("Esc clears the filter", filt.input_value() == "" and page.locator("[role=treeitem]").count() == before)

        # ---- Star a folder: footer, and after a reload ---------------------------------------
        page.locator("[role=treeitem]").filter(has_text="normal").click(button="right")
        menu = page.locator("[data-testid=sources-context-menu]")
        menu.wait_for(timeout=5000)
        copy_to = menu.locator("[data-testid=files-menu-copyTo]")
        check("context menu: Copy to… needs the full stack", copy_to.get_attribute("data-disabled-reason") == "Needs the full stack")
        menu.get_by_role("menuitem").filter(has_text="Star").first.click()
        starred = page.get_by_test_id("tree-footer-starred")
        starred.wait_for(timeout=5000)
        check("a starred folder shows under Starred", "normal" in starred.inner_text())
        page.reload()
        page.get_by_test_id("tree-footer-starred").wait_for(timeout=15000)
        check("and is still there after a reload", "normal" in page.get_by_test_id("tree-footer-starred").inner_text())
        page.get_by_test_id("tree-footer-starred").get_by_test_id("tree-footer-row").first.click()
        page.wait_for_function("document.querySelector('[data-testid=path-current]')?.textContent?.startsWith('normal')", timeout=10000)
        check("clicking a starred folder opens it", True)

        # ---- Breadcrumbs are drop targets ---------------------------------------------------
        crumb = page.locator("[data-testid=path-segment]").first
        check("breadcrumb segments carry the drop target", crumb.get_attribute("data-fs-drop-id") is not None and page.get_by_test_id("path-current").get_attribute("data-fs-drop-id") is not None)
        page.wait_for_selector("[data-testid=listing-tile], [data-testid=listing-row]", timeout=10000)
        out = page.evaluate(DRAG, ["[data-testid=listing-tile], [data-testid=listing-row]", "[data-testid=path-segment]", False])
        check("dragging a file over a segment lights it up", out["lit"], str(out))
        check("and says why sample data can't move there", "Sample data" in out["reason"], str(out))
        out = page.evaluate(DRAG, ["[data-testid=listing-tile], [data-testid=listing-row]", "[data-testid=path-root]", True])
        toast = page.locator("[data-sonner-toast]").filter(has_text="Needs the full stack")
        toast.first.wait_for(timeout=5000)
        check("⌥-drop (copy) on the Files segment reaches the API, which needs the full stack here", toast.count() >= 1)

        # ---- OS files: the veil covers only the listing ------------------------------------
        over_list = page.evaluate(OS_DRAG, ["[data-testid=sources-listing]"])
        check("OS files over the listing: the drop veil, inside the listing pane", over_list["overlay"] and over_list["inListing"], str(over_list))
        over_tree = page.evaluate(OS_DRAG, ["[data-testid=sources-tree] [role=treeitem] [data-folder-id]"])
        check("over the tree: no veil, the folder row lights up", not over_tree["overlay"] and bool(over_tree["lit"]), str(over_tree))

        # ---- Edit actions need the full stack ------------------------------------------------
        page.get_by_test_id("selection-clear").click()  # the drags above selected a tile
        page.get_by_test_id("files-new").click()
        reason = page.get_by_test_id("files-new-folder-reason")
        reason.wait_for(timeout=5000)
        check("New ▾ Folder says “Needs the full stack”", reason.inner_text() == "Needs the full stack")
        page.keyboard.press("Escape")
        check("the tree's New folder is inert", page.get_by_test_id("tree-new-folder").get_attribute("aria-disabled") == "true")
        page.locator("[data-testid=sources-listing]").focus()
        page.keyboard.press("ControlOrMeta+Shift+n")
        page.wait_for_timeout(300)
        check("⇧⌘N explains instead of making a folder", page.locator("[data-sonner-toast]").filter(has_text="Needs the full stack").count() >= 1 and page.locator("[data-testid=listing-rename-input]").count() == 0)

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
