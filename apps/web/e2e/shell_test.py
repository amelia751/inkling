"""Studio shell behaviour shared by every viewer: labels panel, selection, shortcuts, exports.

    python3 e2e/shell_test.py --port 5199
"""

from __future__ import annotations

import sys
from pathlib import Path

from harness import launch, open_studio, parse_args, sync_playwright

DATASETS = ["2d-xray", "3d-brain-mri", "ecg-waveform", "video-endoscopy", "4d-cardiac", "pathology-wsi"]
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def wait_ready(studio) -> None:
    studio.page.wait_for_selector("main[aria-label='Viewer']", timeout=30000)
    studio.page.wait_for_timeout(2500)


def labels_and_selection(browser, port: int, out: Path) -> None:
    # The 2D sample is classification-only (todo8 D4); a region group brings back region labels and Box.
    region = [{"name": "labels", "control": "Labels", "classes": [{"id": "normal"}, {"id": "pneumonia"}]}]
    s = open_studio(browser, port, "2d-xray", extra_labels=region)
    wait_ready(s)
    page = s.page
    page.get_by_role("tab", name="Labels").click()

    # Digit keys pick labels; tool keys switch tools (focus the page body first).
    page.mouse.click(5, 300)
    page.keyboard.press("2")
    check("digit picks label", s.store("s => s.activeLabel") == "pneumonia", s.store("s => s.activeLabel"))
    page.keyboard.press("r")
    check("tool key switches tool", s.store("s => s.tool") == "box", s.store("s => s.tool"))
    page.keyboard.press("v")

    # Hide / lock live in a label row's ⋯ menu; while on, the row shows a button that undoes it.
    page.get_by_role("button", name="More for normal").click()
    page.get_by_role("menuitem", name="Hide normal").click()
    check("hide label", s.store("s => s.hiddenLabels") == ["normal"])
    page.get_by_role("button", name="Show normal").click()
    page.get_by_role("button", name="More for normal").click()
    page.get_by_role("menuitem", name="Lock normal").click()
    check("lock label", s.store("s => s.lockedLabels") == ["normal"])

    # Locked labels survive Delete; unlocking allows it.
    first = s.act("s => { const a = s.annotations.find(a => a.label === 'normal' && a.itemId === s.annotations[0].itemId); s.select(a.id); return a.id }")
    page.mouse.click(5, 300)
    page.keyboard.press("Delete")
    page.wait_for_timeout(200)
    check("locked label blocks delete", s.store(f"s => s.annotations.some(a => a.id === '{first}')"))
    page.get_by_role("button", name="Unlock normal").click()

    # Overlay opacity is in the viewport bar's View controls; its slider writes the store.
    page.get_by_test_id("overlay-opacity").click()
    slider = page.get_by_role("slider", name="Overlay opacity")
    slider.focus()
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")
    check("opacity slider", abs(s.store("s => s.overlayOpacity") - 0.9) < 1e-6, str(s.store("s => s.overlayOpacity")))
    page.keyboard.press("Escape")
    check("no opacity slider left in the Labels panel", page.locator("[role='tabpanel']").get_by_role("slider", name="Overlay opacity").count() == 0)

    # ⌘A selects the item's annotations; bulk relabel is one undo step.
    page.mouse.click(5, 300)
    n_item = s.store("s => s.annotations.filter(a => a.itemId === s.annotations[0].itemId && a.geometry.type !== 'class').length")
    page.keyboard.press("Meta+a")
    page.wait_for_timeout(200)
    sel = s.store("s => s.selectedIds.length")
    check("⌘A selects item annotations", sel == n_item and sel > 1, f"{sel} of {n_item}")
    panel = page.locator("[aria-label='Selected annotations']")
    check("bulk panel shown", panel.count() == 1)
    s.shot("shell-bulk-panel", out)
    past = s.store("s => s.past.length")
    panel.locator("select").select_option("pneumonia")
    page.wait_for_timeout(200)
    relabeled = s.store("s => s.annotations.filter(a => s.selectedIds.includes(a.id)).every(a => a.label === 'pneumonia')")
    check("bulk relabel", relabeled and s.store("s => s.past.length") == past + 1)
    page.mouse.click(5, 300)
    page.keyboard.press("Meta+z")
    page.wait_for_timeout(200)
    check("bulk relabel undoes in one step", s.store("s => s.annotations.filter(a => s.selectedIds.includes(a.id)).every(a => a.label === 'normal')"))

    # Shift-click in "On this image" adds to the selection (the Studio's Review tab is gone).
    check("no Review tab in the Studio", page.get_by_role("tab", name="Review").count() == 0)
    check("the Items tab is named by the data kind", page.get_by_role("tab", name="Images").count() == 1)
    page.keyboard.press("Escape")
    rows = page.locator("[data-testid='on-this-item'] [data-testid='annotation-row']")
    check("On this image lists the item's annotations", rows.count() >= 2, f"{rows.count()} rows")
    rows.nth(0).locator("button").first.click()
    check("click in On this image selects", s.store("s => s.selectedIds.length") == 1)
    rows.nth(1).locator("button").first.click(modifiers=["Shift"])
    check("shift-click On this image multi-selects", s.store("s => s.selectedIds.length") == 2, str(s.store("s => s.selectedIds.length")))
    check("the selection is pinned below the lists", page.locator("[data-testid='selection-section'] [aria-label='Selected annotations']").count() == 1)
    n = rows.count()
    rows.nth(0).hover()
    rows.nth(0).get_by_role("button", name="Remove").click()
    page.wait_for_timeout(200)
    check("hover Remove deletes the row", rows.count() == n - 1, f"{n} -> {rows.count()}")
    page.mouse.click(5, 300)
    page.keyboard.press("Meta+z")
    page.wait_for_timeout(200)

    # Item navigation from the shell.
    page.keyboard.press("Escape")
    page.mouse.click(5, 300)
    before = s.store("s => s.itemIndex")
    page.keyboard.press("PageDown")
    check("PageDown next item", s.store("s => s.itemIndex") == before + 1)
    check("no page errors (2d shell)", not s.errors, "; ".join(s.errors[:3]))
    check("nothing written to disk", all(True for _ in s.saves), f"{len(s.saves)} intercepted saves")
    s.page.context.close()


def exports(browser, port: int, out: Path) -> None:
    for ds in DATASETS:
        s = open_studio(browser, port, ds)
        page = s.page
        page.goto(f"http://localhost:{port}/datasets/{ds}/export")
        page.wait_for_selector("text=Standard formats", timeout=20000)
        buttons = page.get_by_role("button", name="Download")
        n = buttons.count()
        check(f"{ds}: export formats listed", n >= 1, f"{n} formats")
        page.locator("#rights").click()
        ok = 0
        for i in range(n):
            with page.expect_download(timeout=60000) as dl:
                buttons.nth(i).click()
            d = dl.value
            path = out / "exports" / ds / d.suggested_filename
            path.parent.mkdir(parents=True, exist_ok=True)
            d.save_as(str(path))
            ok += path.stat().st_size > 0
        check(f"{ds}: every format downloads non-empty", ok == n, f"{ok}/{n}")
        err = page.locator("text=/: .*Error|failed/i").count()
        check(f"{ds}: no exporter errors shown", err == 0)
        page.context.close()


def main() -> int:
    args = parse_args()
    out = Path(args.out)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        labels_and_selection(browser, args.port, out)
        exports(browser, args.port, out)
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
