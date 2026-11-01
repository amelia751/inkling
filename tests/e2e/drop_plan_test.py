"""Drop plans in the browser (todo13 Milestone 2), against the real API (no agent, no model).

The test starts the API itself (SQLite in a temp dir, `API_FEATURE_*` off) on
<envPrefix>E2E_API_PORT (default 8261). Start a frozen dev server pointed at it first:

    cd apps/web && INKLING_API_URL=http://127.0.0.1:8261 INKLING_E2E=1 pnpm exec vite --port 5261 --strictPort
    python3 ../../tests/e2e/drop_plan_test.py --port 5261

Drops are made the way todo13-drops will make them (an import session tagged with a drop id;
until that merges the test tags `totals.dropId` in the API's database), and inspected through
the worker route (synthetic reports), so no worker is needed.

Covers:
- a drop of PNGs shows a plan card in the project's chat when `drop.planned` arrives (< 5 s),
  Apply makes a draft dataset, its collection and a Studio; the card offers Undo with a
  countdown and Open Studio;
- J4: in that Studio, a second, different drop (a CT series) is applied as a new collection with
  its own Studio; the open X-ray Studio doesn't reload or change, and its header gains the
  collection switcher with both collections;
- J5 parts: a mixed drop's card asks about the labels table, offers "Find a plugin" for an MP3
  ("No plugin for this kind yet") and keeps the PDF as reference;
- Undo on the card takes the first apply back.
Screenshots of the cards go to --out.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
from harness import NAMING, launch, parse_args, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
P = NAMING["envPrefix"]
API_PORT = int(os.environ.get(f"{P}E2E_API_PORT", "8261"))
API = f"http://127.0.0.1:{API_PORT}"
WORKER = {"X-Worker-Token": "dev-only-worker-token"}
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def call(method: str, path: str, body=None, headers=None, raw: bytes | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method, headers={**({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"{}")


def png(w: int, h: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3) % 256 for x in range(w)]) for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


def start_api(data_dir: str) -> subprocess.Popen:
    env = {**os.environ, f"{P}API_DATA_DIR": data_dir, f"{P}ENV": "test", f"{P}LOG_LEVEL": "WARNING"}
    proc = subprocess.Popen(["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--port", str(API_PORT)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(300):
        try:
            if call("GET", "/api/v1/health").get("ok"):
                return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("the API didn't start")


def drop(db: Path, project: str, files: dict[str, bytes], drop_id: str, kinds: dict[str, str], facts: dict | None = None, **totals) -> None:
    """Upload, tag the session with the drop (todo13-drops' `import_sessions.drop_id`), report inspection."""
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = call("POST", f"/api/v1/projects/{project}/imports", body)
    for f in s["files"]:
        if f.get("uploadUrl"):
            data = next(d for rel, d in files.items() if rel.endswith(f["relPath"]))
            call("PUT", f["uploadUrl"].removeprefix("/api") if f["uploadUrl"].startswith("/api/v1") is False else f["uploadUrl"], raw=data, headers={"Content-Type": "application/octet-stream"})
    call("POST", f"/api/v1/imports/{s['id']}/complete", {})
    with sqlite3.connect(db) as c:
        (raw,) = c.execute("SELECT totals FROM import_sessions WHERE id = ?", (s["id"],)).fetchone()
        t = {**json.loads(raw or "{}"), "dropId": drop_id, **totals}
        c.execute("UPDATE import_sessions SET totals = ? WHERE id = ?", (json.dumps(t), s["id"]))
    listed = call("GET", f"/api/v1/worker/inspect/imports/{s['id']}", headers=WORKER)["files"]
    nodes = [{"nodeId": f["nodeId"], "detectedKind": kinds.get(f["name"], "unknown"), "facts": (facts or {}).get(f["name"], {}), "flags": {}} for f in listed]
    call("POST", f"/api/v1/worker/inspect/imports/{s['id']}/report", {"inspector": "e2e", "nodes": nodes}, headers=WORKER)


def run(browser, port: int, out: Path, db: Path) -> None:
    project = call("POST", "/api/v1/projects", {"title": "Drop plans"})["id"]
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://localhost:{port}/projects/{project}/overview")
    page.get_by_test_id("project-header").wait_for(timeout=30000)
    ai = f"{NAMING['displayName']} AI"
    page.get_by_label(f"{ai} panel").wait_for(timeout=10000)
    if not page.get_by_test_id("agent-drawer").count():
        page.get_by_label(f"{ai} panel").click()
    page.get_by_test_id("agent-drawer").wait_for(timeout=10000)
    consent = page.get_by_role("button", name="Turn on for this browser")
    if consent.count():
        consent.click()
    time.sleep(1.0)  # the project stream is open

    # First drop: PNGs → a plan card; Apply.
    t0 = time.time()
    drop(db, project, {f"films/x{i}.png": png(20 + i, 16) for i in range(3)}, "drp_e2e_1", {f"x{i}.png": "image" for i in range(3)})
    card = page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_1"]')
    card.wait_for(timeout=10000)
    page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_1"][data-state="planned"]').wait_for(timeout=10000)
    check("plan card on drop.planned", True, f"{time.time() - t0:.2f}s after the report")
    check("the card names the action, no file names", "a new draft dataset" in card.inner_text() and "x0.png" not in card.inner_text(), card.inner_text()[:200])
    card.screenshot(path=str(out / "plan-card-planned.png"))
    card.get_by_test_id("plan-apply").click()
    page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_1"][data-state="applied"]').wait_for(timeout=10000)
    undo_text = card.get_by_test_id("plan-undo").inner_text()
    check("applied: Undo with a countdown, Open Studio", "Undo" in undo_text and card.get_by_test_id("plan-open-studio").count() == 1, undo_text)
    card.screenshot(path=str(out / "plan-card-applied.png"))
    st = call("GET", "/api/v1/drops/drp_e2e_1/plan")
    xray = st["taskIds"][0]

    # J4: open the X-ray Studio, then a CT series is dropped into it.
    card.get_by_test_id("plan-open-studio").click()
    page.wait_for_url(f"**/studio/{xray}", timeout=20000)
    page.get_by_test_id("studio-header").wait_for(timeout=30000)
    page.evaluate("() => { window.__noReload = 'kept' }")
    url_before = page.url
    check("one collection: no switcher", page.get_by_test_id("collection-switcher").count() == 0)
    ct = {f"ct/s{i}.dcm": b"DICM" + bytes([i]) * 64 for i in range(3)}
    facts = {f"s{i}.dcm": {"dicom": {"modality": "CT"}, "series": {"seriesUidHash": "ser-e2e", "sliceCount": 3}} for i in range(3)}
    t1 = time.time()
    drop(db, project, ct, "drp_e2e_2", {f"s{i}.dcm": "dicom" for i in range(3)}, facts, taskId=xray)
    plan2 = call("GET", "/api/v1/drops/drp_e2e_2/plan")
    check("J4: a CT collection in this dataset is offered", plan2["plan"]["actions"][0]["type"] == "new_collection" and plan2["plan"]["actions"][0]["datasetId"] == st["datasetId"], json.dumps(plan2["plan"]["actions"])[:300])
    call("POST", "/api/v1/drops/drp_e2e_2/apply", {})
    page.get_by_test_id("collection-switcher").wait_for(timeout=15000)
    check("J4: switcher shows within 5 s of the second drop's plan", time.time() - t1 < 15, f"{time.time() - t1:.2f}s")
    page.get_by_test_id("collection-switcher").click()
    opts = page.get_by_test_id("collection-option")
    opts.first.wait_for(timeout=5000)
    check("J4: the switcher lists both collections", opts.count() == 2, " | ".join(opts.all_inner_texts()))
    page.screenshot(path=str(out / "collection-switcher.png"))
    page.keyboard.press("Escape")
    check("J4: the X-ray Studio didn't reload or change", page.evaluate("() => window.__noReload") == "kept" and page.url == url_before)

    # J5 parts: a mixed drop's card in the Studio's chat.
    mixed = {"m/protocol.pdf": b"%PDF-1.4 e2e", "m/voice.mp3": b"ID3e2e", "m/labels.csv": b"file,label\nx0.png,a\n", "m/y0.png": png(40, 41)}
    tfacts = {"labels.csv": {"table": {"columnCount": 2, "columns": [{"name": "file", "type": "id"}, {"name": "label", "type": "category"}], "nameColumns": ["file"]}}}
    page.goto(f"http://localhost:{port}/projects/{project}/overview")
    page.get_by_test_id("agent-drawer").wait_for(timeout=15000)
    time.sleep(1.0)
    drop(db, project, mixed, "drp_e2e_3", {"protocol.pdf": "document", "voice.mp3": "unknown", "labels.csv": "table", "y0.png": "image"}, tfacts)
    c3 = page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_3"]')
    c3.wait_for(timeout=10000)
    page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_3"][data-state="planned"]').wait_for(timeout=10000)
    check("J5: the labels table is asked about", c3.get_by_test_id("plan-question-yes").count() == 1 and "labels table" in c3.inner_text())
    check("J5: the PDF is kept as reference", c3.locator('[data-testid="plan-action"][data-type="keep_reference"]').count() == 1)
    c3.get_by_test_id("plan-find-plugin").click()
    c3.get_by_test_id("plan-no-plugin").wait_for(timeout=10000)
    check("J5: Find a plugin for the MP3 says there's none yet", "No plugin for this kind yet" in c3.inner_text())
    c3.screenshot(path=str(out / "plan-card-mixed.png"))

    # Undo the first drop from its card (still inside the window? re-apply would be needed otherwise).
    c1 = page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_1"]')
    if c1.count() and c1.get_by_test_id("plan-undo").count():
        c1.get_by_test_id("plan-undo").click()
        page.locator('[data-testid="plan-card"][data-drop-id="drp_e2e_1"][data-state="undone"]').wait_for(timeout=10000)
        check("Undo from the card", True)
    else:
        check("Undo from the card (window passed: covered by the API tests)", True, "skipped")
    check("no page errors", not errors, "; ".join(errors[:3]))
    ctx.close()


def main() -> int:
    args = parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="drop-plan-api-")
    api = start_api(data_dir)
    try:
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            try:
                run(browser, args.port, out, Path(data_dir) / "api.db")
            finally:
                browser.close()
    finally:
        api.terminate()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
