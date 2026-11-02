"""Smoke tests for environments built from presets only (todo phase 7), starting with
preset:generic-image: the canvas-raster renderer (no Cornerstone) with overlay2d box /
polygon / keypoint tools and COCO export, on the x-ray JPEG seed assets.

    STUDIO_E2E=1 pnpm exec vite --port 5302 --strictPort    # in apps/web
    python3 e2e/generic_test.py --port 5302 [STUDIO_ONLY=box,coco]

The project is injected into the served manifest (harness.open_studio extra_projects), and
annotations are answered with an empty fixture, so nothing in seed-data/ is read or written.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cs_helpers import Results, blob_from_exporter, check, click, close, drag, item_annotations, new_annotations, wait_for  # noqa: E402
from harness import NAMING, open_studio, parse_args, sync_playwright  # noqa: E402

# Dev-only window hooks the viewers expose (named from the naming config).
HOOK_2D = f"__{NAMING['resourcePrefix']}2d"
HOOK_RASTER = f"__{NAMING['resourcePrefix']}Raster"

SEED = Path(__file__).resolve().parents[3] / "seed-data" / "manifest.json"
DATASET = "generic-xray"
MOD = "Meta" if sys.platform == "darwin" else "Control"


def generic_project() -> dict:
    xray = next(p for p in json.loads(SEED.read_text())["projects"] if p["id"] == "2d-xray")
    return {
        "id": DATASET,
        "title": "Generic image (x-ray JPEGs)",
        "task": "detection",
        "source": "seed-data/2d-xray",
        "license": "test",
        "status": "available",
        "environment": {
            "extends": "preset:generic-image",
            "labels": [{"name": "objects", "control": "Labels", "classes": [{"id": "lesion", "color": "chart-1"}, {"id": "device", "color": "chart-2"}]}],
        },
        "assets": [{k: v for k, v in a.items() if k != "label"} for a in xray["assets"][:3]],
    }


def open_generic(browser, port):
    st = open_studio(browser, port, DATASET, extra_projects=[generic_project()], fixture_annotations=[])
    wait_for(lambda: st.page.evaluate(f"() => !!window.{HOOK_RASTER}"), "canvas-raster ready", 60)
    wait_for(lambda: st.store("s => s.projectId") == DATASET, "annotations loaded")
    time.sleep(0.4)
    return st


def img(st, x, y):
    return tuple(st.page.evaluate(f"() => window.{HOOK_RASTER}.canvasOf({x}, {y})"))


def item_id(st) -> str:
    """The open item (raster items are keyed by asset path)."""
    return st.store("s => s.env.dataKind.groupItems({ assets: " + json.dumps(generic_project()["assets"]) + " })[s.itemIndex].id")


def tool(st, key, want):
    for _ in range(4):
        st.page.mouse.move(3, 3)
        st.page.keyboard.press(key)
        time.sleep(0.2)
        if st.store("s => s.tool") == want:
            return
    raise AssertionError(f"key {key!r} did not select {want} (tool is {st.store('s => s.tool')})")


def main() -> int:
    args = parse_args()
    out = Path(args.out) / "generic"
    out.mkdir(parents=True, exist_ok=True)
    R = Results(out)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)

        def session(fn):
            def run():
                st = open_generic(browser, args.port)
                try:
                    note = fn(st, item_id(st))
                    errs = [e for e in st.errors if "favicon" not in e and "DevTools" not in e]
                    check(not errs, f"console errors: {errs[:3]}")
                    return note
                finally:
                    st.page.context.close()
            return run

        def t_env(st, item):
            env = st.store("s => ({ renderer: s.env.viewports[0].renderer.id, tools: s.env.tools.map(t => t.id), exporters: s.env.exporters.map(e => e.id) })")
            check(env["renderer"] == "studio.image2d.renderers.canvas-raster", env)
            check(env["tools"] == ["studio.core.tools.select", "studio.core.tools.pan", "studio.overlay2d.tools.box", "studio.overlay2d.tools.polygon", "studio.overlay2d.tools.keypoint"], env["tools"])
            check(env["exporters"] == ["studio.image2d.exporters.coco"], env["exporters"])
            check(st.page.evaluate(f"() => !window.{HOOK_2D} && !document.querySelector('canvas.cornerstone-canvas')"), "no Cornerstone viewport")
            check(st.page.locator("[data-testid=raster-canvas]").count() == 1, "raster canvas")
            size = st.page.evaluate(f"() => window.{HOOK_RASTER}.size")
            check(size == [1857, 1317], size)
            st.shot("load", out)
            return f"{env['renderer']}, image {size}"

        def t_box(st, item):
            before = item_annotations(st, item)
            tool(st, "r", "box")
            drag(st.page, img(st, 100, 100), img(st, 300, 250))
            a = wait_for(lambda: new_annotations(st, item, before), "box stored", 10)[0]
            g = a["geometry"]
            check(g["type"] == "box", g)
            close(g["x"], 100, 2, "x"); close(g["y"], 100, 2, "y"); close(g["w"], 200, 3, "w"); close(g["h"], 150, 3, "h")
            check(a["label"] == "lesion", a["label"])
            st.shot("box", out)
            return f"box {g}"

        def t_polygon(st, item):
            before = item_annotations(st, item)
            tool(st, "p", "polygon")
            pts = [(400, 400), (700, 420), (650, 700), (420, 650)]
            for p in pts:
                click(st.page, img(st, *p)); time.sleep(0.1)
            # Backspace drops the last vertex while drawing; Enter closes.
            click(st.page, img(st, 900, 900)); time.sleep(0.1)
            st.page.keyboard.press("Backspace")
            check(len(st.page.evaluate(f"() => window.{HOOK_RASTER}.draft().points")) == 4, "Backspace removed a vertex")
            st.page.keyboard.press("Enter")
            g = wait_for(lambda: new_annotations(st, item, before), "polygon stored", 10)[0]["geometry"]
            check(g["type"] == "polygon" and len(g["points"]) == 4, g)
            for (x, y), (gx, gy) in zip(pts, g["points"]):
                close(gx, x, 2, "vx"); close(gy, y, 2, "vy")
            # Escape abandons a polygon in progress.
            click(st.page, img(st, 1000, 1000)); click(st.page, img(st, 1100, 1000))
            st.page.keyboard.press("Escape")
            check(st.page.evaluate(f"() => window.{HOOK_RASTER}.draft()") is None, "Escape cancels the draft")
            check(len(new_annotations(st, item, before)) == 1, "cancelled polygon not stored")
            return "4-vertex polygon via Enter; Backspace and Escape"

        def t_keypoint(st, item):
            before = item_annotations(st, item)
            tool(st, "k", "keypoint")
            click(st.page, img(st, 900, 600))
            g = wait_for(lambda: new_annotations(st, item, before), "keypoint stored", 10)[0]["geometry"]
            check(g["type"] == "keypoint", g)
            close(g["x"], 900, 2, "x"); close(g["y"], 600, 2, "y")
            return f"keypoint ({g['x']}, {g['y']})"

        def t_edit(st, item):
            tool(st, "r", "box")
            drag(st.page, img(st, 100, 100), img(st, 300, 250))
            box = wait_for(lambda: item_annotations(st, item), "box", 10)[0]
            tool(st, "v", "select")
            # Move: drag the body by (50, 40) image px.
            drag(st.page, img(st, 200, 175), img(st, 250, 215))
            g = wait_for(lambda: (lambda a: a["geometry"] if a.get("updatedAt") else None)(item_annotations(st, item)[0]), "moved", 10)
            close(g["x"], 150, 2, "moved x"); close(g["y"], 140, 2, "moved y"); close(g["w"], 200, 2, "w kept")
            check(st.store("s => s.selectedIds") == [box["id"]], "moved box is selected")
            # Resize: drag the bottom-right handle out by (60, 30).
            drag(st.page, img(st, 350, 290), img(st, 410, 320))
            g = wait_for(lambda: (lambda g: g if g["w"] > 230 else None)(item_annotations(st, item)[0]["geometry"]), "resized", 10)
            close(g["w"], 260, 2, "w"); close(g["h"], 180, 2, "h"); close(g["x"], 150, 1, "x unchanged")
            check(st.store("s => s.past.length") == 3, f"create, move, resize = 3 undo steps ({st.store('s => s.past.length')})")
            # Delete through the core command, then undo.
            st.page.mouse.move(5, 5)
            st.page.keyboard.press("Delete")
            wait_for(lambda: not item_annotations(st, item), "deleted", 10)
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: item_annotations(st, item), "undo restores", 10)
            # Clicking empty image clears the selection; shift-click adds.
            click(st.page, img(st, 1500, 1200))
            wait_for(lambda: st.store("s => s.selectedIds") == [], "deselect")
            click(st.page, img(st, 200, 200), ["Shift"])
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 1, "shift-click selects")
            st.shot("edit", out)
            return f"moved, resized to {g['w']}×{g['h']}, deleted, undone"

        def t_view(st, item):
            c0 = st.page.evaluate(f"() => window.{HOOK_RASTER}.camera()")
            p = img(st, 900, 600)
            st.page.mouse.move(*p)
            st.page.mouse.wheel(0, -400)
            time.sleep(0.3)
            c1 = st.page.evaluate(f"() => window.{HOOK_RASTER}.camera()")
            check(c1["scale"] > c0["scale"] * 1.2, f"wheel zooms {c0} → {c1}")
            q = img(st, 900, 600)
            close(q[0], p[0], 1.5, "zoom keeps the cursor point x"); close(q[1], p[1], 1.5, "zoom keeps the cursor point y")
            tool(st, "h", "pan")
            drag(st.page, p, (p[0] + 120, p[1] + 60))
            c2 = st.page.evaluate(f"() => window.{HOOK_RASTER}.camera()")
            close(c2["tx"] - c1["tx"], 120, 2, "pan x"); close(c2["ty"] - c1["ty"], 60, 2, "pan y")
            # Space-drag pans with a drawing tool and draws nothing.
            tool(st, "r", "box")
            st.page.keyboard.down("Space")
            drag(st.page, p, (p[0] - 100, p[1]))
            st.page.keyboard.up("Space")
            c3 = st.page.evaluate(f"() => window.{HOOK_RASTER}.camera()")
            close(c3["tx"] - c2["tx"], -100, 2, "space pan")
            check(not item_annotations(st, item), "space-drag draws nothing")
            st.page.mouse.move(5, 5)
            st.page.keyboard.press("0")
            time.sleep(0.2)
            c4 = st.page.evaluate(f"() => window.{HOOK_RASTER}.camera()")
            close(c4["scale"], c0["scale"], 1e-6, "fit (0) restores the scale")
            return f"zoom {c0['scale']:.3f}→{c1['scale']:.3f}, pan, space-pan, fit"

        def t_coco(st, item):
            tool(st, "r", "box")
            drag(st.page, img(st, 100, 100), img(st, 300, 250))
            tool(st, "p", "polygon")
            for p in [(400, 400), (700, 420), (650, 700), (400, 400)]:
                click(st.page, img(st, *p)); time.sleep(0.1)
            tool(st, "k", "keypoint")
            click(st.page, img(st, 900, 600))
            wait_for(lambda: len(item_annotations(st, item)) == 3, "3 annotations", 10)
            doc = json.loads(blob_from_exporter(st, "studio.image2d.exporters.coco"))
            (out / "coco.json").write_text(json.dumps(doc, indent=2))
            im = next(i for i in doc["images"] if i["file_name"] == item)
            check((im["width"], im["height"]) == (1857, 1317), im)
            anns = [a for a in doc["annotations"] if a["image_id"] == im["id"]]
            box = next(a for a in anns if a.get("bbox") and not a.get("segmentation") and not a.get("keypoints"))
            check(all(abs(a - b) <= 3 for a, b in zip(box["bbox"], [100, 100, 200, 150])), box["bbox"])
            check(sum(1 for a in anns if a.get("segmentation")) == 1 and sum(1 for a in anns if a.get("keypoints")) == 1, anns)
            check([c["name"] for c in doc["categories"]] == ["lesion", "device"], doc["categories"])
            return f"{len(anns)} COCO annotations on {item}"

        for name, fn in [("environment from preset", t_env), ("box (R)", t_box), ("polygon (P)", t_polygon), ("keypoint (K)", t_keypoint), ("select / move / resize / delete", t_edit), ("wheel / pan / space / fit", t_view), ("COCO export", t_coco)]:
            R.run(name, session(fn))

        browser.close()
    return R.summary()


if __name__ == "__main__":
    raise SystemExit(main())
