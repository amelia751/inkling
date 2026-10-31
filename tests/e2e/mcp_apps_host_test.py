"""todo10 Phase 5 exit: the rung-4 PLY viewer renders in an MCP Apps host outside Inkling.

apps/mcp serves each active sandboxed viewer of a workspace as an MCP Apps UI resource plus a
`view_*` tool. The host here (apps/mcp/test/apps-host) is not the Studio: it uses the official
MCP client and the official `@modelcontextprotocol/ext-apps` AppBridge, and the reference host's
sandbox proxy, on its own origins. The test opens it in Chromium and checks the View connects,
reads the file through the app-only tool, and draws the cloud; and that the model-facing tool
result carries only the file name.

Needs the kernel with the plugin approved in workspace `ply-demo` (viewer_test.py installs it;
this test does too if it's missing):

    (cd apps/api && uv run uvicorn studio_api.app:app --port 8241) &
    INKLING_E2E_API_URL=http://127.0.0.1:8241 python3 tests/e2e/mcp_apps_host_test.py

Ports: 8242 (a static stand-in for the Studio's /seed files), 8243 (host), 8244 (sandbox proxy).
"""
from __future__ import annotations

import functools
import http.server
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
import viewer_plugin  # noqa: E402
import viewer_test  # noqa: E402
from harness import NAMING, launch, sync_playwright  # noqa: E402
from viewer_test import KERNEL, PLUGIN, WS, check, kernel, results, wait  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WEB, HOST, SANDBOX = 8242, 8243, 8244


def main() -> int:
    if not KERNEL:
        print(f"SKIP set {NAMING['envPrefix']}E2E_API_URL (the kernel with workspace {WS})")
        return 0
    s, state = kernel("GET", f"/workspaces/{WS}/state")
    if not any(p["pluginId"] == PLUGIN and p["state"] == "ACTIVATED" for p in state.get("plugins", [])):
        viewer_test.install()
    seed = Path(tempfile.mkdtemp())
    (seed / "seed" / WS).mkdir(parents=True)
    (seed / "seed" / WS / "sphere.ply").write_bytes(viewer_plugin.synthetic_ply(2000))
    web = http.server.ThreadingHTTPServer(("127.0.0.1", WEB), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(seed)))
    threading.Thread(target=web.serve_forever, daemon=True).start()
    proc = subprocess.Popen(
        ["node", "test/apps-host/run.mjs", "--web", f"http://127.0.0.1:{WEB}", "--api", KERNEL, "--workspace", WS, "--host-port", str(HOST), "--sandbox-port", str(SANDBOX)],
        cwd=ROOT / "apps" / "mcp", stdout=subprocess.PIPE, text=True,
    )
    try:
        line = proc.stdout.readline().strip() if proc.stdout else ""
        check("harness: MCP client connected to apps/mcp, host up", line.startswith("READY"), line)
        with sync_playwright() as pw:
            browser = launch(pw, "chromium")
            page = browser.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{HOST}/?path={WS}/sphere.ply")
            tool = wait(lambda: page.locator("#tool").inner_text(), 30)
            check("host: apps/mcp lists a view tool with a ui:// resource", bool(tool) and tool.startswith("view_"), str(tool))
            check("host: the View connected through the ext-apps AppBridge", bool(wait(lambda: page.evaluate("document.body.dataset.initialized === '1'"), 30)))
            view = page.frame_locator("#app").frame_locator("iframe")
            points = wait(lambda: view.locator("#ply-canvas").get_attribute("data-points"), 30)
            check("host: the same viewer renders outside the Studio (2000 points)", points == "2000", str(points))
            log = page.locator("#log").inner_text()
            check("host: the View read the file through the app-only tool", "viewer_read_asset" in log, log)
            check("host: the model-facing tool result has only the file name", "Showing sphere.ply" in log and "blob" not in log.split("app →")[0], log.splitlines()[0])
            classes = view.locator("#classes button").count()
            check("host: no label buttons outside the Studio (read-only)", classes == 0, str(classes))
            out = ROOT / "apps" / "web" / "e2e" / ".artifacts" / "viewers"
            out.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out / "mcp-apps-host.png"), full_page=True)
            check("host: no page errors", not errors, str(errors[:3]))
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        web.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
