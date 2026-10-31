"""todo10 Phase 3 exit: a tampered byte is refused with a reason, and the refusal is audited.

An agent-style build of a declarative plugin goes through the kernel (content-addressed, signed,
attested), is installed and approved, and the Studio loads it only after fetch-and-hash
against the workspace's pin. Then:

- the browser is handed a pin that doesn't match → it refuses the plugin and the kernel's
  audit log has a `plugins.artifact.refused` entry from `browser`;
- one byte of the stored package layer is flipped → the kernel refuses to serve it (409 with
  the reason) and audits that too; restoring the byte makes it load again.

Needs the kernel (with a local BlobStore) behind the dev server proxy:

    <envPrefix>API_DATA_DIR=/tmp/k <envPrefix>API_SEED_ROOT=$PWD/seed-data uv run uvicorn studio_api.app:app --port 8220   # apps/api
    <envPrefix>API_URL=http://127.0.0.1:8220 <envPrefix>E2E=1 pnpm exec vite --port 5220 --strictPort       # apps/web
    <envPrefix>API_DATA_DIR=/tmp/k python3 ../../tests/e2e/artifacts_test.py --port 5220                   # from apps/web
"""

from __future__ import annotations

import io
import json
import os
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))

from harness import NAMING, launch, open_studio, parse_args, src_url, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
WS = "2d-xray"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def api(port: int, method: str, path: str, body: bytes | dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    req = urllib.request.Request(f"http://localhost:{port}/api{path}", data=data, method=method, headers={"X-Workspace-Id": WS, "Content-Type": "application/json" if isinstance(body, dict) else "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def tarball(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, content in files.items():
            b = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(b)
            tf.addfile(info, io.BytesIO(b))
    return buf.getvalue()


def package(pid: str, version: str) -> dict[str, str]:
    import yaml

    m = {
        "schemaVersion": f"{NAMING['schemaPrefix']}.plugins/v1",
        "id": pid,
        "name": "E2E counter",
        "version": version,
        "publisher": "generated",
        "license": "MIT",
        "compatibility": {"studio": ">=0.1.0 <1.0.0", "pluginApi": "^1"},
        "capabilities": [],
        "runtime": {"kind": "none"},
        "ui": {"contributions": "ui/contributions.json"},
        "permissions": {"required": [], "optional": []},
    }
    ui = {"toolbarActions": [], "panels": [{"id": "count", "surface": "studio.panel.right", "title": "E2E count", "renderer": "studio.declarative-panel.v1", "dataBinding": "annotations.currentItem", "config": {"blocks": []}}]}
    return {"plugin.yaml": yaml.safe_dump(m, sort_keys=False), "ui/contributions.json": json.dumps(ui), "README.md": "# E2E counter, not tampered\n"}


def refusals(port: int) -> list[dict]:
    return [e["after"] for e in api(port, "GET", "/v1/audit?action=plugins.artifact.refused")[1].get("entries", [])]


def main() -> int:
    args = parse_args()
    ns = NAMING["namespace"]
    pid, version = f"{ns}.e2e-counter", f"0.1.{int(time.time())}"
    status, _ = api(args.port, "GET", "/v1/health")
    if status != 200:
        print("SKIP kernel not reachable through the dev server proxy")
        return 0
    data_dir = Path(os.environ.get(f"{NAMING['envPrefix']}API_DATA_DIR") or Path(__file__).resolve().parents[2] / "apps" / "api" / ".data")

    status, built = api(args.port, "POST", "/v1/plugins/artifacts?runId=e2e-run&model=e2e-model", tarball(package(pid, version)))
    check("build: content-addressed, signed, attested", status == 200 and built.get("registered") and str(built.get("manifestDigest", "")).startswith("sha256:") and bool(built.get("attestationDigest")), str(built)[:300])
    _, plan = api(args.port, "POST", f"/v1/workspaces/{WS}/plugins/plan", {"pluginId": pid, "version": version})
    _, staged = api(args.port, "POST", f"/v1/workspaces/{WS}/plugins/stage", {"requestId": plan["requestId"]})
    _, done = api(args.port, "POST", f"/v1/workspaces/{WS}/plugins/approve", {"requestId": plan["requestId"]})
    check("install: staged (verified) and approved", staged.get("state") == "AWAITING_APPROVAL" and done.get("state") == "ACTIVATED", f"{staged.get('state')} {staged.get('checks')} {done.get('state')}")
    _, state = api(args.port, "GET", f"/v1/workspaces/{WS}/state")
    pin = next((p["artifactDigest"] for p in state.get("plugins", []) if p["pluginId"] == pid), None)
    check("the workspace pins the tree digest", pin == built.get("artifactDigest"), str(pin))

    registry = src_url("apps/web/src/extension-host/registry.ts")
    loaded = f"async () => {{ const m = await import('{registry}'); return !!m.registry.availableModule('{pid}'); }}"
    layer = None
    try:
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            # 1. Pinned digest matches: the Studio loads the plugin.
            st = open_studio(browser, args.port, WS)
            p = st.page
            p.wait_for_selector("[role='toolbar'][aria-label='Annotation tools']", timeout=60000)
            p.wait_for_function(f"{loaded}", timeout=30000)
            check("verified bytes: the plugin is registered", p.evaluate(loaded))
            p.context.close()

            # 2. The browser is handed a different pin: fetch-and-hash refuses, the kernel audits it.
            before = len(refusals(args.port))
            forged = {**state, "plugins": [{**x, "artifactDigest": "sha256:" + "0" * 64} if x["pluginId"] == pid else x for x in state["plugins"]]}
            st = open_studio(browser, args.port, WS, workspace_state=forged)
            p = st.page
            refused_msgs: list[str] = []
            p.on("console", lambda m: "[plugins] refused" in m.text and refused_msgs.append(m.text))
            p.wait_for_selector("[role='toolbar'][aria-label='Annotation tools']", timeout=60000)
            deadline = time.time() + 20
            while time.time() < deadline and len(refusals(args.port)) == before:
                time.sleep(0.25)
            got = refusals(args.port)
            check("wrong pin: not registered", not p.evaluate(loaded))
            check("wrong pin: refusal with a reason in the audit log", len(got) > before and got[0].get("where") == "browser" and "pinned" in got[0].get("reason", ""), str(got[:1]))
            p.context.close()
            browser.close()

        # 3. One byte of the stored layer flipped: the kernel refuses to serve it and audits that.
        manifest = json.loads((data_dir / "artifacts" / "sha256" / built["manifestDigest"][7:]).read_bytes())
        layer = data_dir / "artifacts" / "sha256" / manifest["layers"][0]["digest"][7:]
        good = layer.read_bytes()
        bad = bytearray(good)
        bad[good.index(b"not tampered")] ^= 0x20
        layer.write_bytes(bytes(bad))
        status, body = api(args.port, "GET", f"/v1/plugins/{pid}/files?version={version}")
        check("tampered layer: 409 with the reason", status == 409 and "doesn't match its digest" in str(body), str(body)[:200])
        got = refusals(args.port)
        check("tampered layer: refusal in the audit log", got and got[0].get("where") == "files" and "package layer" in got[0].get("reason", ""), str(got[:1]))
        layer.write_bytes(good)
        layer = None
        check("restored: served again", api(args.port, "GET", f"/v1/plugins/{pid}/files?version={version}")[0] == 200)
    finally:
        if layer is not None and "good" in locals():
            layer.write_bytes(good)
        api(args.port, "POST", f"/v1/workspaces/{WS}/plugins/disable", {"pluginId": pid})
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
