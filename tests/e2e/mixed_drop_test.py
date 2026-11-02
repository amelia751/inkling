"""Acceptance for todo19 (§4): a mixed drop lands in ONE Studio, against the real API (no agent, no model).

The test starts the API itself (SQLite in a temp dir, auto-apply and the fast path off, so the plan
waits for the test) on <envPrefix>E2E_API_PORT (default 8262). With --port it also opens the Studio in
a browser against a frozen dev server pointed at that API:

    cd apps/web && STUDIO_API_URL=http://127.0.0.1:8262 STUDIO_E2E=1 pnpm exec vite --port 5262 --strictPort
    python3 ../../tests/e2e/mixed_drop_test.py --port 5262        # or without --port: API only

The fixture is tiny and synthetic, one file (or file group) per kind, so it runs in CI: a chest
X-ray PNG, a BraTS-style subject (four NIfTI sequences + its `_seg`), a 4D cine with `Info.cfg`,
a WFDB ECG record (`.hea` + `.dat`), an AVI and an SVS slide. Inspection is reported through the
worker route (synthetic facts), so no worker or converter is needed; the bytes are placeholders.

Covers:
- the drop's plan makes exactly one draft dataset and one Studio (no Studio per kind, no
  "Masks" Studio for the subject's seg: P0-4, D5);
- applying it gives one task, which accepts every kind the drop has;
- the task's items carry their kind, and every item name equals its original filename (never a
  storage key: P0-3);
- the subject is one item with its seg as a part, not an item of its own (D6);
- with --port: the Studio opens and every item in the list opens without a page error.
The per-renderer checks of §4 (12 leads, ED/ES, "Converting video", "Preparing slide n %") need
the worker and real files; they belong to the hand test with the sample folder.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMING = json.loads((ROOT / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]
API_PORT = int(os.environ.get(f"{P}E2E_API_PORT", "8262"))
API = f"http://127.0.0.1:{API_PORT}"
WORKER = {"X-Worker-Token": "dev-only-worker-token"}
STORAGE_KEY = re.compile(r"sources/|[0-9a-f]{64}|^[0-9a-f]{32,}\.")
results: list[tuple[str, bool, str]] = []

BRATS = "BraTS20_Training_001"
CINE = "patient101"

# relPath → (detected kind, facts). One file or file group per kind.
FIXTURE: dict[str, tuple[str, dict]] = {
    "drop/xray/cxr_0001.png": ("image", {"width": 24, "height": 16}),
    **{f"drop/brats/{BRATS}_{seq}.nii.gz": ("volume", {"sequence": seq}) for seq in ("t1", "t1ce", "t2", "flair")},
    f"drop/brats/{BRATS}_seg.nii.gz": ("mask", {"sequence": "seg"}),
    # The worker reports a 4D NIfTI as a volume with frames > 1; the plan makes it volume-time.
    f"drop/cine/{CINE}_4d.nii.gz": ("volume", {"slices": 10, "frames": 30}),
    "drop/cine/Info.cfg": ("document", {}),
    "drop/ecg/00001_hr.hea": ("waveform", {"wfdb": {"record": "00001_hr", "leads": 12}}),
    "drop/ecg/00001_hr.dat": ("waveform", {"wfdb": {"record": "00001_hr"}}),
    "drop/video/colitis-0001.avi": ("video", {}),
    "drop/slide/TCGA-A6-5665-01Z.svs": ("slide", {}),
}
# The task document lists one asset per viewable file, each by its original filename (grouping
# into items, e.g. the BraTS subject, happens in the Studio, checked in the browser below).
EXPECTED_ASSETS = {"cxr_0001.png", *(f"{BRATS}_{s}.nii.gz" for s in ("t1", "t1ce", "t2", "flair")), f"{CINE}_4d.nii.gz", "00001_hr.hea", "colitis-0001.avi", "TCGA-A6-5665-01Z.svs"}
# What the Studio's item list should show: one name per item, the original filename.
EXPECTED_ITEMS = {"cxr_0001.png", f"{BRATS}_t1.nii.gz", f"{CINE}_4d.nii.gz", "00001_hr.hea", "colitis-0001.avi", "TCGA-A6-5665-01Z.svs"}


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def call(method: str, path: str, body=None, headers=None, raw: bytes | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method, headers={**({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"{}")


def start_api(data_dir: str) -> subprocess.Popen:
    env = {**os.environ, f"{P}API_DATA_DIR": data_dir, f"{P}ENV": "test", f"{P}LOG_LEVEL": "WARNING", f"{P}API_FEATURE_AUTO_APPLY": "false", f"{P}API_FEATURE_FAST_PATH": "false"}
    proc = subprocess.Popen(["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--port", str(API_PORT)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(300):
        try:
            if call("GET", "/api/v1/health").get("ok"):
                return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("the API didn't start")


def placeholder(rel: str) -> bytes:
    """Distinct bytes per file (so no two dedupe); the inspection report says what each one is."""
    return b"e2e-mixed-drop\0" + rel.encode()


def drop(db: Path, project: str, drop_id: str) -> None:
    """Upload the fixture as one import session tagged with the drop, then report inspection (as drop_plan_test does)."""
    files = {rel: placeholder(rel) for rel in FIXTURE}
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = call("POST", f"/api/v1/projects/{project}/imports", body)
    for f in s["files"]:
        if f.get("uploadUrl"):
            data = next(d for rel, d in files.items() if rel.endswith(f["relPath"]))
            call("PUT", f["uploadUrl"], raw=data, headers={"Content-Type": "application/octet-stream"})
    call("POST", f"/api/v1/imports/{s['id']}/complete", {})
    with sqlite3.connect(db) as c:
        (raw,) = c.execute("SELECT totals FROM import_sessions WHERE id = ?", (s["id"],)).fetchone()
        c.execute("UPDATE import_sessions SET totals = ? WHERE id = ?", (json.dumps({**json.loads(raw or "{}"), "dropId": drop_id}), s["id"]))
    by_name = {rel.rsplit("/", 1)[-1]: spec for rel, spec in FIXTURE.items()}
    listed = call("GET", f"/api/v1/worker/inspect/imports/{s['id']}", headers=WORKER)["files"]
    nodes = [{"nodeId": f["nodeId"], "detectedKind": by_name.get(f["name"], ("unknown", {}))[0], "facts": by_name.get(f["name"], ("", {}))[1], "flags": {}} for f in listed]
    call("POST", f"/api/v1/worker/inspect/imports/{s['id']}/report", {"inspector": "e2e", "nodes": nodes}, headers=WORKER)


def wait_plan(drop_id: str, timeout: float = 15.0) -> dict:
    t0 = time.time()
    while True:
        try:
            st = call("GET", f"/api/v1/drops/{drop_id}/plan")
            if st.get("plan"):
                return st
        except urllib.error.HTTPError:
            pass
        if time.time() - t0 > timeout:
            raise RuntimeError(f"no plan for {drop_id} after {timeout}s")
        time.sleep(0.2)


def run_api(db: Path) -> dict:
    project = call("POST", "/api/v1/projects", {"title": "Mixed drop"})["id"]
    drop(db, project, "drp_mixed_1")
    st = wait_plan("drp_mixed_1")
    actions = st["plan"]["actions"]
    types = [a["type"] for a in actions]
    check("the plan has one new dataset", types.count("new_dataset") == 1, json.dumps(types))
    check("the plan makes no collection or Studio per kind", types.count("new_collection") == 0, json.dumps([(a["type"], a.get("kind")) for a in actions])[:300])
    check("no Masks Studio: the seg is part of its subject", not any(a.get("kind") == "mask" for a in actions), json.dumps(actions)[:300])

    applied = call("POST", "/api/v1/drops/drp_mixed_1/apply", {})
    st = call("GET", "/api/v1/drops/drp_mixed_1/plan")
    task_ids = st.get("taskIds") or applied.get("taskIds") or []
    check("one Studio", len(task_ids) == 1, json.dumps(task_ids))
    datasets = call("GET", f"/api/v1/projects/{project}/datasets")
    datasets = datasets.get("datasets", datasets) if isinstance(datasets, dict) else datasets
    drafts = [d for d in datasets if d.get("state", d.get("status", "draft")) == "draft"]
    check("one draft dataset", len(drafts) == 1, json.dumps([(d.get("id"), d.get("state", d.get("status"))) for d in datasets]))
    if len(task_ids) != 1:
        return {"project": project, "task": None}

    task = task_ids[0]
    doc = call("GET", f"/api/v1/tasks/{task}/document")
    accepts = doc.get("accepts") or []
    check("the Studio accepts every kind in the drop (≥ 6)", len(set(accepts)) >= 6, json.dumps(accepts))

    assets = doc.get("assets") or []
    names = [a.get("name") or "" for a in assets]
    check("item names equal the original filenames", set(names) == EXPECTED_ASSETS, json.dumps(sorted(set(names) ^ EXPECTED_ASSETS)))
    check("no item is named by a storage key", not any(STORAGE_KEY.search(n) for n in names), json.dumps([n for n in names if STORAGE_KEY.search(n)]))
    check("every item carries its kind", all(a.get("kind") for a in assets), json.dumps([(a.get("name"), a.get("kind")) for a in assets])[:400])
    check("items of six kinds in one task", len({a.get("kind") for a in assets}) >= 6, json.dumps(sorted({str(a.get("kind")) for a in assets})))
    # todo20 D9: the seg is the subject's `reference` slot, a part of its item, not an item.
    owner = next((a for a in assets if any((p.get("name") or "") == f"{BRATS}_seg.nii.gz" for p in a.get("parts") or [])), None)
    seg = next((p for p in (owner or {}).get("parts") or [] if (p.get("name") or "") == f"{BRATS}_seg.nii.gz"), None)
    check("the BraTS seg is not an item of its own", not any(a.get("kind") == "mask" for a in assets), json.dumps([a.get("name") for a in assets if a.get("kind") == "mask"]))
    check("the BraTS seg is the reference part of its subject's item", owner is not None and owner.get("subject") == BRATS and owner.get("kind") == "volume" and bool(owner.get("profile")) and seg is not None and seg.get("slot") == "reference" and seg.get("kind") == "mask", json.dumps(owner)[:400])
    return {"project": project, "task": task}


def run_browser(port: int, out: Path, project: str, task: str, browser_name: str, headed: bool) -> None:
    sys.path.insert(0, str(ROOT / "apps" / "web" / "e2e"))
    from harness import launch, sync_playwright  # noqa: PLC0415

    with sync_playwright() as pw:
        browser = launch(pw, browser_name, headed)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://localhost:{port}/projects/{project}/studio/{task}")
            page.get_by_test_id("studio-header").wait_for(timeout=30000)
            text = page.inner_text("body")
            check("the Studio lists every item by its filename", all(n in text for n in EXPECTED_ITEMS), ", ".join(n for n in EXPECTED_ITEMS if n not in text))
            for name in sorted(EXPECTED_ITEMS):
                page.get_by_text(name, exact=True).first.click()
                time.sleep(0.5)
                page.screenshot(path=str(out / f"mixed-drop-{name}.png"))
            check("walking every item: no page errors", not errors, "; ".join(errors[:3]))
        finally:
            browser.close()


def parse_args():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, help="a frozen dev server pointed at the test's API; omit for the API-only checks")
    ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "apps" / "web" / "e2e" / ".artifacts"))
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    data_dir = tempfile.mkdtemp(prefix="mixed-drop-api-")
    api = start_api(data_dir)
    try:
        ids = run_api(Path(data_dir) / "api.db")
        if args.port and ids["task"]:
            run_browser(args.port, out, ids["project"], ids["task"], args.browser, args.headed)
    finally:
        api.terminate()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
