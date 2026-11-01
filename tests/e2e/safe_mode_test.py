"""todo10 Phase 4 exit: a plugin that breaks the Studio is installed, and the Studio is
recovered through safe mode and rollback in under a minute, with no model call.

Self-contained: it starts the kernel (synthetic seed, temp SQLite) and a frozen dev server
proxying to it, so saved environments, last-known-good and rollback all live in the kernel.

    python3 tests/e2e/safe_mode_test.py [--api-port 8212] [--port 5212] [--headed]   # repo root

1. The Studio opens a task cleanly; the person marks the setup as known good (⋯ menu).
2. A generated plugin is built, reviewed and approved (the kernel's install flow); its panel
   can't render, and the environment is changed to rely on it: the Studio no longer starts.
3. "Start in safe mode" boots the last-known-good setup with only first-party plugins.
4. "Restore this setup" rolls back (environment + plugin pins) in one transaction; the Studio
   starts normally again. Environment and lockfile hashes equal last-known-good's, the plugin is
   disabled, and the hash-chained audit ends with the rollback. No request reached the agent.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "apps" / "web" / "e2e"))

from harness import NAMING, launch, sync_playwright  # noqa: E402

P, NS = NAMING["envPrefix"], NAMING["namespace"]
TASK = "sm-xray"
GEN = f"{NS}.generated.broken-counter"
ENV = {"extends": "preset:image-2d", "task": "detection", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "lesion"}]}]}
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def png(w: int, h: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 5 + y * 3) % 256 for x in range(w)]) for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


class Kernel:
    def __init__(self, base: str):
        self.base = base

    def __call__(self, method: str, path: str, body=None, raw: bytes | None = None, ctype="application/json"):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": ctype, "X-Workspace-Id": TASK})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode()
                return r.status, (json.loads(text) if text else None)
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            try:
                return e.code, json.loads(text)
            except ValueError:
                return e.code, text


def wait_http(url: str, what: str, timeout: float = 180) -> None:
    end, last = time.time() + timeout, ""
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(0.5)
    raise RuntimeError(f"{what} didn't start at {url}: {last}")


def broken_plugin() -> bytes:
    """A generated declarative plugin whose panel config the Studio can't render (an unknown block)."""
    import yaml  # the kernel's dependency; this runs under its environment

    m = {"schemaVersion": f"{NAMING['schemaPrefix']}.plugins/v1", "id": GEN, "name": "Broken counter", "version": "0.1.0", "publisher": "generated", "license": "MIT",
         "compatibility": {"studio": ">=0.1.0 <1.0.0", "pluginApi": "^1"}, "capabilities": [], "runtime": {"kind": "none"}, "ui": {"contributions": "ui/contributions.json"},
         "permissions": {"required": [], "optional": []}}
    ui = {"toolbarActions": [], "panels": [{"id": "count", "surface": "studio.panel.right", "title": "Count", "renderer": "studio.declarative-panel.v1", "dataBinding": "annotations.currentItem", "config": {"blocks": [{"type": "no-such-block"}]}}]}
    files = {"plugin.yaml": yaml.safe_dump(m, sort_keys=False), "ui/contributions.json": json.dumps(ui), "README.md": "# Broken counter\n"}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, text in files.items():
            b = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(b)
            tf.addfile(info, io.BytesIO(b))
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-port", type=int, default=8212)
    ap.add_argument("--port", type=int, default=5212)
    ap.add_argument("--browser", default="chromium")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default=str(REPO / "apps" / "web" / "e2e" / ".artifacts"))
    a = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="safe-mode-e2e-"))
    seeds = tmp / "seed"
    (seeds / TASK / "img").mkdir(parents=True)
    (seeds / TASK / "img" / "a.png").write_bytes(png(64, 48))
    (seeds / "manifest.json").write_text(json.dumps({"projects": [{"id": TASK, "title": "Safe mode X-ray", "assets": [{"path": f"{TASK}/img/a.png"}], "environment": ENV}]}))
    kenv = {**os.environ, f"{P}API_DATABASE_URL": f"sqlite:///{tmp / 'api.db'}", f"{P}API_DATA_DIR": str(tmp / "data"), f"{P}API_SEED_ROOT": str(seeds)}
    procs = []
    try:
        procs.append(subprocess.Popen(["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--port", str(a.api_port), "--log-level", "warning"], cwd=REPO, env=kenv, stdout=open(tmp / "api.log", "w"), stderr=subprocess.STDOUT))  # noqa: SIM115
        wait_http(f"http://127.0.0.1:{a.api_port}/healthz", "the kernel")
        venv = {**os.environ, f"{P}API_URL": f"http://127.0.0.1:{a.api_port}", f"{P}E2E": "1"}
        procs.append(subprocess.Popen(["pnpm", "exec", "vite", "--port", str(a.port), "--strictPort"], cwd=REPO / "apps" / "web", env=venv, stdout=open(tmp / "vite.log", "w"), stderr=subprocess.STDOUT))  # noqa: SIM115
        wait_http(f"http://localhost:{a.port}/", "the dev server")
        return run(a, Kernel(f"http://127.0.0.1:{a.api_port}/api"))
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        if any(not ok for _, ok, _ in results):
            for log in ("api.log", "vite.log"):
                f = tmp / log
                print(f"---- {log} ----\n" + ("\n".join(f.read_text().splitlines()[-30:]) if f.exists() else ""), file=sys.stderr)
        shutil.rmtree(tmp, ignore_errors=True)


def run(a, k: Kernel) -> int:
    url = f"http://localhost:{a.port}/projects/{TASK}/studio/{TASK}"
    toolbar = "[role='toolbar'][aria-label='Annotation tools']"
    with sync_playwright() as pw:
        browser = launch(pw, a.browser, a.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        agent_calls: list[str] = []
        page.on("request", lambda r: "/api/agent" in r.url and agent_calls.append(r.url))
        try:
            page.goto(url)
            page.wait_for_selector(toolbar, timeout=90000)
            check("the task opens cleanly", page.locator("[data-testid='env-errors'], [data-testid='studio-crashed']").count() == 0)
            # 1. Mark the setup as known good (a person; the ⋯ menu).
            page.get_by_test_id("studio-more").click()
            page.get_by_test_id("menu-known-good").click()
            kg = None
            for _ in range(40):
                s, kg = k("GET", f"/environments/{TASK}/last-known-good")
                if s == 200:
                    break
                time.sleep(0.25)
            check("marked known good", s == 200 and kg["movedBecause"] in ("person", "checks"), str(kg)[:200])

            # 2. A plugin that breaks the Studio: built, reviewed, approved; the setup relies on it.
            s, built = k("POST", "/v1/plugins/artifacts", raw=broken_plugin(), ctype="application/gzip")
            check("plugin built and signed", s == 200 and built.get("registered"), str(built)[:300])
            _, plan = k("POST", f"/v1/workspaces/{TASK}/plugins/plan", {"pluginId": GEN})
            k("POST", f"/v1/workspaces/{TASK}/plugins/stage", {"requestId": plan["requestId"]})
            _, done = k("POST", f"/v1/workspaces/{TASK}/plugins/approve", {"requestId": plan["requestId"]})
            check("plugin activated after review", done.get("state") == "ACTIVATED", str(done)[:200])
            _, cur = k("GET", f"/environments/{TASK}")
            k("PUT", f"/environments/{TASK}", {"revision": cur["revision"], "environment": {**ENV, "panels": {"right": [{"id": f"{GEN}.panels.count"}]}}})

            page.goto(url)
            page.wait_for_selector("[data-testid='start-safe-mode']", timeout=90000)
            t0 = time.monotonic()
            check("the Studio no longer starts, and offers safe mode", page.locator(toolbar).count() == 0)

            # 3. Safe mode: last known good, first-party only.
            page.get_by_test_id("start-safe-mode").click()
            page.wait_for_selector("[data-testid='safe-mode-banner']", timeout=60000)
            page.wait_for_selector(toolbar, timeout=60000)
            t_safe = time.monotonic() - t0
            check("safe mode starts the Studio", "Safe mode" in page.inner_text("[data-testid='safe-mode-banner']"), f"{t_safe:.1f}s after the error screen")
            check("safe mode runs no non-first-party plugin", page.locator("[data-panel-id*='generated']").count() == 0 and GEN not in page.content())

            # 4. Roll back.
            page.get_by_test_id("safe-mode-rollback").click()
            page.wait_for_function("() => !new URLSearchParams(location.search).has('safe')", timeout=60000)
            page.wait_for_selector(toolbar, timeout=60000)
            elapsed = time.monotonic() - t0
            check("rollback: the Studio starts normally again", page.locator("[data-testid='safe-mode-banner'], [data-testid='start-safe-mode']").count() == 0)
            check("recovered in under a minute", elapsed < 60, f"{elapsed:.1f}s (safe mode up after {t_safe:.1f}s)")
            _, env = k("GET", f"/environments/{TASK}")
            _, lock = k("GET", f"/environments/{TASK}/lockfile")
            check("environment is last-known-good's", env["contentHash"] == kg["contentHash"], f"{env.get('contentHash')} vs {kg['contentHash']}")
            check("lockfile is last-known-good's", lock["contentHash"] == kg["lockfileHash"] and GEN not in [p["id"] for p in lock["lockfile"]["plugins"]])
            _, chain = k("GET", f"/environments/{TASK}/audit")
            # (After the rollback the Studio's clean start may move last-known-good to the restored revision.)
            actions = [e["action"] for e in chain.get("entries", [])]
            check("hash-chained audit verifies and records the rollback", chain["ok"] and "studio.rollback" in actions[:3], str(actions[:4]))
            check("no model call", not agent_calls, str(agent_calls[:3]))
            out = Path(a.out) / "safe-mode"
            out.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out / "recovered.png"))
        finally:
            page.context.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
