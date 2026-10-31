"""todo7 Phase 6 exit: versions, download and the held-file ZIP in Files, against the kernel.

Replace a file from the inspector ("Replace with new version…") and the Versions section shows two
versions; an older version downloads as `name (v1).ext`; a dataset pinned to version 1 shows
"Newer version available" with a preview; restoring version 1 brings back its thumbnail and facts;
a ZIP of a folder with one file held for privacy review has the others plus `_held_files.txt`, and
the toast says one was left out.

    INKLING_API_URL=http://127.0.0.1:8000 INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_versions_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import hashlib
import io
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from files_helpers import api, check, child, kernel_ok, launch, list_view, make_folder, new_project, open_folder, parse_args, png, row, summary, sync_playwright, toasts, wait  # noqa: E402


def detail(page, nid: str) -> dict:
    return api(page, f"/source-nodes/{nid}")["json"]


def ready(page, nid: str, version: int) -> dict | None:
    d = detail(page, nid)
    return d if d.get("version") == version and d.get("status") not in ("checking", "pending", None) and (d.get("facts") or {}).get("width") else None


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    v1, v2 = png(8, 6, 1), png(16, 12, 2)
    folder = make_folder({"scan.png": v1, "MRI/a.png": png(8, 8, 3), "MRI/b.png": png(8, 8, 4), "MRI/Smith_John.png": png(8, 8, 5)})
    new_file = Path(tempfile.mkdtemp(prefix="files-e2e-v2-")) / "scan.png"
    new_file.write_bytes(v2)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        # Playwright can't answer the native save picker a folder ZIP opens where the browser has
        # one; without it the page gathers the stream and downloads it (the other path it has).
        ctx.add_init_script("delete window.showSaveFilePicker")
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if not kernel_ok(page, base):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        pid, study = new_project(page, base, "Files versions e2e", folder)
        scan = child(page, pid, study, "scan.png")
        mri = child(page, pid, study, "MRI")
        first = wait(lambda: ready(page, scan["id"], 1), 60)
        check("the upload is inspected (facts: 8 × 6)", bool(first) and first["facts"]["width"] == 8, str(first and first.get("facts")))
        held = wait(lambda: (lambda n: n if n and n.get("status") == "privacy" else None)(child(page, pid, mri["id"], "Smith_John.png")), 60)
        check("Smith_John.png is held for privacy review (its name)", bool(held), str(child(page, pid, mri["id"], "Smith_John.png")))

        # A dataset made now pins scan.png at version 1 (D7).
        ds = api(page, f"/projects/{pid}/datasets", "POST", {"title": "Pinned", "nodeIds": [scan["id"]], "task": {"title": "T", "preset": "preset:image-2d"}})["json"]

        # ---- Replace with a new version from the inspector ----------------------------------
        open_folder(page, base, pid, study)
        list_view(page)
        row(page, "scan.png").click()
        inspector = page.locator("aside[data-testid=inspector]")
        img = inspector.get_by_test_id("preview-image")
        wait(lambda: img.count() and img.get_attribute("src"), 15)
        src_v1 = img.get_attribute("src") if img.count() else None
        unsigned = lambda u: (u or "").split("?")[0]  # noqa: E731 (signed URLs differ per request)
        with page.expect_file_chooser() as fc:
            inspector.get_by_test_id("version-replace").click()
        fc.value.set_files(str(new_file))
        rows = inspector.get_by_test_id("version-row")
        check("replacing shows two versions", bool(wait(lambda: rows.count() == 2, 30)), str(rows.all_inner_texts()))
        check("the new one is Current", "Current" in inspector.locator("[data-testid=version-row][data-version='2']").inner_text() if rows.count() == 2 else False)
        second = wait(lambda: ready(page, scan["id"], 2), 60)
        check("version 2 is inspected (16 × 12)", bool(second) and second["facts"]["width"] == 16, str(second and second.get("facts")))
        check("its thumbnail changes", bool(wait(lambda: img.count() and unsigned(img.get_attribute("src")) != unsigned(src_v1), 15)), f"{src_v1} → {img.get_attribute('src') if img.count() else None}")

        # ---- An older version downloads with its number --------------------------------------
        with page.expect_download() as dl:
            inspector.locator("[data-testid=version-row][data-version='1']").get_by_test_id("version-download").click()
        d = dl.value
        check("Download v1 gives “scan (v1).png” with version 1's bytes", d.suggested_filename == "scan (v1).png" and Path(d.path()).read_bytes() == v1, d.suggested_filename)

        # ---- The dataset pinned to v1 offers the update --------------------------------------
        page.goto(f"{base}/projects/{pid}/datasets/{ds['id']}")
        banner = page.get_by_test_id("dataset-newer-versions")
        check("the dataset says a newer version is available", bool(wait(lambda: banner.is_visible(), 15)) and "1 file" in banner.inner_text(), banner.inner_text() if banner.count() else "")
        page.get_by_test_id("dataset-update-versions").click()
        preview = page.get_by_test_id("dataset-update-preview")
        check("Update… previews the file, from v1 to v2", bool(wait(lambda: preview.is_visible() and "scan.png" in preview.inner_text(), 10)), preview.inner_text() if preview.count() else "")
        page.keyboard.press("Escape")

        # ---- Restoring v1 brings back its thumbnail and facts --------------------------------
        open_folder(page, base, pid, study)
        list_view(page)
        row(page, "scan.png").click()
        inspector.locator("[data-testid=version-row][data-version='1']").get_by_test_id("version-restore").click()
        check("restoring v1 adds version 3", bool(wait(lambda: rows.count() == 3, 15)), str(rows.all_inner_texts()))
        third = detail(page, scan["id"])
        check("version 3 has version 1's bytes and facts (8 × 6), no re-inspection", third.get("version") == 3 and third.get("sha256") == hashlib.sha256(v1).hexdigest() and (third.get("facts") or {}).get("width") == 8, str({k: third.get(k) for k in ("version", "status", "facts")}))
        check("and its thumbnail", bool(wait(lambda: img.count() and unsigned(img.get_attribute("src")) == unsigned(src_v1), 15)), f"{src_v1} vs {img.get_attribute('src') if img.count() else None}")

        # ---- ZIP of a folder with one held file ----------------------------------------------
        page.wait_for_timeout(2500)  # past the toast collapse window
        row(page, "MRI").click()
        with page.expect_download() as dl:
            page.get_by_test_id("selection-download").click()
        z = zipfile.ZipFile(io.BytesIO(Path(dl.value.path()).read_bytes()))
        listed = sorted(z.namelist())
        check("the ZIP has the other files plus _held_files.txt", listed == ["MRI/a.png", "MRI/b.png", "_held_files.txt"], str(listed))
        note = z.read("_held_files.txt").decode() if "_held_files.txt" in listed else ""
        check("the note names the held file and why", "MRI/Smith_John.png" in note and "privacy" in note, note[:200])
        toast = wait(lambda: next((t for t in toasts(page) if t.startswith("Downloaded MRI.zip")), None), 10)
        check("the toast says one file was left out", bool(toast) and "held for privacy review" in toast and "_held_files.txt" in toast, str(toasts(page)))

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return 0 if summary() == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
