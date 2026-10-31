"""Studio space management (todo6 Phase 7, docs/ux.md §8): with the project rail and the left
panel hidden and the assistant closed, the canvas takes the full width and tools still work.
Showing them again restores the three columns.

    python3 e2e/studio_layout_test.py --port 5207
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, open_studio, parse_args, sync_playwright  # noqa: E402

MOD = "Meta" if sys.platform == "darwin" else "Control"
results: list[tuple[str, bool, str]] = []


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


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        # The 2D sample is classification-only (todo8 D4); a region group brings back the Box tool drawn below.
        region = [{"name": "labels", "control": "Labels", "classes": [{"id": "normal"}, {"id": "pneumonia"}]}]
        st = open_studio(browser, args.port, "2d-xray", fixture_annotations=[], extra_labels=region)
        page = st.page
        try:
            page.wait_for_selector("[data-testid=image-canvas] canvas", timeout=30000)
            wait_for(lambda: st.store("s => s.projectId") == "2d-xray", "the Studio")
            viewer = page.locator("main[aria-label='Viewer']")
            w0 = viewer.bounding_box()["width"]
            check("starts with the rail and the left panel", page.locator("[data-testid=project-rail]").count() == 1 and page.locator("[data-testid=files-panel]").count() == 1)
            check("the assistant starts closed", st.store("s => s.aiOpen") is False)

            # Guard against re-cluttering (todo8 D10, todo/todo8.md §3): at 1440px the Studio header
            # has at most 7 visible interactive controls. A new one replaces one or goes in ⋯.
            MAX_HEADER_CONTROLS = 7
            controls = page.evaluate("""() => [...document.querySelectorAll('[data-testid=studio-header] :is(button, a[href], input, select, [role=button], [tabindex]:not([tabindex="-1"]))')]
                .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })
                .map((el) => el.getAttribute('aria-label') || el.textContent.trim())""")
            check(f"the Studio header has ≤ {MAX_HEADER_CONTROLS} controls at 1440px", 0 < len(controls) <= MAX_HEADER_CONTROLS, f"{len(controls)}: {controls}")
            header = page.locator("[data-testid=studio-header]").inner_text()
            check("the header has no retired words", not any(w in header for w in ("Review dataset", "Export dataset", "Submit for review", "Personal", "Draft")), header.replace("\n", " · "))
            check("the project is a link to its Overview", page.locator("[data-testid=studio-project-link]").get_attribute("href") == "/projects/2d-xray/overview")
            page.get_by_test_id("studio-more").click()
            menu = page.get_by_role("menu")
            menu.wait_for(timeout=5000)
            check("⋯ holds Task setup, shortcuts, Plugins, Theme and project Review",
                  all(menu.get_by_text(t).count() for t in ("Task setup…", "Keyboard shortcuts", "Theme", "Open project Review")) and page.get_by_role("link", name="Plugins").count() == 1,
                  menu.inner_text().replace("\n", " · "))
            page.keyboard.press("Escape")
            menu.wait_for(state="detached", timeout=5000)

            # Hide the rail (the shared navigation command) and the left panel (its toggle).
            page.mouse.move(3, 3)
            page.keyboard.press(f"{MOD}+b")
            wait_for(lambda: page.locator("[data-testid=project-rail]").count() == 0, "the rail to hide")
            page.locator("[data-testid=toggle-left-panel]").click()
            wait_for(lambda: page.locator("[data-testid=files-panel]").count() == 0, "the left panel to hide")
            page.wait_for_timeout(400)
            w1 = viewer.bounding_box()["width"]
            check("hidden rail and panels leave a full-width canvas", w1 >= 1440 - 2 and w1 > w0, f"{w0:.0f} → {w1:.0f}px of 1440")
            check("the toggle reports its state", page.locator("[data-testid=toggle-left-panel]").get_attribute("aria-pressed") == "false")

            # A tool works with every panel hidden: draw a box with R.
            before = st.store("s => s.annotations.length")
            page.mouse.move(3, 3)
            page.keyboard.press("r")
            wait_for(lambda: st.store("s => s.tool") == "box", "the box tool")
            b = page.locator("[data-testid=image-canvas]").bounding_box()
            cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            page.mouse.move(cx - 60, cy - 40)
            page.mouse.down()
            page.mouse.move(cx, cy, steps=5)
            page.mouse.move(cx + 60, cy + 40, steps=5)
            page.mouse.up()
            wait_for(lambda: st.store("s => s.annotations.length") == before + 1, "the new box", 10)
            g = st.store("s => s.annotations[s.annotations.length - 1].geometry")
            check("the box tool draws with the assistant closed", g["type"] == "box" and g["w"] > 10, str(g))

            # The shortcut brings the left panel back; the canvas gives the width back.
            page.mouse.move(3, 3)
            page.keyboard.press(f"Shift+{MOD}+b")
            wait_for(lambda: page.locator("[data-testid=files-panel]").count() == 1, "the left panel to return")
            page.keyboard.press(f"{MOD}+b")
            wait_for(lambda: page.locator("[data-testid=project-rail]").count() == 1, "the rail to return")
            page.wait_for_timeout(400)
            check("showing them again narrows the canvas", viewer.bounding_box()["width"] < w1 - 200, f"{viewer.bounding_box()['width']:.0f}px")
            rows = page.locator("[data-testid=file-row]")
            # todo8 D3: an item row shows its kind icon only when the task mixes kinds; every row has a state.
            check("Items rows show a state, and no kind icon in a one-kind task", rows.count() == 20 and rows.first.get_attribute("data-state") is not None and page.locator("[data-testid=file-row] [data-testid=file-kind]").count() == 0, f"{rows.count()} rows")
            check("the new box marks its item annotated", page.locator("[data-testid=file-row][aria-current=true]").get_attribute("data-state") == "annotated")
            errs = [e for e in st.errors if "favicon" not in e]
            check("no page errors", not errs, "; ".join(errs[:3]))
        except Exception as e:  # noqa: BLE001
            check("layout scenario ran", False, repr(e))
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
