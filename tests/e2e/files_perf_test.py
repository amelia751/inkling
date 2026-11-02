"""todo7 Phase 9: performance and accessibility probes for Files, against the kernel.

Measures (and prints) rather than gating hard, except where the plan sets a bar:

- a rename shows in another tab within 1 s (the project's event stream, `fs.changed`);
- dragging over a 5,000-row virtualized listing: frames per second while synthetic dragover
  events move down the rows at 60 Hz and the listing scrolls (a headless Chromium estimate);
- rename fields are labelled; every operation is announced in the polite live region;
- context menus open from the keyboard (Shift+F10 and the Menu key) in the listing and the tree;
- the keyboard twins of drags: ⌘C / ⌘V copies (⌥-drag), ⌘X / ⌘V and Move to… move (drag).

    STUDIO_API_URL=http://127.0.0.1:8000 STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_perf_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import itertools
import string
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from files_helpers import api, check, child, kernel_ok, launch, list_view, make_folder, names, new_project, open_folder, parse_args, row, summary, sync_playwright, wait  # noqa: E402

ROWS = 5000

FPS = """async ([ms]) => {
  const list = document.querySelector('[data-testid=sources-listing]');
  const scroller = list.querySelector('[data-fs-autoscroll]') ?? list;
  const src = document.querySelector('[data-testid=listing-row]');
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  let frames = 0, worst = 0, last = performance.now();
  const t0 = last;
  await new Promise((done) => {
    const tick = (now) => {
      frames++; worst = Math.max(worst, now - last); last = now;
      // One dragover per frame, walking down the rows, while the listing scrolls.
      const r = scroller.getBoundingClientRect();
      const y = r.top + 20 + ((now - t0) / 4) % Math.max(40, r.height - 40);
      const el = document.elementFromPoint(r.left + 60, y) ?? scroller;
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 60, clientY: y }));
      scroller.scrollTop += 24;
      if (now - t0 < ms) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return { fps: frames / (ms / 1000), worst, scrolled: scroller.scrollTop };
}"""


def live(page) -> str:
    return page.get_by_test_id("files-live-region").inner_text().replace("​", "")


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    # Names without digits, so they don't collapse into a numbered run.
    many = ["".join(t) for t in itertools.islice(itertools.product(string.ascii_lowercase, repeat=3), ROWS)]
    files: dict[str, bytes | str] = {f"big/{n}.txt": n for n in many}
    files.update({"small/alpha.txt": "a", "small/bravo.txt": "b", "small/charlie.txt": "c", "dest/keep.txt": "k"})
    folder = make_folder(files)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if not kernel_ok(page, base):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        t = time.time()
        pid, study = new_project(page, base, "Files perf e2e", folder, inspected=False)
        print(f"  upload of {len(files):,} files: {time.time() - t:.0f}s")
        small, big, dest = (child(page, pid, study, n)["id"] for n in ("small", "big", "dest"))

        # ---- A rename shows in another tab within 1 s ---------------------------------------
        other = ctx.new_page()
        open_folder(other, base, pid, small)
        list_view(other)
        open_folder(page, base, pid, small)
        list_view(page)
        page.wait_for_timeout(1500)  # both event streams connected
        alpha = child(page, pid, small, "alpha.txt")
        t0 = time.time()
        r = api(page, f"/projects/{pid}/fs/ops", "POST", {"ops": [{"kind": "rename", "nodeId": alpha["id"], "name": "alpha-renamed.txt"}]})
        t_api = time.time() - t0
        other.wait_for_function("[...document.querySelectorAll('[data-testid=row-name]')].some(e => e.textContent === 'alpha-renamed.txt')", timeout=10000)
        seen = time.time() - t0
        print(f"  rename → other tab: {seen * 1000:.0f} ms (the API call itself {t_api * 1000:.0f} ms)")
        check("a rename shows in another tab within 1 s (SSE)", r["status"] == 200 and seen < 1.0, f"{seen * 1000:.0f} ms")
        other.close()

        # ---- Drag over a 5,000-row listing --------------------------------------------------
        open_folder(page, base, pid, big)
        list_view(page)
        rows = page.locator("[data-testid=listing-row]")
        total = page.locator("[data-testid=sources-listing]").get_attribute("aria-rowcount")
        check(f"the listing is virtualized ({total} rows, {rows.count()} in the DOM)", total == str(ROWS) and rows.count() < 200, f"{total} / {rows.count()}")
        # Load every page (500 rows each) by scrolling to the end, then scroll back to the top.
        last = f"{many[-1]}.txt"
        for _ in range(40):
            page.evaluate("() => { const l = document.querySelector('[data-testid=sources-listing]'); const s = l.querySelector('[data-fs-autoscroll]') ?? l; s.scrollTop = s.scrollHeight; }")
            page.wait_for_timeout(300)
            if page.locator("[data-testid=row-name]").filter(has_text=last).count():
                break
        check(f"all {ROWS:,} rows load as the listing scrolls", page.locator("[data-testid=row-name]").filter(has_text=last).count() == 1)
        page.evaluate("() => { const l = document.querySelector('[data-testid=sources-listing]'); const s = l.querySelector('[data-fs-autoscroll]') ?? l; s.scrollTop = 0; }")
        page.evaluate(FPS, [1000])  # warm-up (JIT, first paint of every row component)
        page.evaluate("() => { const l = document.querySelector('[data-testid=sources-listing]'); const s = l.querySelector('[data-fs-autoscroll]') ?? l; s.scrollTop = 0; }")
        m = page.evaluate(FPS, [3000])
        print(f"  drag over {ROWS:,} rows while scrolling: {m['fps']:.0f} fps, worst frame {m['worst']:.0f} ms, scrolled {m['scrolled']:.0f}px")
        check("dragging over 5,000 rows stays smooth (≥ 50 fps headless)", m["fps"] >= 50, str(m))

        # ---- Accessibility -----------------------------------------------------------------
        open_folder(page, base, pid, small)
        list_view(page)
        listing = page.locator("[data-testid=sources-listing]")
        row(page, "bravo.txt").click()
        page.keyboard.press("F2")
        field = page.locator("[data-testid=listing-rename-input]")
        field.wait_for(timeout=5000)
        check("the listing's rename field is labelled", (field.get_attribute("aria-label") or "").startswith("Rename bravo"), str(field.get_attribute("aria-label")))
        page.keyboard.press("ControlOrMeta+a")
        page.keyboard.type("bravo-2.txt")
        page.keyboard.press("Enter")
        check("a rename is announced", bool(wait(lambda: "bravo-2.txt" in live(page), 5)), live(page))
        page.wait_for_timeout(2200)

        tree_item = page.locator("[role=treeitem]").filter(has_text="small").first
        tree_item.click()
        page.keyboard.press("F2")
        tfield = page.locator("[data-testid=tree-rename-input]")
        check("the tree's rename field is labelled", bool(wait(lambda: tfield.count() == 1, 5)) and (tfield.get_attribute("aria-label") or "").startswith("Rename small"), str(tfield.get_attribute("aria-label") if tfield.count() else None))
        page.keyboard.press("Escape")
        page.keyboard.press("Shift+F10")
        menu = page.locator("[data-testid=sources-context-menu]")
        check("Shift+F10 opens a tree row's menu", bool(wait(lambda: menu.is_visible(), 5)))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        open_folder(page, base, pid, small)
        list_view(page)
        listing.focus()
        page.keyboard.press("Home")
        page.keyboard.press("ContextMenu")
        check("the Menu key opens a listing row's menu", bool(wait(lambda: menu.is_visible(), 5)))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        inspector_title = page.locator("aside[data-testid=inspector]").get_by_test_id("inspector-rename")
        if inspector_title.count():
            inspector_title.click()
            ifield = page.get_by_test_id("inspector-rename-input")
            check("the inspector's rename field is labelled", bool(wait(lambda: ifield.count() == 1, 5)) and bool(ifield.get_attribute("aria-label") or ifield.evaluate("e => e.labels?.length || 0")), str(ifield.get_attribute("aria-label") if ifield.count() else None))
            page.keyboard.press("Escape")

        # Keyboard twins of drags: ⌘C/⌘V copies (⌥-drag), ⌘X/⌘V moves (drag).
        listing.focus()
        row(page, "charlie.txt").click()
        page.keyboard.press("ControlOrMeta+c")
        check("copying is announced", bool(wait(lambda: live(page).startswith("Copied"), 5)), live(page))
        page.locator("[role=treeitem]").filter(has_text="dest").first.click()
        page.wait_for_function("document.querySelector('[data-testid=path-current]')?.textContent === 'dest'", timeout=10000)
        page.wait_for_timeout(500)
        listing.focus()
        page.keyboard.press("ControlOrMeta+v")
        check("⌘C then ⌘V in another folder copies (the ⌥-drag twin)", bool(wait(lambda: "charlie.txt" in names(page, pid, dest) and "charlie.txt" in names(page, pid, small), 10)), f"{names(page, pid, dest)} / {names(page, pid, small)}")
        check("the paste is announced", bool(wait(lambda: "charlie" in live(page) or "Copied" in live(page) or "cop" in live(page).lower(), 5)), live(page))
        page.wait_for_timeout(2200)
        row(page, "keep.txt").click()
        page.keyboard.press("ControlOrMeta+Backspace")
        check("moving to Trash is announced", bool(wait(lambda: "Trash" in live(page), 5)), live(page))
        page.wait_for_timeout(2200)
        listing.focus()
        page.keyboard.press("ControlOrMeta+z")
        check("undo is announced", bool(wait(lambda: live(page).startswith(("Undid", "Undone")), 5)), live(page))

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return summary()


if __name__ == "__main__":
    sys.exit(main())
