"""todo11 Milestone 3 Slice A exit: drop 200 synthetic images into a Studio.

- each image is an item at `registered` (before its bytes are sent): the first skeleton paints
  within 300 ms of registration;
- the first thumbnail paints within 500 ms of its `item.thumb_ready` event;
- the first item is viewable (full image on the Cornerstone viewport) before the batch has
  finished processing;
- zero full page loads; one engine instance across 20 item switches; a big image paints its
  preview first and is replaced by the full image in place;
- background completion (all 200 `ready`) is recorded, not gated.

Starts its own API (:8271), worker and frozen Vite dev server (:5271) on a temp data dir, so
it never touches your dev data:

    uv run --package studio-web-e2e python tests/e2e/ingest_images_test.py
    ... --external     # use an API + worker + Vite you started on those ports yourself

Synthetic images only (numpy noise and gradients).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib import request as urlrequest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "apps" / "web" / "e2e"))

from harness import NAMING, STORE, launch, sync_playwright  # noqa: E402

RES = NAMING["resourcePrefix"]
PREFIX = NAMING["envPrefix"]
HOOK_2D = f"__{RES}2d"
MARKS = f"__{RES}Ingest"
API_PORT, WEB_PORT = 8271, 5271
N = 200

results: list[tuple[str, bool, str]] = []
budgets: dict[str, object] = {}


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=60.0, every=0.1):
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


def images(folder: Path) -> list[Path]:
    """200 synthetic PNGs: gradients with noise, mostly 800×600; every 20th is 2000×1200
    (so it gets a WebP preview), a few portrait."""
    import numpy as np
    from PIL import Image

    rng = np.random.default_rng(11)
    out = []
    for i in range(N):
        w, h = (2000, 1200) if i % 20 == 7 else ((600, 800) if i % 13 == 5 else (800, 600))
        y, x = np.mgrid[0:h, 0:w]
        base = ((x * (i % 7 + 1) + y * 3) % 256).astype(np.uint8)
        noise = rng.integers(0, 12, size=(h, w), dtype=np.uint8)
        px = (base // 2 + noise).astype(np.uint8)
        p = folder / f"synthetic_{i:03d}.png"
        Image.fromarray(px, "L").save(p, optimize=False, compress_level=6)
        out.append(p)
    return out


class Stack:
    def __init__(self, external: bool):
        self.external = external
        self.procs: list[subprocess.Popen] = []
        self.tmp = Path(tempfile.mkdtemp(prefix="ingest-e2e-"))

    def start(self) -> None:
        if self.external:
            return
        env = {**os.environ, f"{PREFIX}API_DATA_DIR": str(self.tmp / "api"), f"{PREFIX}WORKER_DATA_DIR": str(self.tmp / "worker"), f"{PREFIX}WORKER_BUILD_ENVS": "0"}
        logs = self.tmp / "logs"
        logs.mkdir()

        def run(name, args, cwd=REPO, extra=None):
            f = open(logs / f"{name}.log", "w")  # noqa: SIM115
            self.procs.append(subprocess.Popen(args, cwd=cwd, env={**env, **(extra or {})}, stdout=f, stderr=subprocess.STDOUT, start_new_session=True))

        run("api", ["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--port", str(API_PORT)])
        if not wait(lambda: urlrequest.urlopen(f"http://127.0.0.1:{API_PORT}/api/v1/health", timeout=2).status == 200, 90, 0.3):
            raise RuntimeError(f"the API didn't start; see {logs / 'api.log'}")
        run("worker", ["uv", "run", "--package", "studio-worker", "studio-worker", "--kernel", f"http://127.0.0.1:{API_PORT}", "--poll", "0.5"])
        run("vite", ["pnpm", "exec", "vite", "--port", str(WEB_PORT), "--strictPort"], cwd=REPO / "apps" / "web", extra={f"{PREFIX}API_URL": f"http://127.0.0.1:{API_PORT}", f"{PREFIX}E2E": "1"})
        if not wait(lambda: urlrequest.urlopen(f"http://localhost:{WEB_PORT}/api/v1/health", timeout=2).status == 200, 120, 0.5):
            raise RuntimeError(f"Vite didn't start; see {logs / 'vite.log'}")
        print(f"stack up (logs in {logs})", flush=True)

    def stop(self) -> None:
        for p in self.procs:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)


def api(method: str, path: str, body=None):
    req = urlrequest.Request(f"http://localhost:{WEB_PORT}/api{path}", data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json"})
    with urlrequest.urlopen(req, timeout=60) as r:
        text = r.read()
        return json.loads(text) if text else None


def all_items(task: str) -> list[dict]:
    out, after = [], "0"
    while after is not None:
        page = api("GET", f"/v1/tasks/{task}/items?after={after}&limit=1000")
        out += page["items"]
        after = page["next"]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--external", action="store_true")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    stack = Stack(args.external)
    try:
        stack.start()
        return run(stack, args)
    finally:
        stack.stop()
        if not any(not ok for _, ok, _ in results):
            shutil.rmtree(stack.tmp, ignore_errors=True)
        else:
            print(f"kept {stack.tmp} (logs/)")


def run(stack: Stack, args) -> int:
    folder = stack.tmp / "drop"
    folder.mkdir()
    t = time.time()
    files = images(folder)
    total_bytes = sum(p.stat().st_size for p in files)
    print(f"generated {N} images, {total_bytes / 1e6:.1f} MB, in {time.time() - t:.1f}s", flush=True)

    pid = api("POST", "/v1/projects", {"title": f"Ingest {int(time.time())}"})["id"]
    task = api("POST", f"/v1/projects/{pid}/boots", {"bootId": f"boot-{uuid.uuid4().hex[:12]}", "preset": "preset:image-2d", "name": "Synthetic drop"})["taskIds"][0]

    with sync_playwright() as pw:
        browser = launch(pw, "chromium", args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Every document load counts: the drop must never reload the page.
        page.add_init_script("sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') || 0) + 1))")
        page.goto(f"http://localhost:{WEB_PORT}/projects/{pid}/studio/{task}")
        page.wait_for_selector("[data-testid=files-panel]", timeout=60000)
        page.wait_for_selector("[data-testid=items-add]", timeout=30000)

        # The drop: the rail's Add picker (the same handler as dropping on the rail).
        t_drop = time.time()
        page.set_input_files("[data-testid=files-panel] input[data-testid=pick-files]", [str(p) for p in files])
        page.wait_for_selector("[data-testid=attestation]", timeout=10000)
        page.click("#attest")
        page.click("[data-testid=attest-confirm]")

        # Skeletons: the first within 300 ms of registration.
        page.wait_for_function(f"() => Object.keys(window.{MARKS}.skeleton).length > 0", timeout=60000)
        page.wait_for_timeout(300)
        m = page.evaluate(f"() => window.{MARKS}")
        reg = m["registered"]
        first_reg = min(reg.values()) if reg else None
        first_skel = min(m["skeleton"].values())
        lat = first_skel - first_reg if first_reg is not None else None
        budgets["registered → first skeleton (ms)"] = round(lat) if lat is not None else None
        check("200 items registered at once", len(reg) == N, f"{len(reg)} registered")
        check("first skeleton within 300 ms of registered", lat is not None and lat < 300, f"{lat:.0f} ms" if lat is not None else "no marks")
        per = [m["skeleton"][k] - reg[k] for k in m["skeleton"] if k in reg]
        budgets["registered → skeleton, rows on screen, p50/max (ms)"] = (round(statistics.median(per)), round(max(per))) if per else None
        check("rows appear before any byte is processed", page.locator("[data-testid=item-skeleton]").count() > 10, f"{page.locator('[data-testid=item-skeleton]').count()} skeletons")
        # Skeletons are sized by aspect ratio once probed: a portrait image's box is narrower.
        pill_seen = False

        # The first item viewable while the batch is still processing.
        t_view = None
        t_thumb_ok = None
        while time.time() - t_drop < 120:
            st = page.evaluate(f"() => ({{ item: window.{HOOK_2D} ? window.{HOOK_2D}.itemId : null, m: window.{MARKS}, pill: !!document.querySelector('[data-testid=items-new-pill]') }})")
            pill_seen = pill_seen or st["pill"]
            if t_view is None and st["item"]:
                t_view = time.time()
                items_now = all_items(task)
                not_ready = sum(1 for i in items_now if i["ingest"]["state"] not in ("ready", "failed"))
                budgets["drop → first item viewable (s)"] = round(t_view - t_drop, 2)
                budgets["items not yet ready when the first was viewable"] = not_ready
                check("first item viewable before the batch finishes", not_ready > 0, f"{not_ready}/{N} still processing at {t_view - t_drop:.1f}s")
            if t_thumb_ok is None and st["m"]["thumbPainted"]:
                t_thumb_ok = time.time()
            if t_view and t_thumb_ok:
                break
            time.sleep(0.05)
        if t_view is None:
            check("first item viewable before the batch finishes", False, "no image on the viewport in 120 s")

        # Thumbnails: painted within 500 ms of their thumb_ready event (rows on screen).
        page.wait_for_timeout(1000)
        m = page.evaluate(f"() => window.{MARKS}")
        pairs = sorted((m["thumbEvent"][k], m["thumbPainted"][k] - m["thumbEvent"][k]) for k in m["thumbPainted"] if k in m["thumbEvent"])
        first_thumb = pairs[0][1] if pairs else None
        budgets["thumb_ready → first thumbnail painted (ms)"] = round(first_thumb) if first_thumb is not None else None
        if pairs:
            ds = [d for _, d in pairs]
            budgets["thumb_ready → thumbnail, rows on screen, p50/p95 (ms)"] = (round(statistics.median(ds)), round(sorted(ds)[int(len(ds) * 0.95) - 1 if len(ds) > 1 else 0]))
        check("first thumbnail painted within 500 ms of thumb_ready", first_thumb is not None and first_thumb < 500, f"{first_thumb:.0f} ms" if first_thumb is not None else "none painted")
        sizes = page.evaluate("() => [...document.querySelectorAll('[data-testid=item-thumb],[data-testid=item-skeleton]')].map(e => e.getBoundingClientRect().width)")
        check("thumbnails are sized by aspect ratio", len(set(round(s) for s in sizes)) >= 1 and all(14 <= s <= 36 for s in sizes), f"widths {sorted(set(round(s) for s in sizes))}")

        # Background completion: recorded, not gated.
        done = wait(lambda: (lambda xs: len(xs) == N and all(i["ingest"]["state"] in ("ready", "failed") for i in xs) and xs)(all_items(task)), 600, 0.5)
        t_all = time.time() - t_drop
        failed = [i["name"] for i in (done or []) if i["ingest"]["state"] == "failed"]
        budgets["drop → all 200 ready, background (s)"] = round(t_all, 1)
        budgets["end-to-end bytes per second (MB/s)"] = round(total_bytes / 1e6 / t_all, 2)
        check("every item reaches ready", bool(done) and not failed, f"{len(failed)} failed {failed[:3]}" if failed else f"{t_all:.1f}s")
        budgets["'N new' pill shown while items streamed in"] = pill_seen

        # The rail shows real thumbnails now; the page never reloaded.
        page.locator("[data-testid=items-queue]").evaluate("e => e.scrollTop = 0")
        wait(lambda: page.locator("[data-testid=item-thumb]").count() > 10, 15)
        check("the rail shows thumbnails", page.locator("[data-testid=item-thumb]").count() > 10, f"{page.locator('[data-testid=item-thumb]').count()} thumbnails")

        # 20 switches, one engine; a big image paints its preview, then the full image in place.
        engines = {page.evaluate(f"() => window.{HOOK_2D} && window.{HOOK_2D}.engine")}
        seen: set[str] = set()
        order = [7, 27, 1, 2, 47, 3, 4, 67, 5, 6, 87, 8, 9, 107, 10, 11, 127, 12, 13, 147]  # 7, 27, … are 2000×1200
        big = [i for i in order if i % 20 == 7]
        previews = 0
        for idx in order:
            prev = page.evaluate(f"() => window.{HOOK_2D} ? window.{HOOK_2D}.itemId : null")
            page.evaluate(f"async () => (await import('{STORE}')).useStudio.getState().setItemIndex({idx})")
            if idx in big:
                previews += 1 if wait(lambda: page.evaluate("() => !!document.querySelector('[data-testid=image-preview]')"), 1.0, 0.01) else 0
            page.wait_for_function(f"(prev) => window.{HOOK_2D} && window.{HOOK_2D}.itemId !== prev", arg=prev, timeout=30000)
            info = page.evaluate(f"() => ({{ engine: window.{HOOK_2D}.engine, item: window.{HOOK_2D}.itemId }})")
            seen.add(info["item"])
            engines.add(info["engine"])
        page.wait_for_timeout(300)
        check("one engine instance across 20 switches", len(engines) == 1 and len(seen) == 20, f"{len(seen)} items, engines {sorted(engines)}")
        gone = page.locator("[data-testid=image-preview]").count() == 0
        check("big images paint their preview first, then the full image replaces it", previews >= 1 and gone, f"preview seen on {previews}/{len(big)} big switches; gone once the full image is on: {gone}")

        loads = page.evaluate("() => Number(sessionStorage.getItem('loads'))")
        check("zero full page loads", loads == 1, f"{loads} document loads")
        errs = [e for e in errors if "favicon" not in e]
        check("no page errors", not errs, "; ".join(errs[:3]))
        browser.close()

    print("\nBudgets (todo11 §7):")
    for k, v in budgets.items():
        print(f"  {k}: {v}")
    bad = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed" + (f"; failed: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
