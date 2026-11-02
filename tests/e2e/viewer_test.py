"""todo10 Phase 5 exit: a rung-4 sandboxed viewer for a format the Studio doesn't support (PLY
point clouds), built as an agent-authored plugin, approved by a person, and rendered in the
Studio behind the MCP Apps sandbox proxy. Its annotations come back as typed geometries.

What is real and what is scripted:
- real: the kernel's checks (dry run), the worker's rebuild and signature (todo10 Phase 7), the install flow (plan → stage
  → validate → approve), scope enforcement (the agent session can't approve), the Studio
  loading the approved plugin from the kernel, the sandbox proxy, the MCP Apps bridge, the
  viewer reading the item's bytes and proposing an annotation;
- scripted: the agent. The viewer's source (fixtures/viewer-ply/viewer.mjs) was written by an
  agent ahead of time, and this test submits it with an agent-scoped session token, as the
  agent's build_plugin_artifact tool does (Daytona isn't involved). The person's approval is a
  kernel call with the person's identity, the same call InstallReview makes.

    (cd apps/api && STUDIO_API_DATA_DIR=/tmp/k uv run uvicorn studio_api.app:app --port 8241) &
    (cd apps/worker && STUDIO_WORKER_SIGNING_KEY_FILE=/tmp/k/plugin-signing.key uv run studio-worker --kernel http://127.0.0.1:8241) &
    STUDIO_E2E=1 pnpm exec vite --port 5240 --strictPort          # from apps/web
    STUDIO_E2E_API_URL=http://127.0.0.1:8241 python3 ../../tests/e2e/viewer_test.py --port 5240

Without a kernel the test is skipped (reported).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
import viewer_plugin  # noqa: E402
from harness import NAMING, launch, open_studio, parse_args, sync_playwright  # noqa: E402

NS = NAMING["namespace"]
P = NAMING["envPrefix"]
KERNEL = os.environ.get(f"{P}E2E_API_URL")
WS = "ply-demo"
PLUGIN = viewer_plugin.plugin_id(NS)
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=30.0, every=0.25):
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


def kernel(method: str, path: str, body=None, token: str | None = None, raw: bytes | None = None, ctype="application/json"):
    headers = {"Content-Type": ctype, "X-Workspace-Id": WS}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{KERNEL}/api/v1{path}", method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def install() -> tuple[dict, dict] | None:
    """Agent builds and stages; the person approves. Returns (workspace state, plugin body) from the kernel."""
    try:
        kernel("GET", "/health")
    except Exception:  # noqa: BLE001
        print(f"SKIP install: kernel not reachable at {KERNEL}")
        return None
    s, sess = kernel("POST", "/sessions", {"agent": "builder", "scopes": ["plugins.read", "plugins.manage", "plugins.author"], "ttlSeconds": 900})
    check("install: person mints an agent session without plugins.approve", s == 200 and "plugins.approve" not in sess["scopes"], str(sess))
    agent = sess["token"]
    tarball = viewer_plugin.pack(NS)
    s, dry = kernel("POST", "/plugins/artifacts?dryRun=true", token=agent, raw=tarball, ctype="application/gzip")
    check("install: the agent's package passes the kernel's checks (dry run)", s == 200 and dry.get("ok"), json.dumps(dry)[:300])
    # todo10 Phase 7: agents only send source; the worker rebuilds, hashes and signs it.
    s, started = kernel("POST", "/boundary/builds", token=agent, raw=tarball, ctype="application/gzip")
    job = (started or {}).get("job", {}).get("jobId")
    view = wait(lambda: (lambda v: v if v["job"]["state"] in ("succeeded", "failed") else None)(kernel("GET", f"/boundary/jobs/{job}", token=agent)[1]), 180, 1) if job else None
    built = (view or {}).get("result") or {}
    check("install: the worker rebuilt and signed it; the registry holds our build", bool(built.get("registered")) and str(built.get("artifactDigest", "")).startswith("sha256:"), json.dumps(view)[:400] if view else f"{s} {started} (is a worker running against {KERNEL}?)")
    s, plan = kernel("POST", f"/workspaces/{WS}/plugins/plan", {"pluginId": PLUGIN}, token=agent)
    check("install: the agent plans the install", s == 200 and plan.get("requestId"), str(plan)[:300])
    s, staged = kernel("POST", f"/workspaces/{WS}/plugins/stage", {"requestId": plan["requestId"]}, token=agent)
    check("install: staged and validated, waiting for a person", s == 200 and staged.get("state") == "AWAITING_APPROVAL", str(staged)[:300])
    s, denied = kernel("POST", f"/workspaces/{WS}/plugins/approve", {"requestId": plan["requestId"]}, token=agent)
    check("install: the agent can't approve its own plugin", s == 403, f"{s} {denied}")
    s, approved = kernel("POST", f"/workspaces/{WS}/plugins/approve", {"requestId": plan["requestId"]})
    check("install: the person approves; the plugin is activated", s == 200 and approved.get("state") == "ACTIVATED", str(approved)[:300])
    s, state = kernel("GET", f"/workspaces/{WS}/state")
    s2, body = kernel("GET", f"/plugins/{PLUGIN}?version={built.get('version', '0.1.0')}")
    pin = next((p for p in state.get("plugins", []) if p["pluginId"] == PLUGIN), None)
    check("install: workspace state pins the signed digest", bool(pin) and pin.get("artifactDigest") == built.get("artifactDigest"), str(pin))
    return state, body


def t_viewer(browser, port: int, installed: tuple[dict, dict], out: Path) -> None:
    ply = Path(tempfile.mkdtemp()) / "sphere.ply"
    ply.write_bytes(viewer_plugin.synthetic_ply(2000))
    state = installed[0]
    proj = {
        "id": WS,
        "title": "PLY point clouds (synthetic)",
        "environment": {
            "data": {"kind": f"{NS}.generic.dataKinds.files"},
            "viewports": [{"name": "main", "renderer": f"{PLUGIN}.renderers.ply"}],
            "labels": [{"name": "scene", "control": "Choices", "classes": [{"id": "indoor"}, {"id": "outdoor"}]}],
        },
        "source": "synthetic",
        "license": "CC0",
        "status": "available",
        "assets": [{"path": f"{WS}/sphere.ply", "sha256": "0" * 64, "bytes": ply.stat().st_size}],
    }
    st = open_studio(browser, port, WS, extra_projects=[proj], fixtures={f"{WS}/sphere.ply": ply}, fixture_annotations=[], workspace_state=state)
    p = st.page
    # The dev server runs in seed mode; plugin files come from the real kernel, and the Studio
    # checks them against the workspace's pinned digest (fetch-and-hash, todo10 Phase 3).
    def from_kernel(route):
        url = route.request.url
        r = route.fetch(url=KERNEL + url[url.index("/api/v1/"):], headers={**route.request.headers, "x-workspace-id": WS})
        route.fulfill(response=r)

    p.route(f"**/api/v1/plugins/{PLUGIN}/**", from_kernel)
    try:
        p.reload()
        frame = p.locator("[data-testid='sandbox-viewer']")
        frame.wait_for(state="attached", timeout=60000)
        src = frame.get_attribute("src") or ""
        check("studio: the approved bytes passed the browser's digest check; the viewer fills the viewport, on the sandbox proxy's origin", src.endswith("/sandbox-proxy.html") and not src.startswith(p.evaluate("location.origin") + "/"), src)
        check("studio: proxy frame allows scripts only", (frame.get_attribute("sandbox") or "").split() == ["allow-scripts"], str(frame.get_attribute("sandbox")))
        view = p.frame_locator("[data-testid='sandbox-viewer']").frame_locator("iframe")
        points = wait(lambda: view.locator("#ply-canvas").get_attribute("data-points"), 60)
        check("studio: the viewer read the item's bytes through the bridge and parsed 2000 points", points == "2000", str(points))
        runtime = wait(lambda: p.evaluate(f"async () => (await import('/@fs{viewer_plugin.HERE.parents[3]}/packages/plugin-ui-sdk/src/runtime.ts')).getRuntime('{WS}/sphere.ply', 'viewer.pointCloud')"), 15)
        check("studio: the viewer published a runtime value in its own namespace", bool(runtime) and runtime.get("points") == 2000, str(runtime))
        view.locator("button[data-label='indoor']").click()
        got = wait(lambda: st.store(f"s => s.annotations.filter(a => a.author === 'viewer:{PLUGIN}').map(a => ({{ label: a.label, type: a.geometry.type, provenance: a.provenance }}))"), 15)
        check("studio: the viewer's annotation arrives as a typed geometry, ai-suggested", got == [{"label": "indoor", "type": "class", "provenance": "ai-suggested"}], str(got))
        status = wait(lambda: (lambda t: t if "suggested" in t else None)(view.locator("#status").inner_text()), 10)
        check("studio: the viewer got the host's answer", bool(status), str(status))
        out.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=str(out / "ply-viewer.png"))
        errs = [e for e in st.errors if "favicon" not in e]
        check("studio: no console errors", not errs, str(errs[:3]))
    finally:
        p.context.close()


def main() -> int:
    args = parse_args()
    installed = install() if KERNEL else None
    if not installed:
        print(f"SKIP: needs the kernel and a worker ({P}E2E_API_URL)")
        return 0
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        try:
            t_viewer(browser, args.port, installed, Path(args.out) / "viewers")
        except Exception as e:  # noqa: BLE001
            check("unexpected error", False, f"{type(e).__name__}: {e}")
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
