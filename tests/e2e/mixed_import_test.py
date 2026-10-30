"""todo6 Phase 5 exit, docs/ux.md §13 "Mixed data import":

1. Import a folder of synthetic PNGs, `labels.csv` and unrelated files.
2. Originals are preserved, and shapes are detected.
3. The CSV↔image relationship is *proposed*, not applied: no annotations before confirming.
4. Confirming it in Explore opens the 2D Studio with the CSV's classes as labels and the
   imported labels shown with the `imported` badge.
5. Reloading the page keeps everything.

Needs the API and a worker (inspection runs in the worker), and the dev server proxying to
that API. From the repo root, for example:

    <envPrefix>API_DATA_DIR=/tmp/mixed uv run --package studio-api uvicorn studio_api.app:app --port 8205
    uv run --package studio-worker studio-worker --kernel http://127.0.0.1:8205
    cd apps/web && <envPrefix>API_URL=http://127.0.0.1:8205 pnpm exec vite --port 5205 --strictPort
    python3 ../../tests/e2e/mixed_import_test.py --port 5205      # from apps/web
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import struct
import sys
import time
import zlib
from pathlib import Path
from urllib import request as urlrequest
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))

from harness import STORE, launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


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
    raw = b"".join(b"\x00" + bytes([(x * seed + y * 7) % 256 for x in range(w)]) for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


LABELS = {f"film_{i:03d}.png": ("pneumonia" if i % 3 == 0 else "normal") for i in range(1, 9)}


def fixture() -> dict[str, bytes]:
    files = {f"chest_study/films/{name}": png(64, 48, i + 3) for i, name in enumerate(LABELS)}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["image", "finding"])
    for name, label in LABELS.items():
        w.writerow([name, label])
    w.writerow(["film_404.png", "normal"])  # a row with no image: "not found", never guessed
    files["chest_study/labels.csv"] = buf.getvalue().encode()
    files["chest_study/protocol.pdf"] = b"%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n"
    files["chest_study/scanner_export.bin"] = bytes((i * 31) % 256 for i in range(2048))
    files["chest_study/readme.txt"] = b"Synthetic chest films for the mixed-import test.\n"
    files["chest_study/.DS_Store"] = b"\x00\x00\x00\x01Bud1"
    return files


class Api:
    """The API through the dev server's proxy, as the same (dev) person the browser is."""

    def __init__(self, port: int):
        self.base = f"http://localhost:{port}/api"

    def call(self, method: str, path: str, body=None, raw: bytes | None = None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urlrequest.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/octet-stream" if raw is not None else "application/json"})
        with urlrequest.urlopen(req, timeout=60) as r:
            text = r.read()
            return json.loads(text) if text else None

    def get(self, path: str):
        return self.call("GET", path)

    def bytes(self, url: str) -> bytes:
        with urlrequest.urlopen(f"{self.base.removesuffix('/api')}{url}", timeout=60) as r:
            return r.read()


def walk(api: Api, source_id: str, node: str | None = None, prefix: str = "") -> dict[str, dict]:
    out: dict[str, dict] = {}
    q = f"?node={quote(node, safe='')}" if node else ""
    for item in api.get(f"/v1/sources/{source_id}/children{q}")["items"]:
        name = item.get("displayPath", item["name"]).replace(" / ", "/")
        path = f"{prefix}{name}"
        if item["kind"] == "folder":
            out |= walk(api, source_id, item["id"], path + "/")
        elif item["kind"] == "sequence":
            out |= walk(api, source_id, item["id"], prefix)
        else:
            out[path] = item
    return out


def main() -> int:
    args = parse_args()
    api = Api(args.port)
    try:
        api.get("/v1/health")
    except Exception as e:  # noqa: BLE001
        print(f"SKIP the API isn't reachable through the dev server proxy ({e})")
        return 0
    files = fixture()

    # 1. Import: a session with the file list and the attestation, the bytes, then complete.
    p = api.call("POST", "/v1/projects", {"title": f"Mixed import {int(time.time())}"})
    pid = p["id"]
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = api.call("POST", f"/v1/projects/{pid}/imports", body)
    check("system junk is skipped at upload", s["totals"].get("skippedSystemFiles") == 1, str(s["totals"]))
    for f in s["files"]:
        if f["uploadUrl"]:
            data = next(d for rel, d in files.items() if rel.endswith("/" + f["relPath"]))
            for attempt in range(4):  # like the upload tray: retry with backoff (dev SQLite can be busy)
                try:
                    api.call("PUT", f["uploadUrl"].removeprefix("/api"), raw=data)
                    break
                except Exception:  # noqa: BLE001
                    if attempt == 3:
                        raise
                    time.sleep(2**attempt)
    api.call("POST", f"/v1/imports/{s['id']}/complete")
    state = wait(lambda: (lambda st: st if st in ("needs_review", "ready", "failed") else None)(api.get(f"/v1/imports/{s['id']}")["state"]), 90)
    check("the worker inspects the import (needs review)", state == "needs_review", str(state))

    # 2. Originals preserved, shapes detected.
    src = api.get(f"/v1/projects/{pid}/sources")["sources"][0]
    tree = walk(api, src["id"])
    want = {rel.removeprefix("chest_study/"): hashlib.sha256(d).hexdigest() for rel, d in files.items() if not rel.endswith(".DS_Store")}
    check("the tree mirrors the folder, names and checksums as uploaded", {k: v["sha256"] for k, v in tree.items()} == want, str(sorted(tree)))
    img = tree["films/film_001.png"]
    pv = api.get(f"/v1/source-nodes/{img['id']}/preview")
    check("an original's bytes are unchanged", hashlib.sha256(api.bytes(pv["url"])).hexdigest() == want["films/film_001.png"])
    kinds = {k: tree[k]["detectedKind"] for k in ("films/film_001.png", "labels.csv", "protocol.pdf", "scanner_export.bin", "readme.txt")}
    check("kinds are detected from content", kinds == {"films/film_001.png": "image", "labels.csv": "table", "protocol.pdf": "document", "scanner_export.bin": "unknown", "readme.txt": "document"}, str(kinds))
    check("image facts: size and thumbnail", img["facts"].get("width") == 64 and img["facts"].get("height") == 48 and bool(pv.get("thumbnailUrl")))

    # 3. Proposed, not applied.
    props = {x["kind"]: x for x in api.get(f"/v1/projects/{pid}/proposals")["proposals"]}
    rel = props.get("relationship")
    check("a CSV ↔ image relationship is proposed", bool(rel) and rel["status"] == "proposed" and rel["payload"]["column"] == "image", json.dumps(rel)[:200] if rel else "none")
    check("its evidence: 8 matched, 1 not found, 0 ambiguous", bool(rel) and (rel["evidence"]["matched"], rel["evidence"]["unmatched"], rel["evidence"]["ambiguous"]) == (8, 1, 0))
    check("nothing applied: no dataset, no task, 0 annotations", api.get(f"/v1/projects/{pid}/datasets")["datasets"] == [] and api.get(f"/v1/projects/{pid}/overview")["tasks"] == [])

    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        base = f"http://localhost:{args.port}"
        try:
            page.goto(f"{base}/projects/{pid}/explore/relationships")
            row = page.locator("[data-testid='relationship-row']").first
            row.wait_for(timeout=30000)
            text = row.inner_text()
            check("Explore lists the relationship with strength words", "labels.csv" in text and "Possible match" in text and "8 matched · 1 not found · 0 ambiguous" in text, text[:200])
            check("dashed while proposed", "border-dashed" in (row.get_attribute("class") or ""))
            check("no percentages on Explore", "%" not in page.inner_text("[data-testid='explore']"))
            page.get_by_test_id("relationship-why").first.click()
            check("Why? shows the evidence", "film_001" in page.inner_text("[data-testid='relationship-evidence']"))
            # The row with no image: skip it inline; the server recomputes.
            unmatched = page.locator("[data-testid='unmatched-row']")
            check("the not-found row is listed inline", unmatched.count() == 1 and "film_404.png" in unmatched.inner_text())
            unmatched.get_by_test_id("skip-row").click()
            wait(lambda: "1 skipped by you" in page.inner_text("[data-testid='relationship-counts']"), 15)
            check("skip → recomputed: 8 matched, 0 not found", "8 matched · 0 not found" in page.inner_text("[data-testid='relationship-counts']"))
            check("the URL holds the tab, never file names", "/explore/relationships" in page.url and "film" not in page.url and "labels" not in page.url, page.url)

            page.get_by_test_id("explore-tab-mappings").click()
            mrow = page.locator("[data-testid='mapping-row']").first
            mrow.wait_for(timeout=10000)
            check("label mapping: finding → normal, pneumonia", "finding" in mrow.inner_text() and "pneumonia" in page.inner_text("[data-testid='mapping-classes']"))

            page.get_by_test_id("explore-tab-quality").click()
            page.locator("[data-testid='quality-row']").first.wait_for(timeout=10000)
            check("quality lists the file we can't read", page.locator("[data-testid='quality-row'][data-type='unsupported']").count() == 1)

            page.get_by_test_id("explore-tab-summary").click()
            page.get_by_test_id("dataset-review").click()
            dlg = page.get_by_test_id("action-preview")
            dlg.wait_for(timeout=10000)
            page.get_by_test_id("preview-imported").wait_for(timeout=10000)
            ptext = dlg.inner_text()
            check("action preview: files, classes, imported labels, also confirms", "8 files" in ptext and "Imports 8 labels" in ptext and "imported" in ptext and page.locator("[data-testid='preview-also'] li").count() == 2, ptext[:300])
            check("the selected proposal is in the URL", f"proposal={props['dataset']['id']}" in page.url)
            page.get_by_test_id("create-and-open").click()
            page.wait_for_url("**/studio/tsk-*", timeout=30000)
            task = page.url.rsplit("/", 1)[-1].split("?")[0]
            check("Create & open Studio lands on the new task", task.startswith("tsk-"), page.url)

            def store(expr: str):
                return page.evaluate(f"async () => {{ const m = await import('{STORE}'); return ({expr})(m.useStudio.getState()); }}")

            def studio_state():
                return store("s => ({ n: s.annotations.length, prov: [...new Set(s.annotations.map(a => a.provenance))], labels: [...new Set(s.annotations.map(a => a.label))].sort(), items: s.project?.assets?.length ?? 0 })")

            st = wait(lambda: (lambda x: x if x["n"] else None)(studio_state()), 60)
            check("the Studio has the imported labels", bool(st) and st["n"] == 8 and st["prov"] == ["imported"], str(st))
            classes = wait(lambda: store("s => s.env?.labels?.map(g => g.classes.map(c => c.id).sort())"), 30)
            check("the CSV's classes are the task's labels", bool(classes) and all(c == ["normal", "pneumonia"] for c in classes), str(classes))
            check("2D Studio: the image tools", bool(wait(lambda: page.locator("[role='toolbar'][aria-label='Annotation tools']").count() == 1, 30)))
            check("items keep their original names", bool(wait(lambda: page.get_by_text("film_001.png").count() > 0, 15)))
            page.get_by_role("tab", name="Review").first.click()
            badge = wait(lambda: page.get_by_text("Imported", exact=True).count() > 0, 15)
            check("the imported badge is shown", bool(badge))
            n_before = st["n"] if st else 0

            # 5. Reload keeps everything.
            page.reload()
            st2 = wait(lambda: (lambda x: x if x["n"] else None)(studio_state()), 60)
            check("reload keeps the labels and their provenance", bool(st2) and st2["n"] == n_before and st2["prov"] == ["imported"], str(st2))
            props2 = {x["kind"]: x["status"] for x in api.get(f"/v1/projects/{pid}/proposals")["proposals"]}
            check("relationship, mapping and dataset are confirmed", props2 == {"relationship": "confirmed", "mapping": "confirmed", "dataset": "confirmed"}, str(props2))
            page.goto(f"{base}/projects/{pid}/explore/relationships")
            page.get_by_test_id("confirmed").first.wait_for(timeout=15000)
            check("Explore shows the confirmed relationship with a check", "Confirmed by you" in page.inner_text("[data-testid='relationship-row']"))
            check("no page errors", not errors, str(errors[:3]))
            page.screenshot(path=str(Path(args.out) / "mixed-import.png"))
        finally:
            ctx.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
