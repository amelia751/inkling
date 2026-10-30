"""todo2 Phase 6 exit (docs/plugins.md Phase 1): "Add segmentation" through the install
dialog activates the toolbar, masks come back from the mock provider through a real worker,
and no web deploy or reload was needed.

Needs the kernel and a worker (apps/api/README.md); the dev server runs with the kernel
proxy on:

    <envPrefix>KERNEL=1 <envPrefix>E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/plugins_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

# The browser harness lives with the web-only tests (apps/web/e2e).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))

from harness import NAMING, launch, open_studio, parse_args, sync_playwright  # noqa: E402

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


def main() -> int:
    args = parse_args()
    ns = NAMING["namespace"]
    seg = f"{ns}.segmentation"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        st = open_studio(browser, args.port, "2d-xray")
        p = st.page
        try:
            kernel = p.evaluate("async () => (await fetch('/api/v1/health')).ok")
            if not kernel:
                print("SKIP kernel not reachable through the dev server proxy")
                return 0
            p.wait_for_selector("[role='toolbar'][aria-label='Annotation tools']", timeout=60000)
            check("before: no Segment button", p.locator(f"[data-toolbar-action='{seg}.commands.segment']").count() == 0)
            # Install through the UI, in the same tab: no deploy, no reload.
            p.evaluate("() => { window.__marker = 1; }")
            p.get_by_role("link", name="Plugins").first.click()
            p.wait_for_selector(f"[data-registry-plugin='{seg}']", timeout=30000)
            p.get_by_test_id(f"install-{seg}").click()
            p.wait_for_selector("[data-testid='install-review']", timeout=30000)
            review = p.inner_text("[data-testid='install-review']")
            check("install review shows permissions, egress and licences", "assets.read" in review and "api.meta.ai" in review and "Apache-2.0" in review, review[:200])
            p.get_by_test_id("approve-install").click()
            wait(lambda: p.locator(f"[data-plugin='{seg}']").count() > 0, 30)
            check("installed in this workspace", p.locator(f"[data-plugin='{seg}']").count() == 1)
            p.get_by_role("link", name="Back to annotating").click()
            btn = p.locator(f"[data-toolbar-action='{seg}.commands.segment']")
            btn.wait_for(timeout=60000)
            check("after: Segment button in the image toolbar, same page (no reload)", p.evaluate("() => window.__marker") == 1)
            before = st.store("s => s.annotations.filter(a => a.geometry.type === 'mask').length")
            btn.click()
            masks = wait(lambda: (lambda n: n if n > before else None)(st.store("s => s.annotations.filter(a => a.geometry.type === 'mask').length")), 120)
            check("masks from the mock provider through a worker", bool(masks), f"{masks} masks")
            m = st.store("s => s.annotations.filter(a => a.geometry.type === 'mask').map(a => ({ prov: a.provenance, provider: a.attributes?.provider, review: a.attributes?.review_status }))[0]")
            check("canonical provenance", m == {"prov": "ai-suggested", "provider": "mock", "review": "pending"}, str(m))
            panel = p.locator("[data-testid='mask-review']")
            panel.wait_for(timeout=30000)
            p.locator("[data-testid='mask-review'] button[aria-label^='Accept']").first.click()
            accepted = wait(lambda: st.store("s => s.annotations.some(a => a.attributes?.review_status === 'accepted')"), 10)
            check("mask review: accept", bool(accepted))
            st.shot("segmentation", Path(args.out) / "plugins")
            errs = [e for e in st.errors if "favicon" not in e]
            check("no console errors", not errs, str(errs[:3]))
        finally:
            # Leave the workspace as it was.
            p.evaluate(f"async () => fetch('/api/v1/workspaces/2d-xray/plugins/disable', {{ method: 'POST', headers: {{ 'Content-Type': 'application/json', 'X-Workspace-Id': '2d-xray' }}, body: JSON.stringify({{ pluginId: '{seg}' }}) }})")
            p.context.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
