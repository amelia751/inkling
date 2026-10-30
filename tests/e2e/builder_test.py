"""todo2 Phase 7: the builder agent installs a plugin, and approval stays with the user.

A scripted builder run (tests/e2e/fixtures/agent-script.json, "add segmentation") searches the registry,
plans and stages the install against the real kernel, then asks for approval. The chat card opens
the install review; approving there (the user's own kernel call) activates the plugin without a
reload. The kernel records the agent as requester and the user as approver.

Needs the kernel (apps/api) and the dev server with both proxies; the test starts the agent:

    (cd apps/api && uv run uvicorn studio_api.app:app --port 8011) &
    <envPrefix>KERNEL=1 <envPrefix>KERNEL_URL=http://127.0.0.1:8011 <envPrefix>E2E=1 \\
      <envPrefix>AGENT_URL=http://127.0.0.1:8299 INTERNAL_AGENT_SERVICE_TOKEN=e2e-agent-token \\
      pnpm exec vite --port 5299 --strictPort
    <envPrefix>E2E_KERNEL_URL=http://127.0.0.1:8011 python3 ../../tests/e2e/builder_test.py --port 5299   # from apps/web
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
# The browser harness lives with the web-only tests (apps/web/e2e).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
import agent_test  # noqa: E402
from agent_test import ask, check, results  # noqa: E402
from harness import NAMING, launch, open_studio, parse_args, sync_playwright  # noqa: E402

KERNEL = os.environ.get(f"{NAMING['envPrefix']}E2E_KERNEL_URL", "http://127.0.0.1:8000")
WS = "2d-xray"


def kernel(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(f"{KERNEL}/api/v1{path}", method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json", "X-Workspace-Id": WS})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def main() -> int:
    args = parse_args()
    seg = f"{NAMING['namespace']}.segmentation"
    display = NAMING["displayName"]
    try:
        kernel("GET", "/health")
    except Exception:  # noqa: BLE001
        print(f"SKIP kernel not reachable at {KERNEL}")
        return 0
    os.environ["AGENT_KERNEL_URL"] = KERNEL
    with tempfile.TemporaryDirectory() as data:
        agent = agent_test.start_agent(data)
        try:
            with sync_playwright() as pw:
                browser = launch(pw, args.browser, args.headed)
                st = open_studio(browser, args.port, WS)
                p = st.page
                try:
                    p.wait_for_selector("[role='toolbar'][aria-label='Annotation tools']", timeout=60000)
                    check("before: no Segment button", p.locator(f"[data-toolbar-action='{seg}.commands.segment']").count() == 0)
                    p.evaluate("() => { window.__marker = 1; }")
                    p.get_by_label(f"{display} AI panel").click()
                    consent = p.get_by_role("button", name="Turn on for this browser")
                    consent.or_(p.get_by_label(f"Message {display} AI")).first.wait_for(timeout=20000)
                    if consent.count():
                        consent.click()
                    p.get_by_label("Assistant options").click()
                    p.get_by_role("menuitemradio", name="Plugin builder").click()
                    p.keyboard.press("Escape")
                    ask(p, "Add segmentation to this workspace")
                    card = p.get_by_test_id("agent-install-approval")
                    card.wait_for(timeout=30000)
                    check("install approval card, with no one-click approve", card.get_by_role("button", name="Approve").count() == 0)
                    pending = kernel("GET", f"/workspaces/{WS}/plugins")
                    check("nothing activated before the user approves", all(x["pluginId"] != seg or x["state"] != "ACTIVATED" for x in pending["plugins"]))
                    card.get_by_test_id("open-install-review").click()
                    review = p.get_by_test_id("install-review")
                    review.wait_for(timeout=20000)
                    check("the install review shows the plan", "assets.read" in review.inner_text(), review.inner_text()[:160])
                    p.get_by_test_id("approve-install").click()
                    p.get_by_text("Segmentation is installed.").wait_for(timeout=30000)
                    check("card shows installed", "Installed" in card.inner_text(), card.inner_text()[-60:])
                    btn = p.locator(f"[data-toolbar-action='{seg}.commands.segment']")
                    btn.wait_for(timeout=60000)
                    check("Segment button appears in the same page (no reload)", p.evaluate("() => window.__marker") == 1)
                    state = {x["pluginId"]: x for x in kernel("GET", f"/workspaces/{WS}/state")["plugins"]}
                    check("activated in the kernel", state.get(seg, {}).get("state") == "ACTIVATED", str(state.get(seg)))
                    audit = kernel("GET", "/audit?limit=50")["entries"]
                    plan = next((e for e in audit if e.get("action") == "plugins.plan" and seg in str(e.get("target"))), None)
                    approved = next((e for e in audit if e.get("action") == "plugins.activated" and seg in str(e.get("target"))), None)
                    check("the agent requested it, the user approved it", bool(plan and approved) and str(plan.get("actor") or plan.get("principal")).startswith("agent:") and not str(approved.get("actor") or approved.get("principal")).startswith("agent:"), f"{plan and (plan.get('actor') or plan.get('principal'))} / {approved and (approved.get('actor') or approved.get('principal'))}")
                    errs = [e for e in st.errors if "favicon" not in e]
                    check("no console errors", not errs, str(errs[:3]))
                finally:
                    try:
                        kernel("POST", f"/workspaces/{WS}/plugins/disable", {"pluginId": seg})
                    except Exception:  # noqa: BLE001 — leave the workspace as it was, best effort
                        pass
                    p.context.close()
                    browser.close()
        finally:
            agent.terminate()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
