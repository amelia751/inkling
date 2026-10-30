"""docs/plugins.md §14 #9 and #12 in the browser (todo2 Phase 8).

- rollback: install the segmentation plugin through the kernel, add masks, change the
  plugin's pinned config (provider switch), roll back from the Plugins page, and check the
  masks stay, the Plugins page shows the previous pin, and the Segment command runs on the
  previous provider again. The registry ships one version of the plugin, so the version
  upgrade → rollback path itself is covered in apps/api/tests/test_rollback.py; the pin
  being rolled back here is (version, digest, config revision), the same mechanism.
  Needs the kernel and a worker; skipped when the kernel isn't reachable.
- tier 3: an agent-written sandbox panel's iframe has `sandbox` without
  `allow-same-origin`, runs on an opaque origin and can't reach the parent document.
  No kernel needed.

    <envPrefix>KERNEL=1 <envPrefix>E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 e2e/plugin_isolation_test.py --port 5199
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import NAMING, REPO, launch, open_studio, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
NS = NAMING["namespace"]
SEG = f"{NS}.segmentation"
WS = "2d-xray"


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


def kernel(page, method: str, path: str, body: dict | None = None):
    """Call the kernel as the dev workspace user (through the dev server's proxy)."""
    return page.evaluate(
        """async ([method, path, body, ws]) => {
          const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': ws }, body: body ? JSON.stringify(body) : undefined });
          return { status: r.status, body: await r.json().catch(() => null) };
        }""",
        [method, path, body, WS],
    )


def t_rollback(browser, port, out: Path) -> None:
    st = open_studio(browser, port, WS)
    p = st.page
    try:
        # Without a kernel the dev server answers with the SPA's index.html, so ask for JSON.
        if not p.evaluate("async () => { const r = await fetch('/api/v1/health'); return r.ok && (r.headers.get('content-type') || '').includes('json'); }"):
            print("SKIP rollback: kernel not reachable through the dev server proxy")
            return
        # Install through the kernel (plan → stage → approve), granting the self-hosted
        # provider's egress so the config change below is allowed.
        plan = kernel(p, "POST", f"/workspaces/{WS}/plugins/plan", {"pluginId": SEG})["body"]
        staged = kernel(p, "POST", f"/workspaces/{WS}/plugins/stage", {"requestId": plan["requestId"]})["body"]
        approved = kernel(p, "POST", f"/workspaces/{WS}/plugins/approve", {"requestId": plan["requestId"], "grantOptional": ["network.egress:sam.internal"]})
        check("rollback: installed through the kernel", approved["status"] == 200 and approved["body"]["state"] == "ACTIVATED", f"{staged.get('state')} → {approved}")
        # Start from a known pin: the mock provider (a reinstall keeps the last config revision).
        kernel(p, "POST", f"/workspaces/{WS}/plugins/configure", {"pluginId": SEG, "config": {"provider": "mock"}})
        pin0 = next(x for x in kernel(p, "GET", f"/workspaces/{WS}/state")["body"]["plugins"] if x["pluginId"] == SEG)
        # The Studio picks up the activation without a reload.
        p.reload()
        btn = p.locator(f"[data-toolbar-action='{SEG}.commands.segment']")
        btn.wait_for(timeout=60000)
        masks = lambda: st.store("s => s.annotations.filter(a => a.geometry.type === 'mask').map(a => ({ id: a.id, provider: a.attributes?.provider }))")  # noqa: E731
        before = len(masks())
        btn.click()
        after = wait(lambda: (lambda m: m if len(m) > before else None)(masks()), 120)
        check("rollback: masks added with the installed pin", bool(after) and after[-1]["provider"] == "mock", str(after and after[-1]))
        added = {m["id"] for m in after or []}
        check("rollback: there are masks to keep", bool(added))

        # Change the pin: switch provider (a new config revision is a new activated pin).
        cfg = kernel(p, "POST", f"/workspaces/{WS}/plugins/configure", {"pluginId": SEG, "config": {"provider": "local.sam"}})
        check("rollback: provider switch pinned as a new config revision", cfg["status"] == 200 and cfg["body"]["configRevision"] == pin0["configRevision"] + 1, str(cfg))

        # Roll back from the Plugins page (the UI the user has).
        p.get_by_role("link", name="Plugins").first.click()
        row = p.locator(f"[data-plugin='{SEG}']")
        row.wait_for(timeout=30000)
        check("rollback: Plugins page shows the new pin", f"config r{pin0['configRevision'] + 1}" in row.inner_text(), row.inner_text())
        row.get_by_role("button", name="Roll back").click()
        shown = wait(lambda: f"config r{pin0['configRevision']}" in row.inner_text() and "activated" in row.inner_text().lower(), 30)
        check("rollback: Plugins page shows the previous pin, still activated", bool(shown), row.inner_text())
        state = kernel(p, "GET", f"/workspaces/{WS}/state")["body"]
        pin = next(x for x in state["plugins"] if x["pluginId"] == SEG)
        check("rollback: workspace state is the previous pin", (pin["version"], pin["configRevision"]) == (pin0["version"], pin0["configRevision"]), str(pin))

        # Annotations stay, in the kernel document and in the Studio.
        p.get_by_role("link", name="Back to annotating").click()
        btn.wait_for(timeout=60000)
        doc = p.evaluate(f"async () => (await (await fetch('/api/annotations/{WS}')).json()).annotations.map(a => a.id)")
        check("rollback: masks kept in the kernel's document", added <= set(doc), f"{len(added - set(doc))} missing")
        kept = wait(lambda: added <= {m["id"] for m in masks()}, 30)
        check("rollback: masks kept in the Studio", bool(kept))

        # The previous pin is what runs: the command works again on the mock provider.
        n = len(masks())
        btn.click()
        again = wait(lambda: (lambda m: m if len(m) > n else None)(masks()), 120)
        check("rollback: Segment runs on the previous provider", bool(again) and again[-1]["provider"] == "mock", str(again and again[-1]))
        st.shot("rollback", out / "plugins")
        errs = [e for e in st.errors if "favicon" not in e]
        check("rollback: no console errors", not errs, str(errs[:3]))
    finally:
        kernel(p, "POST", f"/workspaces/{WS}/plugins/disable", {"pluginId": SEG})
        p.context.close()


SANDBOX_HTML = """<!doctype html><html><body><p id=out>starting</p><script>
let parentDoc = "blocked";
try { parentDoc = parent.document.title ? "readable" : "readable"; } catch (e) { parentDoc = "blocked"; }
let storage = "blocked";
try { localStorage.setItem("x", "1"); storage = "allowed"; } catch (e) { storage = "blocked"; }
document.getElementById("out").textContent = JSON.stringify({ origin: self.origin, parentDoc, storage });
</script></body></html>"""


def t_tier3_iframe(browser, port) -> None:
    xray = next(p for p in json.loads((REPO / "seed-data/manifest.json").read_text())["projects"] if p["id"] == WS)
    assets = [{k: v for k, v in a.items() if k != "label"} for a in xray["assets"][:1]]
    sandbox = f"{NS}.experimental.panels.sandbox"
    proj = {
        "id": "tier3-isolation",
        "title": "Tier 3 isolation",
        "environment": {"extends": "preset:generic-image", "panels": {"right": [sandbox]}, "overrides": [{"id": sandbox, "config": {"title": "Generated tool", "html": SANDBOX_HTML, "height": 160}}]},
        "source": "seed reuse",
        "license": "seed's license",
        "status": "available",
        "assets": assets,
    }
    st = open_studio(browser, port, "tier3-isolation", extra_projects=[proj], fixture_annotations=[], init_script=f"localStorage.setItem('{NAMING['resourcePrefix']}.flags', 'agentPanels')")
    try:
        frame = st.page.locator("[data-testid='agent-sandbox']")
        frame.wait_for(state="attached", timeout=60000)
        tokens = (frame.get_attribute("sandbox") or "").split() if frame.get_attribute("sandbox") is not None else None
        check("tier 3: iframe has a sandbox attribute", tokens is not None, str(tokens))
        check("tier 3: sandbox doesn't allow same origin", tokens is not None and "allow-same-origin" not in tokens, str(tokens))
        check("tier 3: sandbox allows nothing beyond scripts", tokens is not None and set(tokens) <= {"allow-scripts"}, str(tokens))
        check("tier 3: generated code is inline (srcdoc), not a main-origin URL", frame.get_attribute("srcdoc") is not None and not frame.get_attribute("src"))
        text = wait(lambda: (lambda t: t if t.startswith("{") else None)(st.page.frame_locator("[data-testid='agent-sandbox']").locator("#out").inner_text()), 30)
        got = json.loads(text) if text else {}
        check("tier 3: runs on an opaque origin", got.get("origin") == "null", str(got))
        check("tier 3: can't reach the Studio's document", got.get("parentDoc") == "blocked", str(got))
        check("tier 3: no access to the Studio's storage", got.get("storage") == "blocked", str(got))
    finally:
        st.page.context.close()


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        for fn in (lambda: t_tier3_iframe(browser, args.port), lambda: t_rollback(browser, args.port, Path(args.out))):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                check("unexpected error", False, f"{type(e).__name__}: {e}")
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
