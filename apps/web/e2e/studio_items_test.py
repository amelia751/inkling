"""todo8 Phase 3 (D3, D8): the Items panel follows the file system.

    INKLING_E2E=1 pnpm exec vite --port 5225 --strictPort      # in apps/web
    python3 e2e/studio_items_test.py --port 5225

- the 3D sample's items (studies, never raw sequences) render in the Folders view;
- Queue → To do → N walks only the to-do items;
- duplicate names show their distinguishing folder (an injected project with nested folders,
  which also opens in Folders by default because its items span several folders);
- the row menu's Show in Data opens Data with the file revealed, and Data's "In tasks" opens
  the Studio back on that item;
- in the 2D sample (classification, blind by default), no item row, hover card or status text
  says "Pneumonia" or "Normal";
- the status bar path narrows the list to a folder.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import REPO, Studio, launch, open_studio, parse_args, sync_playwright  # noqa: E402

SEED_JPEG = REPO / "seed-data" / "2d-xray" / "normal" / "IM-0001-0001.jpeg"
DUP = "items-dup-demo"


def dup_project() -> dict:
    """Nested folders with a duplicate file name (the stand-in carries no such sample)."""
    files = [
        (["patient_07", "series_2"], "IM-0001.jpeg"),
        (["patient_08", "series_2"], "IM-0001.jpeg"),
        (["patient_08"], "IM-0002.jpeg"),
        (["other"], "scan.jpeg"),
    ]
    assets = [{"path": f"{DUP}/{'/'.join(folder)}/{name}", "sha256": "", "bytes": 1000, "width": 64, "height": 64, "folder": folder} for folder, name in files]
    return {
        "id": DUP,
        "title": "Items demo",
        "task": "segmentation",
        "status": "available",
        "source": "e2e",
        "license": "e2e",
        "environment": {"extends": "preset:image-2d", "task": "segmentation", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "lesion"}]}]},
        "assets": assets,
    }


class Results:
    def __init__(self) -> None:
        self.failed: list[str] = []

    def run(self, name: str, fn) -> None:
        t = time.time()
        try:
            fn()
            print(f"PASS {name} ({time.time() - t:.1f}s)", flush=True)
        except Exception as e:  # noqa: BLE001
            self.failed.append(name)
            print(f"FAIL {name}: {e}", flush=True)


def check(what: str, ok: bool) -> None:
    if not ok:
        raise AssertionError(what)


def wait_for(fn, what: str, timeout: float = 20) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.15)
    raise AssertionError(f"timed out waiting for {what}")


def ready(st: Studio) -> None:
    st.page.wait_for_selector("[data-testid=files-panel]", timeout=60000)
    wait_for(lambda: st.page.locator("[data-testid=file-row]").count() > 0, "item rows", 60)


def rows(st: Studio):
    return st.page.locator("[data-testid=file-row]")


def main() -> int:
    args = parse_args()
    res = Results()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)

        def folders_3d() -> None:
            st = open_studio(browser, args.port, "3d-brain-mri", fixture_annotations=[])
            try:
                ready(st)
                page = st.page
                page.click("[data-testid=items-view-queue]")
                subjects = rows(st).count()
                page.click("[data-testid=items-view-folders]")
                page.wait_for_selector("[data-testid=items-tree] [role=tree]", timeout=10000)
                wait_for(lambda: subjects >= 2 and rows(st).count() == subjects, "every subject in the tree")
                names = sorted(rows(st).all_inner_texts())
                check(f"subjects listed by name: {names}", all("BraTS2021_" in n for n in names))
                # Items are studies, never raw sequences.
                check("no raw files", not any(".nii" in n for n in names))
                rows(st).nth(1).click()
                wait_for(lambda: st.store("s => s.itemIndex") == 1 and rows(st).nth(1).get_attribute("aria-current") == "true", "clicking a tree row opens it")
                # The choice is remembered per task: a reload keeps Folders.
                page.reload()
                ready(st)
                check("view remembered", page.locator("[data-testid=files-panel]").get_attribute("data-view") == "folders")
                check("no console errors", not [e for e in st.errors if "favicon" not in e])
            finally:
                st.page.context.close()

        def queue_todo_next() -> None:
            first = "2d-xray/normal/IM-0001-0001.jpeg"
            third = "2d-xray/normal/IM-0005-0001.jpeg"
            ann = [
                {"id": f"x{i}", "itemId": item, "label": "normal", "provenance": "human-created", "author": "me", "createdAt": "2026-10-30T00:00:00Z", "geometry": {"type": "class"}}
                for i, item in enumerate([first, third])
            ]
            st = open_studio(browser, args.port, "2d-xray", fixture_annotations=ann)
            try:
                ready(st)
                page = st.page
                page.click("[data-testid=items-view-queue]")
                page.click("[data-testid=queue-chip][data-filter=todo]")
                wait_for(lambda: rows(st).count() == 18, "18 to-do items")
                check("To do lists only to-do rows", set(rows(st).evaluate_all("els => els.map(e => e.dataset.state)")) == {"todo"})
                seen = []
                page.mouse.click(5, 5)
                for _ in range(4):
                    page.keyboard.press("n")
                    time.sleep(0.25)
                    seen.append(st.store("s => s.itemIndex"))
                # N walks forward over to-do items only, in queue order.
                # Items 0 and 2 are done (manifest order): from item 0, N goes 1, 3, 4, 5.
                check(f"N walks forward over to-do items: {seen}", seen == [1, 3, 4, 5])
                current_names = []
                for idx in seen:
                    st.act(f"s => s.setItemIndex({idx})")
                    time.sleep(0.1)
                    current_names.append(page.locator("[data-testid=item-path]").inner_text())
                check(f"N skipped the done items: {current_names}", not any(n.endswith("IM-0001-0001.jpeg") or n.endswith("IM-0005-0001.jpeg") for n in current_names))
            finally:
                st.page.context.close()

        def duplicates() -> None:
            fixtures = {a["path"]: SEED_JPEG for a in dup_project()["assets"]}
            st = open_studio(browser, args.port, DUP, extra_projects=[dup_project()], fixtures=fixtures, fixture_annotations=[])
            try:
                ready(st)
                page = st.page
                check("Folders is the default when items span several folders", page.locator("[data-testid=files-panel]").get_attribute("data-view") == "folders")
                wait_for(lambda: rows(st).count() == 4, "four items in the tree")
                folders = page.locator("[data-testid=folder-row]").all_inner_texts()
                check(f"folder progress shown: {folders}", any("0/" in f for f in folders))
                suffixes = sorted(page.locator("[data-testid=file-row] [data-testid=file-suffix]").all_inner_texts())
                check(f"duplicates show their distinguishing folder: {suffixes}", suffixes == ["patient_07/series_2", "patient_08/series_2"])
                page.click("[data-testid=items-view-queue]")
                q = sorted(page.locator("[data-testid=file-row] [data-testid=file-suffix]").all_inner_texts())
                check(f"and in the Queue: {q}", q == suffixes)
                # The status bar path narrows the list to a folder.
                idx = st.page.evaluate("() => [...document.querySelectorAll('[data-testid=file-row]')].findIndex(r => r.innerText.includes('IM-0002'))")
                rows(st).nth(idx).click()
                page.wait_for_selector("[data-testid=item-path-segment]", timeout=5000)
                segs = page.locator("[data-testid=item-path-segment]").all_inner_texts()
                check(f"path segments: {segs}", segs == ["patient_08"])
                page.locator("[data-testid=item-path-segment]").first.click()
                wait_for(lambda: rows(st).count() == 2, "the list narrowed to patient_08")
                page.click("[data-testid=items-folder-filter] button")
                wait_for(lambda: rows(st).count() == 4, "every folder again")
                # Hover card after 400ms, with the path.
                rows(st).first.hover()
                page.wait_for_selector("[data-testid=item-hover-card]", timeout=3000)
                check("hover card has the path", "/" in page.locator("[data-testid=item-hover-path]").inner_text())
            finally:
                st.page.context.close()

        def show_in_data() -> None:
            st = open_studio(browser, args.port, "3d-brain-mri", fixture_annotations=[])
            try:
                ready(st)
                page = st.page
                page.click("[data-testid=items-view-queue]")
                target = rows(st).nth(1)
                name = target.locator("[data-testid=file-name]").inner_text()
                target.click(button="right")
                page.click("[data-testid=show-in-data]")
                wait_for(lambda: "/projects/3d-brain-mri/files/" in page.url, "Data opens")
                page.wait_for_selector("[data-testid=inspector] h2", timeout=15000)
                wait_for(lambda: page.locator("[data-testid=inspector] h2").inner_text().startswith(name), "the file is revealed")
                check("selected in the listing", page.locator("[data-testid=listing-row][aria-selected=true]").count() >= 1)
                check("no file name in the URL", name not in page.url)
                # And back: Data's "In tasks" opens the Studio on that item.
                page.wait_for_selector("[data-testid=in-tasks] [data-testid=open-in-studio]", timeout=15000)
                page.click("[data-testid=in-tasks] [data-testid=open-in-studio]")
                page.wait_for_selector("[data-testid=files-panel]", timeout=60000)
                wait_for(lambda: page.locator("[data-testid=item-path]").inner_text().endswith(name), "the Studio opens on that item", 30)
            finally:
                st.page.context.close()

        def blind_2d() -> None:
            st = open_studio(browser, args.port, "2d-xray", fixture_annotations=[])
            try:
                ready(st)
                page = st.page
                for view in ("queue", "folders"):
                    page.click(f"[data-testid=items-view-{view}]")
                    time.sleep(0.3)
                    text = " ".join(rows(st).all_inner_texts()) + " " + page.locator("[data-testid=files-panel]").inner_text()
                    check(f"{view}: no source label in the rows", "pneumonia" not in text.lower() and "normal" not in text.lower())
                page.click("[data-testid=items-view-queue]")
                for i in (0, 12):
                    st.act(f"s => s.setItemIndex({i})")
                    time.sleep(0.3)
                    # The status bar (the decision bar above it rightly shows the classes to pick).
                    bar = page.locator("[data-testid=status-bar]").inner_text()
                    check(f"status bar quiet about the label: {bar}", "pneumonia" not in bar.lower() and "normal" not in bar.lower() and "source label" not in bar.lower())
                    rows(st).nth(i).hover()
                    page.wait_for_selector("[data-testid=item-hover-card]", timeout=3000)
                    card = page.locator("[data-testid=item-hover-card]").inner_text()
                    check(f"hover card quiet about the label: {card}", "pneumonia" not in card.lower() and "normal" not in card.lower())
                    page.mouse.move(800, 5)
            finally:
                st.page.context.close()

        res.run("folders render for the 3D sample (and the view is remembered)", folders_3d)
        res.run("Queue → To do → N walks only to-do items", queue_todo_next)
        res.run("duplicate names show suffixes; path filter; hover card", duplicates)
        res.run("Show in Data reveals the file; In tasks opens it again", show_in_data)
        res.run("2D sample: blind by default (no Pneumonia / Normal)", blind_2d)
        browser.close()
    print(f"\n{'FAILED: ' + ', '.join(res.failed) if res.failed else 'all passed'}")
    return 1 if res.failed else 0


if __name__ == "__main__":
    sys.exit(main())
