"""todo6 Phase 4 exit: adding data through Sources against the kernel (and, when one runs, the
inspection worker of Phase 5).

A nested folder of synthetic PNGs, a CSV, a PDF, an unknown binary and a `.DS_Store` goes in
through the Folder… picker (the same walk as a drop). The tree mirrors the folders, the junk
is skipped, a re-drop skips everything as already present, and a page closed mid-upload
completes when the same folder is dropped again. "Can't read this file yet" needs the worker's
inspection; without a worker that check is reported as SKIP.

    <envPrefix>API_URL=http://127.0.0.1:8000 <envPrefix>E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/sources_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))

from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def skip(name: str, why: str) -> None:
    print(f"SKIP {name} — {why}", flush=True)


def wait(fn, timeout=60.0, every=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001
            pass
        time.sleep(every)
    return last


def png(w: int, h: int, seed: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3 + seed) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


def fixture(root: Path) -> Path:
    study = root / "hospital_research"
    for i in range(1, 4):
        (study / "xray" / "patient_001").mkdir(parents=True, exist_ok=True)
        (study / "xray" / "patient_001" / f"img{i}.png").write_bytes(png(16, 12, i))
    (study / "xray" / "patient_002").mkdir(parents=True)
    (study / "xray" / "patient_002" / "img1.png").write_bytes(png(16, 12, 9))
    (study / "diagnoses.csv").write_text("patient,label\nP001,normal\nP002,pneumonia\n")
    (study / "reports").mkdir()
    (study / "reports" / "report_001.pdf").write_bytes(PDF)
    (study / "mystery.xyz").write_bytes(os.urandom(512))
    (study / ".DS_Store").write_bytes(b"\x00\x00\x00\x01Bud1")
    return study


def drop_folder(page, folder: Path) -> None:
    """The Folder… picker (`webkitdirectory`): the same relative paths as a dropped folder."""
    page.locator("[data-testid=pick-folder]").first.set_input_files(str(folder))


def attest(page) -> None:
    dlg = page.locator("[data-testid=attestation]")
    if wait(lambda: dlg.is_visible(), 5, 0.2):
        dlg.get_by_role("checkbox").click()
        page.get_by_test_id("attest-confirm").click()


def api(page, path: str, method: str = "GET", body: dict | None = None):
    return page.evaluate(
        "async ([path, method, body]) => { const r = await fetch('/api/v1' + path, { method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }",
        [path, method, body],
    )


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    tmp = Path(tempfile.mkdtemp(prefix="sources-e2e-"))
    study = fixture(tmp)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/")
        if api(page, "/projects")["status"] != 200 or not page.evaluate("async () => (await fetch('/api/v1/health')).ok"):
            print("SKIP kernel not reachable through the dev server proxy")
            return 0
        project = api(page, "/projects", "POST", {"title": "Sources e2e"})["json"]
        pid = project["id"]

        # ---- Add a folder: attestation once, the tray, the tree mirrors the folders -----------
        page.goto(f"{base}/projects/{pid}/sources")
        page.wait_for_selector("[data-testid=drop-zone]", timeout=15000)
        check("an empty project offers the drop zone", True)
        drop_folder(page, study)
        attest(page)
        tray = page.locator("[data-testid=tray-session]").first
        phase = wait(lambda: tray.get_attribute("data-phase") in ("checking", "done") and tray.get_attribute("data-phase"), 60)
        check("upload finishes (checking or done)", bool(phase), str(phase))
        check("system files are skipped and counted", "1 system file skipped" in tray.inner_text(), tray.inner_text())
        sessions = api(page, f"/projects/{pid}/imports")["json"]["imports"]
        check("one import session", len(sessions) == 1 and sessions[0]["totals"]["files"] == 7, str(sessions[0]["totals"] if sessions else None))
        page.wait_for_selector("[data-testid=listing-row]", timeout=15000)
        root_rows = wait(lambda: (lambda t: t if len(t) >= 4 else None)(page.locator("[data-testid=listing-row] [data-testid=row-name]").all_inner_texts()), 15)
        check("tree root lists the dropped folder's contents", root_rows == ["reports", "xray", "diagnoses.csv", "mystery.xyz"] or root_rows is not None and set(root_rows) >= {"reports", "xray", "diagnoses.csv", "mystery.xyz"}, str(root_rows))
        check("no .DS_Store in the tree", ".DS_Store" not in (root_rows or []))
        page.locator("[role=treeitem]").filter(has_text="xray").first.click()
        page.wait_for_function("[...document.querySelectorAll('[data-testid=row-name]')].some(e => e.textContent === 'patient_001')", timeout=10000)
        check("nested folders mirror the drop", set(page.locator("[data-testid=listing-row] [data-testid=row-name]").all_inner_texts()) == {"patient_001", "patient_002"})
        page.locator("[data-testid=listing-row]").filter(has_text="patient_001").dblclick()
        page.wait_for_function("document.querySelectorAll('[data-testid=listing-row], [data-testid=listing-tile]').length >= 1", timeout=10000)
        # Three numbered files collapse into one run.
        rows = page.locator("[data-testid=listing-row], [data-testid=listing-tile]")
        check("numbered PNGs collapse into a run", rows.count() == 1 and "img1.png–img3.png" in rows.first.inner_text(), rows.first.inner_text())
        check("folder names stay out of the URL", "patient" not in page.url and "xray" not in page.url, page.url)

        # ---- Inspection (Phase 5 worker) -----------------------------------------------------
        unknown = wait(lambda: (lambda items: items[0] if items and items[0]["status"] != "checking" else None)(api(page, f"/projects/{pid}/search?q=mystery")["json"]["items"]), 45, 1)
        if unknown:
            page.goto(f"{base}/projects/{pid}/sources/{unknown['id']}")
            page.wait_for_selector("[data-testid=inspector-kind]", timeout=15000)
            check("the unknown file says we can't read it yet", "can't read this file yet" in page.locator("[data-testid=inspector]").inner_text().lower(), unknown["status"])
        else:
            skip("the unknown file says we can't read it yet", "no inspection worker reported within 45s (Phase 5); files stay 'Checking…'")
            item = api(page, f"/projects/{pid}/search?q=mystery")["json"]["items"]
            check("until inspected, files are 'Checking…'", bool(item) and item[0]["status"] == "checking", str(item[:1]))

        # ---- Re-drop: everything is already here ----------------------------------------------
        page.goto(f"{base}/projects/{pid}/sources")
        page.wait_for_selector("[data-testid=listing-row]", timeout=15000)
        drop_folder(page, study)
        attest(page)
        tray = page.locator("[data-testid=tray-session]").first
        wait(lambda: tray.get_attribute("data-phase") in ("done", "checking", "failed"), 60)
        check("a re-drop skips everything as already present", "7 already in this project" in tray.inner_text(), tray.inner_text())
        check("a re-drop asks for no new attestation", page.locator("[data-testid=attestation]").count() == 0)
        check("a re-drop adds no source", len(api(page, f"/projects/{pid}/sources")["json"]["sources"]) == 1)

        # ---- Close the page mid-upload, drop again: the session resumes ------------------------
        big_dir = tmp / "big_batch"
        big_dir.mkdir()
        (big_dir / "large.bin").write_bytes(os.urandom(100 * 1024 * 1024))  # two chunks: 64 MB + 36 MB
        (big_dir / "small.png").write_bytes(png(10, 10, 42))
        cut = ctx.new_page()
        cut.goto(f"{base}/projects/{pid}/sources")
        cut.wait_for_selector("[data-testid=listing-row]", timeout=15000)
        # A slow uplink (16 MB/s), so the page can close between the two chunks.
        cdp = ctx.new_cdp_session(cut)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": 16 * 1024 * 1024})
        drop_folder(cut, big_dir)
        attest(cut)
        got = wait(lambda: next((s for s in api(page, f"/projects/{pid}/imports")["json"]["imports"] if s["state"] == "uploading" and s["totals"]["receivedBytes"] >= 64 * 1024 * 1024), None), 90, 0.2)
        cut.close()
        check("the page closed mid-upload, after the first chunk", bool(got) and got["totals"]["receivedBytes"] < got["totals"]["bytes"], str(got and got["totals"]))
        page.goto(f"{base}/projects/{pid}/sources")
        page.wait_for_selector("[data-testid=listing-row]", timeout=15000)
        drop_folder(page, big_dir)
        attest(page)
        done = wait(lambda: next((s for s in api(page, f"/projects/{pid}/imports")["json"]["imports"] if got and s["id"] == got["id"] and s["state"] != "uploading"), None), 120, 0.5)
        check("re-dropping resumes the same session and completes it", bool(done) and done["state"] in ("inspecting", "ready", "needs_review"), str(done and done["state"]))
        sessions = api(page, f"/projects/{pid}/imports")["json"]["imports"]
        check("no extra session for the resumed drop", sum(1 for s in sessions if s["totals"]["files"] == 2) == 1, str([s["totals"]["files"] for s in sessions]))
        found = api(page, f"/projects/{pid}/search?q=large.bin")["json"]["items"]
        check("the large file is in the project, verified", len(found) == 1 and found[0]["size"] == 100 * 1024 * 1024, str(found[:1]))

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
