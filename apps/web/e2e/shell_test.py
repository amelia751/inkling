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
    s = open_studio(browser, port, "2d-xray")
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

    # Hide / lock buttons on a label row.
    page.get_by_role("button", name="Hide normal").click()
    check("hide label", s.store("s => s.hiddenLabels") == ["normal"])
    page.get_by_role("button", name="Show normal").click()
    page.get_by_role("button", name="Lock normal").click()
    check("lock label", s.store("s => s.lockedLabels") == ["normal"])

    # Locked labels survive Delete; unlocking allows it.
    first = s.act("s => { const a = s.annotations.find(a => a.label === 'normal' && a.itemId === s.annotations[0].itemId); s.select(a.id); return a.id }")
    page.mouse.click(5, 300)
    page.keyboard.press("Delete")
    page.wait_for_timeout(200)
    check("locked label blocks delete", s.store(f"s => s.annotations.some(a => a.id === '{first}')"))
    page.get_by_role("button", name="Unlock normal").click()

    # Opacity slider writes the store.
    slider = page.get_by_role("slider", name="Overlay opacity")
    slider.focus()
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")
    check("opacity slider", abs(s.store("s => s.overlayOpacity") - 0.9) < 1e-6, str(s.store("s => s.overlayOpacity")))

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

    # Shift-click in the review list adds to the selection.
    page.get_by_role("tab", name="Review").click()
    page.keyboard.press("Escape")
    cards = page.locator("[role='tabpanel'] button.w-full.text-left")
    cards.nth(0).click()
    cards.nth(1).click(modifiers=["Shift"])
    check("shift-click review list multi-selects", s.store("s => s.selectedIds.length") == 2, str(s.store("s => s.selectedIds.length")))

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
