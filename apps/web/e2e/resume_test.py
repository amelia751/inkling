"""Resume (todo6 D9, Phase 7) in seed mode: the Studio writes where you are (task, item, slice or
frame, tool) as you work, and returns to the same item, slice and tool after a reload and from
Overview's "Open Studio". A plain link to the task doesn't restore.

    python3 e2e/resume_test.py --port 5207

Covers a 3D volume (item + axial slice + tool) and the 4D cine (slice + frame + tool). The e2e
server keeps resume state in a temp folder, so nothing here touches seed-data/.resume.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import RUNTIME, STORE, launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def store(page, expr: str):
    return page.evaluate(f"async () => {{ const m = await import('{STORE}'); return ({expr})(m.useStudio.getState()); }}")


def runtime(page, key: str):
    """The value the mounted renderer published under `key` for the current item."""
    return page.evaluate(
        f"""async () => {{
          const r = await import('{RUNTIME}');
          const values = r.runtimeStore.getState().values;
          const hits = Object.values(values).map((v) => v['{key}']).filter((v) => v !== undefined);
          return hits.length ? hits[hits.length - 1] : null;
        }}"""
    )


def wait_for(fn, what: str, timeout: float = 30):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError(f"timed out waiting for {what}")


def saved_resume(page, base: str, project: str):
    return page.evaluate(f"async () => (await (await fetch('{base}/api/v1/projects/{project}/resume')).json()).resume")


def open_viewer(page):
    page.wait_for_selector("main[aria-label='Viewer']", timeout=30000)


# ---- 3D volume: item, axial slice and tool -------------------------------------------------


def axial(page):
    v = runtime(page, "viewportState")
    return (v or {}).get("slices", {}).get("axial")


def volume_ready(page):
    return wait_for(lambda: page.locator("[data-testid=plane-axial] canvas").count() > 0 and axial(page) is not None, "the axial plane", 60)


def volume(browser, base: str) -> None:
    project = "3d-brain-mri"
    studio = f"{base}/projects/{project}/studio/{project}"
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/api/annotations/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({**json.loads(r.request.post_data or "{}"), "revision": 2})) if r.request.method == "PUT" else r.continue_())

    page.goto(studio)
    open_viewer(page)
    store(page, "s => s.setItemIndex(1)")
    volume_ready(page)
    page.wait_for_timeout(500)
    store(page, "s => s.setTool('brush')")
    box = page.locator("[data-testid=plane-axial]").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    start = axial(page)
    for _ in range(9):
        page.keyboard.press("ArrowUp")
    page.wait_for_timeout(300)
    slice_ = axial(page)
    check("the axial slice moved", slice_ is not None and slice_ != start, f"{start} → {slice_}")
    page.mouse.move(3, 3)
    wait_for(lambda: (lambda r: r and r.get("placement", {}).get("slice") == slice_ and r.get("tool") == "brush")(saved_resume(page, base, project)), "the resume write", 10)
    r = saved_resume(page, base, project)
    check("resume is written (debounced) with item, plane, slice and tool", r["itemId"] == "BraTS2021_00621" and r["placement"] == {"plane": "axial", "slice": slice_} and r["tool"] == "brush", json.dumps(r))

    page.reload()
    open_viewer(page)
    wait_for(lambda: store(page, "s => s.itemIndex") == 1, "the restored item", 30)
    volume_ready(page)
    wait_for(lambda: axial(page) == slice_, f"axial slice {slice_} after reload", 20)
    check("reload restores the item", store(page, "s => s.itemIndex") == 1)
    check("reload restores the axial slice", axial(page) == slice_, f"{axial(page)} (want {slice_})")
    check("reload restores the tool", store(page, "s => s.tool") == "brush", store(page, "s => s.tool"))

    # From Overview (a fresh page load, so nothing is left in the store).
    page.goto(f"{base}/projects/{project}/overview")
    page.wait_for_selector("[data-testid=resume-card] [data-testid=open-studio]", timeout=20000)
    check("Overview's resume card names the item", "BraTS2021_00621" in page.locator("[data-testid=resume-item]").inner_text(), page.locator("[data-testid=resume-item]").inner_text())
    page.locator("[data-testid=resume-card] [data-testid=open-studio]").click()
    open_viewer(page)
    wait_for(lambda: store(page, "s => s.itemIndex") == 1, "the item from Overview", 30)
    volume_ready(page)
    wait_for(lambda: axial(page) == slice_, f"axial slice {slice_} from Overview", 20)
    check("Open Studio restores item, slice and tool", store(page, "s => [s.itemIndex, s.tool]") == [1, "brush"] and axial(page) == slice_, f"{store(page, 's => [s.itemIndex, s.tool]')} slice {axial(page)}")

    # A plain link to the task (a fresh tab) opens at the start, not where you left off.
    plain = ctx.new_page()
    plain.goto(studio)
    open_viewer(plain)
    plain.wait_for_timeout(2500)
    check("a plain link doesn't restore", store(plain, "s => s.itemIndex") == 0, str(store(plain, "s => s.itemIndex")))
    check("no page errors (volume)", not errors, "; ".join(errors[:3]))
    ctx.close()


# ---- 4D cine: slice, frame and tool ----------------------------------------------------------


def cine_view(page):
    raw = page.locator("[data-testid=cine-canvas]").get_attribute("data-view") if page.locator("[data-testid=cine-canvas]").count() else None
    return json.loads(raw) if raw else None


def cine(browser, base: str) -> None:
    project = "4d-cardiac"
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/api/annotations/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({**json.loads(r.request.post_data or "{}"), "revision": 2})) if r.request.method == "PUT" else r.continue_())

    page.goto(f"{base}/projects/{project}/studio/{project}")
    open_viewer(page)
    v0 = wait_for(lambda: cine_view(page), "the cine canvas", 60)
    tools = store(page, "s => s.env.tools.map((t) => t.name)")
    want_tool = next((t for t in ("brush", "polygon", "spline") if t in tools), tools[-1])
    store(page, f"s => s.setTool('{want_tool}')")
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.locator("[data-testid=cine-canvas]").hover()
    for _ in range(3):
        page.keyboard.press("ArrowRight")
    for _ in range(2):
        page.keyboard.press("ArrowUp")
    page.wait_for_timeout(300)
    v = cine_view(page)
    want = (v["slice"], v["frame"])
    check("moved to another slice and frame", want != (v0["slice"], v0["frame"]), f"{(v0['slice'], v0['frame'])} → {want}")
    page.mouse.move(3, 3)
    wait_for(lambda: (lambda r: r and r.get("placement") == {"frame": want[1], "slice": want[0]} and r.get("tool") == want_tool)(saved_resume(page, base, project)), "the resume write", 10)
    check("resume is written with slice, frame and tool", True, json.dumps(saved_resume(page, base, project)))

    page.reload()
    open_viewer(page)
    wait_for(lambda: (lambda x: x and (x["slice"], x["frame"]) == want)(cine_view(page)), f"slice/frame {want} after reload", 30)
    check("reload restores slice and frame", (cine_view(page)["slice"], cine_view(page)["frame"]) == want)
    check("reload restores the tool", store(page, "s => s.tool") == want_tool, store(page, "s => s.tool"))
    status = page.get_by_test_id("viewer-status").inner_text()
    check("the cine's status shows mm only with its declared spacing", "1.56×1.56×10.0 mm" in status, status)
    check("no page errors (cine)", not errors, "; ".join(errors[:3]))
    ctx.close()


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        for name, fn in (("volume", volume), ("cine", cine)):
            try:
                fn(browser, base)
            except Exception as e:  # noqa: BLE001
                check(f"{name} scenario ran", False, repr(e))
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
