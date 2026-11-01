"""The implicit ingest pipeline end to end (todo12 Milestone 1; docs/pipeline.md §20 test 1):
ten files of mixed formats, two of them corrupt, uploaded through the normal import flow.
Originals are retained; every item ends classified or errored; the run's per-file report is
complete; the good files become a candidate version on `pipeline/<run_id>` waiting for review;
the Studio shows the run, its steps and its report.

Spans api, worker, pipeline and versioning, so it passes only once todo12-pipeline,
todo12-kernel and todo12-web are merged. Without them it SKIPs (exit 0) and says what's
missing: no API behind the dev server, or an API without the pipeline routes.

Run it on the full local stack (docs/running.md; ports are examples, synthetic data only):

    # 1. the stack: api + worker + versioning + pipeline, e.g. the compose file's services, or
    <envPrefix>API_DATA_DIR=/tmp/pipe uv run --package studio-api uvicorn studio_api.app:app --port 8221
    uv run --package studio-worker studio-worker --kernel http://127.0.0.1:8221
    #    plus apps/versioning and apps/pipeline as docs/running.md describes, with the api's
    #    <envPrefix>API_PIPELINE_URL pointing at the pipeline service
    # 2. the web dev server proxying /api to it
    cd apps/web && <envPrefix>API_URL=http://127.0.0.1:8221 <envPrefix>E2E=1 pnpm exec vite --port 5221 --strictPort
    # 3. the test (from apps/web)
    uv run --package studio-web-e2e python ../../tests/e2e/pipeline_ingest_test.py --port 5221

`--timeout` (seconds, default 180) bounds the wait for the run to reach review.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import sys
import time
import zipfile
import zlib
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

results: list[tuple[str, bool, str]] = []

DONE_ITEM = {"proposed", "quarantined", "rejected"}
BAD = {"quarantined", "rejected"}


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=60.0, every=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001 — keep polling
            pass
        time.sleep(every)
    return last


# ---- Ten synthetic files ------------------------------------------------------------------------


def png(w: int, h: int, seed: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * seed + y * 7) % 256 for x in range(w)]) for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


def dicom() -> bytes:
    """A 16×16 synthetic CT slice (pydicom, in the e2e environment); invented UIDs, no patient."""
    import numpy as np
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset("scan.dcm", {}, file_meta=meta, preamble=b"\x00" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
    ds.Modality, ds.PatientID, ds.PatientName = "CT", "SYNTH-0001", "Synthetic^Phantom"
    ds.Rows = ds.Columns = 16
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    ds.PixelData = (np.arange(256, dtype=np.uint16).reshape(16, 16)).tobytes()
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def fixture() -> tuple[dict[str, bytes], set[str]]:
    """Ten mixed files; returns them and the paths expected to fail (corrupt)."""
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w") as z:
        z.writestr("inner/readme.txt", "Synthetic archive member.\n")
    files = {
        "intake/films/film_01.png": png(32, 24, 3),
        "intake/films/film_02.png": png(32, 24, 5),
        "intake/films/film_03.png": png(32, 24, 7),
        "intake/films/film_broken.png": png(32, 24, 9)[:40],  # corrupt: truncated mid-IHDR
        "intake/scans/scan_001.dcm": dicom(),
        "intake/scans/scan_broken.dcm": b"\x00" * 64 + b"not a dicom file",  # corrupt: no preamble
        "intake/labels.csv": b"image,finding\nfilm_01.png,normal\nfilm_02.png,pneumonia\nfilm_03.png,normal\n",
        "intake/protocol.pdf": b"%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n",
        "intake/notes.txt": b"Synthetic notes for the pipeline ingest test.\n",
        "intake/bundle.zip": zbuf.getvalue(),
    }
    return files, {"films/film_broken.png", "scans/scan_broken.dcm"}


# ---- The API through the dev server's proxy -------------------------------------------------------


class Api:
    def __init__(self, port: int):
        self.base = f"http://localhost:{port}/api"

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, headers: dict | None = None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"Content-Type": "application/octet-stream" if raw is not None else "application/json", **(headers or {})}
        req = urlrequest.Request(self.base + path, data=data, method=method, headers=h)
        with urlrequest.urlopen(req, timeout=60) as r:
            text = r.read()
            return json.loads(text) if text else None

    def get(self, path: str):
        return self.call("GET", path)

    def status(self, path: str) -> int:
        try:
            self.get(path)
            return 200
        except urlerror.HTTPError as e:
            return e.code


def rel(p: str) -> str:
    return p.removeprefix("intake/")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e" / ".artifacts"))
    args = ap.parse_args()
    api = Api(args.port)

    # ---- Skip cleanly when the stack isn't there ------------------------------------------------
    try:
        api.get("/v1/health")
    except Exception as e:  # noqa: BLE001
        print(f"SKIP the API isn't reachable through the dev server on :{args.port} ({e}); see the docstring")
        return 0
    try:
        p = api.call("POST", "/v1/projects", {"title": f"Pipeline ingest {int(time.time())}"})
    except Exception as e:  # noqa: BLE001
        print(f"SKIP the dev server answers but can't create a project (seed mode, no API?): {e}")
        return 0
    pid = p["id"]
    code = api.status(f"/v1/projects/{pid}/pipeline-runs")
    if code != 200:
        print(f"SKIP the API has no pipeline routes yet (GET /v1/projects/:id/pipeline-runs → {code}); needs todo12-kernel + todo12-pipeline merged")
        return 0

    # ---- 1. Upload ten mixed files through the import flow --------------------------------------
    files, corrupt = fixture()
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": path, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (path, d) in enumerate(files.items())]}
    s = api.call("POST", f"/v1/projects/{pid}/imports", body)
    for f in s["files"]:
        if f.get("uploadUrl"):
            data = next(d for path, d in files.items() if path.endswith("/" + f["relPath"]) or path == f["relPath"])
            for attempt in range(4):
                try:
                    api.call("PUT", f["uploadUrl"].removeprefix("/api"), raw=data)
                    break
                except Exception:  # noqa: BLE001
                    if attempt == 3:
                        raise
                    time.sleep(2**attempt)
    api.call("POST", f"/v1/imports/{s['id']}/complete")
    t0 = time.time()

    # ---- 2. The upload starts one ingest run ------------------------------------------------------
    def the_run():
        runs = api.get(f"/v1/projects/{pid}/pipeline-runs")["runs"]
        mine = [r for r in runs if (r.get("trigger") or {}).get("import_id") == s["id"]]
        return mine[0] if mine else (runs[0] if len(runs) == 1 else None)

    run = wait(the_run, 60)
    check("the upload starts an ingest run", bool(run), json.dumps(run)[:200] if run else "no run listed")
    if not run:
        return report()
    rid = run["run_id"]
    check("exactly one run for the upload (idempotent start)", len([r for r in api.get(f"/v1/projects/{pid}/pipeline-runs")["runs"] if (r.get("trigger") or {}).get("import_id") == s["id"]]) == 1)

    settled = wait(lambda: (lambda d: d if d["state"] not in ("queued", "running") else None)(api.get(f"/v1/pipeline-runs/{rid}")), args.timeout, 1.0)
    took = time.time() - t0
    d = settled or api.get(f"/v1/pipeline-runs/{rid}")
    check("the run reaches review (partial success: corrupt files don't fail the run)", d["state"] == "awaiting_review", f"{d['state']} after {took:.0f}s")
    print(f"INFO upload → candidate: {took:.1f}s for {len(files)} files (todo12 §7, tracked)")

    # ---- 3. The report is complete; every item classified or errored -----------------------------
    items = {i["rel_path"]: i for i in d.get("items", [])}
    want = {rel(p) for p in files}
    got = {k.removeprefix("intake/") for k in items}
    check("the per-file report lists all ten files", got == want and not d.get("items_truncated"), f"missing {sorted(want - got)}, extra {sorted(got - want)}")
    check("every item ends proposed, quarantined or rejected", all(i["state"] in DONE_ITEM for i in items.values()), str({k: v["state"] for k, v in items.items() if v["state"] not in DONE_ITEM}))
    by_rel = {k.removeprefix("intake/"): v for k, v in items.items()}
    check("the corrupt files are quarantined or rejected, with a reason", all(by_rel.get(c, {}).get("state") in BAD and (by_rel[c].get("reason") or by_rel[c].get("diagnostics")) for c in corrupt), str({c: by_rel.get(c, {}).get("state") for c in corrupt}))
    good = want - corrupt
    check("the good images and the DICOM are proposed", all(by_rel.get(g, {}).get("state") == "proposed" for g in ("films/film_01.png", "films/film_02.png", "films/film_03.png", "scans/scan_001.dcm")), str({g: by_rel.get(g, {}).get("state") for g in good}))

    # ---- 4. A candidate on pipeline/<run_id>, nothing published --------------------------------------
    c = d.get("candidate") or {}
    check("a candidate commit on pipeline/<run_id>", c.get("branch") == f"pipeline/{rid}" and bool(c.get("commit")) and str(c.get("output_manifest_digest", "")).startswith("sha256:"), json.dumps(c)[:200])
    check("a review is open for it", bool((d.get("review") or {}).get("review_id")), json.dumps(d.get("review"))[:200])

    # ---- 5. Originals retained, byte for byte ---------------------------------------------------------
    sums = {hashlib.sha256(b).hexdigest() for b in files.values()}
    srcs = api.get(f"/v1/projects/{pid}/sources")["sources"]
    seen: set[str] = set()

    def walk(source_id: str, node: str | None = None) -> None:
        q = f"?node={node}" if node else ""
        for it in api.get(f"/v1/sources/{source_id}/children{q}")["items"]:
            if it["kind"] in ("folder", "sequence"):
                walk(source_id, it["id"])
            elif it.get("sha256"):
                seen.add(it["sha256"])

    for src in srcs:
        walk(src["id"])
    check("every original, corrupt ones too, is kept with its checksum", sums <= seen, f"{len(sums - seen)} missing")

    # ---- 6. The Studio shows it ----------------------------------------------------------------------
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = getattr(pw, args.browser).launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        base = f"http://localhost:{args.port}"
        page.goto(f"{base}/projects/{pid}/files/pipelines")
        page.wait_for_selector(f"[data-testid=pipeline-run-row][data-run-id='{rid}']", timeout=30000)
        check("the run is listed under Data", page.locator(f"[data-testid=pipeline-run-row][data-run-id='{rid}'] [data-testid=pipeline-run-status]").get_attribute("data-state") == "awaiting_review")
        page.locator(f"[data-testid=pipeline-run-row][data-run-id='{rid}']").click()
        page.wait_for_selector("[data-testid=pipeline-step-row]", timeout=20000)
        check("its steps are shown", page.locator("[data-testid=pipeline-step-row]").count() == len(d.get("steps", [])) > 0)
        check("its report shows all ten files", page.locator("[data-testid=pipeline-file-report] [data-testid=pipeline-file-row]").count() == 10)
        approve = page.locator("[data-testid=pipeline-approve]")
        if (d.get("review") or {}).get("can_approve"):
            approve.click()
            ok = wait(lambda: api.get(f"/v1/pipeline-runs/{rid}")["state"] == "published", 120, 1.0)
            check("an approval publishes the candidate", bool(ok))
        else:
            check("the uploader can't approve their own run (P§13): no button", approve.count() == 0)
            print("INFO approve → publish needs a second person (a reviewer); covered by apps/web/e2e/pipeline_runs_test.py and the kernel's tests")
        page.screenshot(path=str(out / "pipeline-ingest-run.png"), full_page=True)
        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    return report()


def report() -> int:
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
