"""Browser steps of the local harness (todo23 W5/W10): interaction smoke, accessibility snapshot,
screenshots in light and dark at two viewport sizes. Run by tools/harness/harness.mjs with
`uv run --no-project --with playwright python tools/harness/drive.py <step> --port P --project ID --out DIR`.

Prints one JSON object: {"status": "pass"|"fail"|"skip", "details": {...}}. Never reads seed-data/:
the frozen dev server serves the harness's temp seed folder (STUDIO_WEB_SEED_DIR).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

STORE = "/src/studio/stores/studio.ts"
BROKEN = ["studio-crashed", "env-errors", "error-view", "route-error", "setup-errors"]
SIZES = [(1440, 900), (1024, 768)]


def _state(page):
    return page.evaluate(
        f"async () => {{ const m = await import('{STORE}'); const s = m.useStudio.getState(); return {{ projectId: s.projectId ?? null, env: !!s.env }}; }}"
    )


def open_project(browser, port: int, project: str, *, size=(1440, 900), scheme="light", timeout_s=60):
    ctx = browser.new_context(viewport={"width": size[0], "height": size[1]}, color_scheme=scheme)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    # Annotation saves never reach disk.
    page.route("**/api/annotations/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"revision": 1, "annotations": []})))
    page.goto(f"http://localhost:{port}/projects/{project}/studio/{project}")
    deadline = time.time() + timeout_s
    state, broken = {}, []
    while time.time() < deadline:
        broken = [t for t in BROKEN if page.locator(f'[data-testid="{t}"]').count()]
        try:
            state = _state(page)
        except Exception as e:  # page still loading
            state = {"error": str(e)[:200]}
        if broken or (state.get("projectId") == project and state.get("env")):
            break
        time.sleep(0.5)
    time.sleep(1.0)  # let the renderer paint
    broken = [t for t in BROKEN if page.locator(f'[data-testid="{t}"]').count()]
    return ctx, page, {"state": state, "broken": broken, "errors": errors}


def smoke(browser, args) -> dict:
    ctx, page, info = open_project(browser, args.port, args.project)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    shot = out / "smoke.png"
    page.screenshot(path=str(shot))
    if not info["broken"] and info["state"].get("env"):
        # Minimal interaction: move over the canvas, press undo, and check nothing threw.
        page.mouse.move(700, 450)
        page.keyboard.press("Meta+z" if sys.platform == "darwin" else "Control+z")
        time.sleep(0.3)
    ok = not info["broken"] and bool(info["state"].get("env")) and info["state"].get("projectId") == args.project and not [e for e in info["errors"] if "Error" in e]
    ctx.close()
    return {"status": "pass" if ok else "fail", "details": {**info, "errors": info["errors"][:10], "screenshot": str(shot)}}


def a11y(browser, args) -> dict:
    ctx, page, info = open_project(browser, args.port, args.project)
    if info["broken"] or not info["state"].get("env"):
        ctx.close()
        return {"status": "skip", "details": {"reason": "the Studio didn't load", **info}}
    snap = page.locator("body").aria_snapshot()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "aria-snapshot.yaml").write_text(snap)
    # Cheap structural checks in place of axe (not installed offline): unnamed buttons and images without alt.
    unnamed = page.evaluate(
        """() => [...document.querySelectorAll('button')].filter(b => !(b.getAttribute('aria-label') || b.textContent.trim() || b.getAttribute('title') || b.getAttribute('aria-labelledby'))).length"""
    )
    no_alt = page.evaluate("() => [...document.querySelectorAll('img:not([alt])')].length")
    ctx.close()
    return {
        "status": "pass" if unnamed == 0 and no_alt == 0 else "fail",
        "details": {"axe": "skipped: axe-core isn't available offline", "snapshot": str(out / "aria-snapshot.yaml"), "unnamedButtons": unnamed, "imagesWithoutAlt": no_alt},
    }


def screenshots(browser, args) -> dict:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    shots, problems = [], []
    for scheme in ("light", "dark"):
        for size in SIZES:
            ctx, page, info = open_project(browser, args.port, args.project, size=size, scheme=scheme)
            # The Studio's theme follows its own preference; force the class too.
            page.evaluate(f"() => document.documentElement.classList.toggle('dark', {'true' if scheme == 'dark' else 'false'})")
            time.sleep(0.3)
            path = out / f"{scheme}-{size[0]}x{size[1]}.png"
            page.screenshot(path=str(path))
            shots.append(str(path))
            if info["broken"] or not info["state"].get("env"):
                problems.append(f"{path.name}: Studio not loaded ({info['broken'] or info['state']})")
            ctx.close()
    return {"status": "fail" if problems else "pass", "details": {"screenshots": shots, "problems": problems}}


STEPS = {"smoke": smoke, "a11y": a11y, "screenshots": screenshots}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("step", choices=sorted(STEPS))
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"status": "skip", "details": {"reason": "playwright isn't installed"}}))
        return 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            result = STEPS[args.step](browser, args)
        except Exception as e:
            result = {"status": "fail", "details": {"error": f"{type(e).__name__}: {e}"[:1000]}}
        browser.close()
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
