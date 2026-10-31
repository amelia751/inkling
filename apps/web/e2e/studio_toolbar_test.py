"""The calmer Studio toolbar, decision bar and shortcuts sheet (todo/todo8.md D4, D5, D6, D10).

    INKLING_E2E=1 pnpm exec vite --port 5223 --strictPort     # in apps/web
    python3 e2e/studio_toolbar_test.py --port 5223

- The 2D X-ray sample is a classification task: no drawing tools (Rule 1), a decision bar whose
  keys record the class and move to the next to-do item, and `N` for the next to-do item.
- With a region group, image-2d folds its tools into split buttons (Rule 2); keys don't change
  and set the group's face; the toolbar stays within the D10 budget.
- The shortcuts sheet leads with Essentials, searches by label or key, and the status bar's
  `? Shortcuts` hint goes once it has been opened.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, open_studio, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
TOOLBAR = "[role=toolbar][aria-label='Annotation tools']"
REGION = [{"name": "labels", "control": "Labels", "classes": [{"id": "normal"}, {"id": "pneumonia"}]}]

# todo8 D10: a guard against re-cluttering. The image-2d toolbar shows at most this many controls
# (tool buttons, split buttons counted once, plugin toolbar actions, undo and redo; the
# renderer's View controls are their own group). A new button has to replace one or go in a menu.
MAX_TOOLBAR_CONTROLS = 10

# Start from empty per-viewer prefs once per test context (a reload keeps them).
FRESH = "try { if (!sessionStorage.getItem('fresh')) { localStorage.clear(); sessionStorage.setItem('fresh', '1') } } catch {}"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def wait_for(fn, what: str, timeout: float = 20):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError(f"timed out waiting for {what}")


def ready(st) -> None:
    st.page.wait_for_selector("[data-testid=image-canvas] canvas", timeout=30000)
    wait_for(lambda: st.store("s => s.projectId") == "2d-xray", "the Studio")
    st.page.wait_for_timeout(800)


def visible_tools(page) -> list[str]:
    return page.eval_on_selector_all(f"{TOOLBAR} [data-tool]", "els => els.filter(e => e.offsetParent).map(e => e.dataset.tool)")


def toolbar_controls(page) -> int:
    return page.eval_on_selector_all(
        f"{TOOLBAR} button",
        """els => els.filter(e => e.offsetParent && !e.closest("[role=group][aria-label='View controls']") && e.dataset.testid !== "tool-group-menu").length""",
    )


def classification(browser, port: int) -> None:
    st = open_studio(browser, port, "2d-xray", fixture_annotations=[], init_script=FRESH)
    page = st.page
    try:
        ready(st)
        tools = visible_tools(page)
        check("classification: navigation and measure only (Rule 1)", tools == ["select", "pan", "windowLevel", "length"], str(tools))
        check("classification: no shape or paint groups", page.locator("[data-testid=tool-group-shape], [data-testid=tool-group-mask]").count() == 0)

        bar = page.locator("[data-testid=decision-bar]")
        check("decision bar under the canvas", bar.count() == 1)
        choices = bar.locator("[data-testid=decision-choice]")
        texts = [choices.nth(i).inner_text().replace("\n", " ") for i in range(choices.count())]
        check("decision bar: keyed buttons [1 Normal] [2 Pneumonia]", texts == ["1 normal", "2 pneumonia"] or texts == ["1 Normal", "2 Pneumonia"], str(texts))

        # Pressing 2 records Pneumonia on the current item and moves to the next to-do item.
        start = st.store("s => s.itemIndex")
        page.mouse.click(5, 300)
        page.keyboard.press("2")
        wait_for(lambda: st.store("s => s.itemIndex") != start, "the next item")
        recorded = st.store(f"s => s.annotations.filter(a => a.geometry.type === 'class').map(a => a.label)")
        check("pressing 2 records Pneumonia", recorded == ["pneumonia"], str(recorded))
        check("…and advances to the next to-do item", st.store("s => s.itemIndex") == start + 1, str(st.store("s => s.itemIndex")))

        # The class landed on the item we were on, not the one we moved to.
        on_first = page.locator("[data-testid=decision-choice][aria-pressed=true]").count()
        check("the new item starts undecided", on_first == 0)

        # Clicking a button works the same way; Advance after choosing can be turned off.
        bar.get_by_role("button", name="Decision bar options").click()
        page.locator("[data-testid=decision-advance]").click()
        page.keyboard.press("Escape")
        here = st.store("s => s.itemIndex")
        bar.locator("[data-testid=decision-choice][data-class=normal]").click()
        page.wait_for_timeout(400)
        check("advance off: the bar records and stays", st.store("s => s.itemIndex") == here and bar.locator("[data-class=normal][aria-pressed=true]").count() == 1)

        # N: the next to-do item in queue order skips the two decided items.
        st.act("s => s.setItemIndex(0)")
        page.mouse.click(5, 300)
        page.keyboard.press("n")
        wait_for(lambda: st.store("s => s.itemIndex") == 2, "N to reach the first to-do item", 5)
        check("N goes to the next to-do item", st.store("s => s.itemIndex") == 2)

        # The ? Shortcuts hint opens the sheet once, then goes.
        hint = page.locator("[data-testid=shortcuts-hint]")
        check("status bar shows ? Shortcuts until the sheet is opened", hint.count() == 1)
        hint.click()
        dialog = page.locator("[data-testid=shortcuts-dialog]")
        dialog.wait_for(timeout=5000)
        essentials = dialog.locator("[data-testid=shortcuts-essentials] [data-testid=shortcut-row]")
        check("sheet: Essentials first, at most 8 rows", 0 < essentials.count() <= 8, str(essentials.count()))
        check("sheet: footer about typing", "Keys don't fire while you type in a field" in dialog.inner_text())
        tools_text = dialog.locator("[data-testid=shortcuts-tools]").inner_text()
        check("sheet: only this task's tools", "Length" in tools_text and "Brush" not in tools_text and "Box" not in tools_text, tools_text[:120])
        dialog.locator("[data-testid=shortcuts-search]").fill("next to")
        page.wait_for_timeout(200)
        check("sheet: search by label", [r.strip() for r in dialog.locator("[data-testid=shortcut-row] dt").all_inner_texts()] == ["Next to do"], str(dialog.locator("[data-testid=shortcut-row] dt").all_inner_texts()))
        page.keyboard.press("Escape")
        wait_for(lambda: hint.count() == 0, "the hint to go")
        check("the hint goes once the sheet has been opened", hint.count() == 0)
        errs = [e for e in st.errors if "favicon" not in e]
        check("classification: no page errors", not errs, "; ".join(errs[:3]))
    finally:
        st.page.context.close()


def regions(browser, port: int) -> None:
    st = open_studio(browser, port, "2d-xray", fixture_annotations=[], extra_labels=REGION, init_script=FRESH)
    page = st.page
    try:
        ready(st)
        tools = visible_tools(page)
        check("image-2d: Select · Pan · W/L | Box▾ | Length▾ | Brush▾", tools == ["select", "pan", "windowLevel", "box", "length", "brush"], str(tools))
        n = toolbar_controls(page)
        check(f"D10: image-2d toolbar shows ≤ {MAX_TOOLBAR_CONTROLS} controls", n <= MAX_TOOLBAR_CONTROLS, f"{n} controls")
        check("the decision bar stays for the Choices group", page.locator("[data-testid=decision-bar]").count() == 1)

        # Keys don't change: J picks Cobb angle and makes it the Measure button's face.
        page.mouse.click(5, 300)
        page.keyboard.press("j")
        wait_for(lambda: st.store("s => s.tool") == "cobb", "J to select Cobb angle")
        check("J makes Cobb angle the Measure face", "cobb" in visible_tools(page) and "length" not in visible_tools(page), str(visible_tools(page)))
        page.keyboard.press("v")
        wait_for(lambda: st.store("s => s.tool") == "select", "V")
        check("the face stays the last used tool", "cobb" in visible_tools(page), str(visible_tools(page)))

        # The chevron opens the group with names and keys.
        page.locator("[data-testid=tool-group-shape] [data-testid=tool-group-menu]").click()
        rows = page.locator("[role=menu] [data-tool-row]")
        rows.first.wait_for(timeout=5000)
        names = [rows.nth(i).get_attribute("data-tool-row") for i in range(rows.count())]
        check("the Shapes menu lists the group", names == ["box", "ellipse", "polygon", "freehand", "keypoint"], str(names))
        check("menu rows show the key", "O" in page.locator("[role=menu] [data-tool-row=ellipse]").inner_text(), page.locator("[role=menu] [data-tool-row=ellipse]").inner_text())
        page.locator("[role=menu] [data-tool-row=ellipse]").click()
        wait_for(lambda: st.store("s => s.tool") == "ellipse", "the ellipse row")
        check("picking a row selects the tool and makes it the face", "ellipse" in visible_tools(page), str(visible_tools(page)))

        # With region labels, digits keep picking the active label instead of deciding.
        page.mouse.click(5, 300)
        page.keyboard.press("2")
        page.wait_for_timeout(300)
        check("with region labels, 2 picks the active label", st.store("s => s.activeLabel") == "pneumonia" and st.store("s => s.annotations.length") == 0)

        # A reload keeps the faces (last used per group per environment).
        page.reload()
        ready(st)
        check("faces survive a reload", "cobb" in visible_tools(page) and "ellipse" in visible_tools(page), str(visible_tools(page)))
        errs = [e for e in st.errors if "favicon" not in e]
        check("regions: no page errors", not errs, "; ".join(errs[:3]))
    finally:
        st.page.context.close()


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        for scenario in (classification, regions):
            try:
                scenario(browser, args.port)
            except Exception as e:  # noqa: BLE001
                check(f"{scenario.__name__} scenario ran", False, repr(e))
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
