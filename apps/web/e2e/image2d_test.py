"""End-to-end tests for the Cornerstone 2D viewer (chest X-ray JPEGs + a synthetic DICOM DX).

    pnpm exec vite --port 5181 --strictPort          # in apps/web
    INKLING_DICOM_DIR=… python3 e2e/image2d_test.py --port 5181

Every gesture is real mouse / keyboard input. Saves are intercepted by harness.open_studio,
so seed-data/.annotations is never modified.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cs_helpers import (  # noqa: E402
    Results,
    open_with_fixtures,
    button,
    blob_from_exporter,
    check,
    click,
    close,
    drag,
    ensure_dicom_fixtures,
    item_annotations,
    masks,
    new_annotations,
    validate_dicom,
    wait_for,
)
from harness import open_studio, parse_args, sync_playwright  # noqa: E402

ITEM = "2d-xray/normal/IM-0001-0001.jpeg"
BOX1 = {"x": 469.11, "y": 291.83, "w": 162.8, "h": 157.41}
BOX2 = {"x": 896.47, "y": 269.62, "w": 262.85, "h": 530.56}
MOD = "Meta" if sys.platform == "darwin" else "Control"


def open_2d(browser, port, dataset="2d-xray", **kw):
    st = open_with_fixtures(open_studio, browser, port, dataset, kw["fixtures"], kw["extra_projects"]) if kw.get("fixtures") else open_studio(browser, port, dataset, **kw)
    wait_for(lambda: st.page.evaluate("() => !!window.__inkling2d"), "2D viewer ready", 90)
    wait_for(lambda: st.store("s => s.projectId") == dataset, "annotations loaded")
    time.sleep(0.8)
    return st


def img(st, x, y):
    return tuple(st.page.evaluate(f"() => window.__inkling2d.canvasOf({x}, {y})"))


def props(st):
    return st.page.evaluate("() => window.__inkling2d.props()")


KEY_TOOL = {"v": "select", "h": "pan", "z": "zoom", "w": "windowLevel", "c": "crosshairs", "r": "box", "o": "ellipse", "p": "polygon",
            "f": "freehand", "k": "KEYPOINT", "l": "length", "a": "angle", "j": "cobb", "d": "bidirectional", "i": "probe", "x": "arrow",
            "b": "brush", "e": "eraser", "g": "wand"}


def tool(st, key):
    """Pick a tool with its keyboard shortcut (retrying if the first key lands before focus settles)."""
    want = KEY_TOOL[key].replace("KEYPOINT", "keypoint")
    for attempt in range(4):
        st.page.mouse.move(3, 3)
        st.page.keyboard.press(key)
        time.sleep(0.25)
        if st.store("s => s.tool") == want:
            # Let React commit and the viewer rebind Cornerstone's primary tool before the next gesture.
            st.page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))))")
            if attempt:
                print(f"  note: key {key!r} needed {attempt + 1} presses", flush=True)
            return
    raise AssertionError(f"key {key!r} did not select {want} (tool is {st.store('s => s.tool')})")


def only_new(st, before, item=ITEM, n=1):
    added = wait_for(lambda: (lambda x: x if len(x) >= n else None)(new_annotations(st, item, before)), f"{n} new annotation(s)", 10)
    return added


def main() -> int:
    args = parse_args()
    out = Path(args.out) / "image2d"
    out.mkdir(parents=True, exist_ok=True)
    dicom_dir = Path(os.environ.get("INKLING_DICOM_DIR", str(Path(args.out) / "dicom")))
    R = Results(out)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed, args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"])

        def session(fn, dataset="2d-xray", **kw):
            def run():
                st = open_2d(browser, args.port, dataset, **kw)
                try:
                    note = fn(st)
                    check(not st.saves or all(isinstance(s, dict) for s in st.saves), "saves intercepted")
                    errs = [e for e in st.errors if "favicon" not in e and "DevTools" not in e]
                    check(not errs, f"console errors: {errs[:3]}")
                    return note
                finally:
                    st.page.context.close()
            return run

        # ------------------------------------------------------------ load
        def t_load(st):
            anns = item_annotations(st, ITEM)
            boxes = [a for a in anns if a["geometry"]["type"] == "box"]
            check(len(boxes) == 5, f"expected 5 legacy boxes, got {len(boxes)}")
            time.sleep(2)
            check(st.store("s => s.past.length") == 0 and not st.store("s => s.dirty"), "loading must not edit annotations")
            n_svg = st.page.evaluate("() => document.querySelectorAll('[data-testid=image-canvas] svg rect, [data-testid=image-canvas] svg path').length")
            check(n_svg >= 5, f"boxes not drawn (svg shapes: {n_svg})")
            st.shot("load", out)
            return f"5 boxes drawn, {n_svg} svg shapes, no writes"

        R.run("load + legacy boxes", session(t_load))

        # ------------------------------------------------------------ shapes
        def t_box(st):
            before = item_annotations(st, ITEM)
            tool(st, "r")
            drag(st.page, img(st, 150, 1000), img(st, 350, 1150))
            a = only_new(st, before)[0]
            g = a["geometry"]
            check(g["type"] == "box", g)
            close(g["x"], 150, 3, "x"); close(g["y"], 1000, 3, "y"); close(g["w"], 200, 4, "w"); close(g["h"], 150, 4, "h")
            check(a["label"] == st.store("s => s.activeLabel"), "label = active label")
            return f"box {g}"

        def t_ellipse(st):
            before = item_annotations(st, ITEM)
            tool(st, "o")
            drag(st.page, img(st, 600, 1050), img(st, 700, 1120))
            g = only_new(st, before)[0]["geometry"]
            check(g["type"] == "ellipse" and g["rx"] > 20 and g["ry"] > 20, g)
            check(abs(g["cx"] - 650) < 60 and abs(g["cy"] - 1085) < 60, f"centre {g}")
            return f"ellipse c=({g['cx']:.0f},{g['cy']:.0f}) r=({g['rx']:.0f},{g['ry']:.0f})"

        def t_polygon(st):
            before = item_annotations(st, ITEM)
            tool(st, "p")
            pts = [(200, 1000), (400, 980), (420, 1200), (180, 1180)]
            for p in pts:
                click(st.page, img(st, *p))
                time.sleep(0.15)
            click(st.page, img(st, *pts[0]))
            g = only_new(st, before)[0]["geometry"]
            check(g["type"] == "polygon" and len(g["points"]) == 4, g)
            for (x, y), (gx, gy) in zip(pts, g["points"]):
                close(gx, x, 3, "vx"); close(gy, y, 3, "vy")
            return "4-vertex polygon"

        def t_freehand(st):
            before = item_annotations(st, ITEM)
            tool(st, "f")
            c = (1550, 1080)
            start = img(st, c[0] + 80, c[1])
            st.page.mouse.move(*start)
            st.page.mouse.down()
            for k in range(1, 49):
                t = k / 48 * 2 * math.pi
                st.page.mouse.move(*img(st, c[0] + 80 * math.cos(t), c[1] + 80 * math.sin(t)))
            st.page.mouse.up()
            g = only_new(st, before)[0]["geometry"]
            check(g["type"] == "measurement" and g["kind"] == "freehand-roi", g["type"])
            area = g["stats"].get("area", 0)
            close(area, math.pi * 80 * 80, math.pi * 80 * 80 * 0.1, "freehand area px²")
            return f"{len(g['points'])} pts, area {area:.0f} px² (πr² = {math.pi * 6400:.0f})"

        def t_keypoint(st):
            before = item_annotations(st, ITEM)
            tool(st, "k")
            click(st.page, img(st, 900, 1100))
            g = only_new(st, before)[0]["geometry"]
            check(g["type"] == "keypoint", g)
            close(g["x"], 900, 2, "x"); close(g["y"], 1100, 2, "y")
            return f"keypoint ({g['x']}, {g['y']})"

        for name, fn in [("box (R)", t_box), ("ellipse (O)", t_ellipse), ("polygon (P)", t_polygon), ("freehand (F)", t_freehand), ("keypoint (K)", t_keypoint)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ measurements
        def t_length(st):
            before = item_annotations(st, ITEM)
            tool(st, "l")
            drag(st.page, img(st, 500, 1050), img(st, 800, 1050))
            g = only_new(st, before)[0]["geometry"]
            check(g["kind"] == "length" and g["unit"] == "px", g)
            close(g["stats"]["length"], 300, 3, "length px")
            return f"length {g['stats']['length']} {g['unit']}"

        def t_angle(st):
            before = item_annotations(st, ITEM)
            tool(st, "a")
            for p in [(500, 1000), (500, 1150), (700, 1150)]:
                click(st.page, img(st, *p))
                time.sleep(0.15)
            g = only_new(st, before)[0]["geometry"]
            check(g["kind"] == "angle", g)
            close(g["stats"]["angle"], 90, 2, "angle")
            return f"angle {g['stats']['angle']}°"

        def t_cobb(st):
            before = item_annotations(st, ITEM)
            tool(st, "j")
            drag(st.page, img(st, 300, 1000), img(st, 600, 1000))
            time.sleep(0.2)
            dx, dy = 300 * math.cos(math.radians(30)), 300 * math.sin(math.radians(30))
            drag(st.page, img(st, 300, 1200), img(st, 300 + dx, 1200 - dy))
            g = only_new(st, before)[0]["geometry"]
            check(g["kind"] == "cobb" and len(g["points"]) == 4, g)
            close(g["stats"]["angle"], 30, 2, "cobb angle")
            return f"cobb {g['stats']['angle']}°"

        def t_bidirectional(st):
            before = item_annotations(st, ITEM)
            tool(st, "d")
            drag(st.page, img(st, 1300, 1000), img(st, 1500, 1000))
            g = only_new(st, before)[0]["geometry"]
            check(g["kind"] == "bidirectional" and len(g["points"]) == 4, g)
            close(g["stats"]["length"], 200, 3, "long axis")
            check(g["stats"].get("width", 0) > 0, f"short axis {g['stats']}")
            return f"long {g['stats']['length']} short {g['stats']['width']} px"

        def t_probe(st):
            before = item_annotations(st, ITEM)
            tool(st, "i")
            p = img(st, 930, 760)
            st.page.mouse.move(*p)
            time.sleep(0.3)
            readout = st.store("s => s.viewerStatus")
            click(st.page, p)
            g = only_new(st, before)[0]["geometry"]
            check(g["kind"] == "probe", g)
            value = g["stats"].get("value")
            check(value is not None and f"= {int(value)}" in readout, f"probe {value} vs status '{readout}'")
            return f"probe value {value} matches readout"

        def t_arrow(st):
            before = item_annotations(st, ITEM)
            tool(st, "x")
            drag(st.page, img(st, 1000, 1000), img(st, 1100, 1100))
            st.page.wait_for_selector("input[placeholder='Arrow note…']", timeout=5000)
            st.page.keyboard.type("consolidation")
            st.page.keyboard.press("Enter")
            g = only_new(st, before)[0]["geometry"]
            check(g["kind"] == "arrow" and g.get("text") == "consolidation", g)
            return "arrow with note"

        for name, fn in [("length (L) px calibration", t_length), ("angle (A)", t_angle), ("cobb (J)", t_cobb), ("bidirectional (D)", t_bidirectional), ("probe (I) value", t_probe), ("arrow (X) + note", t_arrow)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ masks
        def t_masks(st):
            label = st.store("s => s.activeLabel")
            tool(st, "b")
            drag(st.page, img(st, 300, 1050), img(st, 600, 1060), steps=15)
            m1 = wait_for(lambda: masks(st, ITEM).get(label), "brush mask", 10)
            tool(st, "e")
            drag(st.page, img(st, 400, 1052), img(st, 500, 1058), steps=10)
            m2 = wait_for(lambda: (lambda v: v if v and v < m1 else None)(masks(st, ITEM).get(label)), "eraser reduces mask", 10)
            tool(st, "g")
            click(st.page, img(st, 700, 600))  # lung field
            m3 = wait_for(lambda: (lambda v: v if v and v > m2 else None)(masks(st, ITEM).get(label)), "wand adds to mask", 10)
            button(st.page, "Smart fill").click()
            click(st.page, img(st, 1300, 650))
            m4 = wait_for(lambda: (lambda v: v if v and v > m3 else None)(masks(st, ITEM).get(label)), "smart fill adds to mask", 10)
            st.shot("masks", out)
            mask = next(a for a in item_annotations(st, ITEM) if a["geometry"]["type"] == "mask")
            check(mask["geometry"]["dims"] == [1857, 1317], mask["geometry"]["dims"])
            check(sum(mask["geometry"]["counts"]) == 1857 * 1317, "RLE covers the grid")
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: masks(st, ITEM).get(label) == m3, "undo smart fill", 10)
            # Remove islands keeps one component.
            button(st.page, "Remove islands").click()
            m5 = wait_for(lambda: (lambda v: v if v and v < m3 else None)(masks(st, ITEM).get(label)), "islands removed", 10)
            return f"brush {m1} → eraser {m2} → wand {m3} → smart {m4} px; undo; islands → {m5}"

        R.run("brush/eraser/wand/smart fill/islands", session(t_masks))

        # ------------------------------------------------------------ navigation tools
        def t_nav(st):
            c = img(st, 700, 1000)  # clear of the legacy boxes
            p0 = props(st)
            tool(st, "w")
            drag(st.page, c, (c[0] + 120, c[1] + 60))
            p1 = props(st)
            check(p1["voi"] != p0["voi"], "W/L drag changes the window")
            tool(st, "z")
            drag(st.page, c, (c[0], c[1] - 150))
            p2 = props(st)
            check(abs(p2["zoom"] - p1["zoom"]) > 0.1, f"zoom {p1['zoom']} → {p2['zoom']}")
            tool(st, "h")
            bb = st.page.locator("[data-testid=image-canvas]").bounding_box()
            mid = (bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
            drag(st.page, mid, (mid[0] + 150, mid[1] + 80))
            p3 = props(st)
            check(p3["pan"] != p2["pan"] or p3["focal"] != p2["focal"], f"pan drag moves the image {p2['pan']} {p3['pan']} {p2['focal']} {p3['focal']}")
            check(st.store("s => s.past.length") == 0, "navigation creates no annotations")
            # Mouse wheel zooms in 2D.
            st.page.mouse.move(*c)
            st.page.mouse.wheel(0, -400)
            time.sleep(0.4)
            p4 = props(st)
            check(abs(p4["zoom"] - p3["zoom"]) > 0.01, f"wheel zoom {p3['zoom']} -> {p4['zoom']}")
            return f"voi {p0['voi']}→{p1['voi']}, zoom {p1['zoom']:.2f}→{p2['zoom']:.2f}→{p4['zoom']:.2f}"

        R.run("W/L, zoom, pan, wheel", session(t_nav))

        # ------------------------------------------------------------ editing / selection
        def t_handle(st):
            tool(st, "v")
            br = img(st, BOX1["x"] + BOX1["w"], BOX1["y"] + BOX1["h"])
            st.page.mouse.move(br[0] - 20, br[1] - 20)
            st.page.mouse.move(*br, steps=4)
            time.sleep(0.2)
            target = img(st, BOX1["x"] + BOX1["w"] + 50, BOX1["y"] + BOX1["h"] + 40)
            drag(st.page, br, target)
            box = wait_for(lambda: next((a for a in item_annotations(st, ITEM) if a["id"] == "96baedfa-90bc-4fad-8803-d98e71a3c60d" and a.get("updatedAt") and a["geometry"]["w"] > BOX1["w"] + 30), None), "box resized", 10)
            g = box["geometry"]
            close(g["w"], BOX1["w"] + 50, 4, "w"); close(g["h"], BOX1["h"] + 40, 4, "h"); close(g["x"], BOX1["x"], 1, "x unchanged")
            return f"resized to {g['w']}×{g['h']}"

        def t_multiselect(st):
            tool(st, "v")
            left1 = img(st, BOX1["x"], BOX1["y"] + BOX1["h"] / 2)
            left2 = img(st, BOX2["x"], BOX2["y"] + BOX2["h"] / 2)
            click(st.page, left1)
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 1, "single select")
            click(st.page, left2, ["Shift"])
            wait_for(lambda: (lambda s: s if len(s) == 2 else None)(st.store("s => s.selectedIds")), "shift-click adds")
            st.shot("multiselect", out)
            click(st.page, left2, [MOD])
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 1, f"{MOD}-click toggles off")
            click(st.page, left2, [MOD])
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 2, f"{MOD}-click toggles on")
            n0 = len(item_annotations(st, ITEM))
            st.page.mouse.move(5, 5)
            st.page.keyboard.press("Delete")
            wait_for(lambda: len(item_annotations(st, ITEM)) == n0 - 2, "Delete removes both")
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: len(item_annotations(st, ITEM)) == n0, "undo restores both")
            st.page.keyboard.press(f"{MOD}+a")
            all_sel = wait_for(lambda: (lambda s: s if len(s) == n0 else None)(st.store("s => s.selectedIds")), "select all")
            time.sleep(0.3)
            st.shot("select-all", out)
            return f"shift/{MOD}-click, Delete 2, undo, {MOD}+A selected {len(all_sel)}"

        def t_undo_redo(st):
            before = item_annotations(st, ITEM)
            tool(st, "l")
            drag(st.page, img(st, 500, 1100), img(st, 700, 1100))
            a = only_new(st, before)[0]
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: not new_annotations(st, ITEM, before), "undo removes")
            time.sleep(0.3)
            n_drawn = st.page.evaluate("() => document.querySelectorAll('[data-testid=image-canvas] svg line').length")
            st.page.keyboard.press(f"Shift+{MOD}+z")
            b = only_new(st, before)[0]
            check(b["geometry"]["points"] == a["geometry"]["points"], "redo restores the same geometry")
            time.sleep(0.3)
            n_after = st.page.evaluate("() => document.querySelectorAll('[data-testid=image-canvas] svg line').length")
            check(n_after > n_drawn, f"redo redraws the line ({n_drawn} → {n_after} svg lines)")
            return "undo/redo round-trip"

        for name, fn in [("handle drag edits box", t_handle), ("multi-select + Delete + ⌘A", t_multiselect), ("undo / redo", t_undo_redo)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ view controls
        def t_view(st):
            st.page.mouse.move(5, 5)
            kb = st.page.keyboard
            kb.press("Shift+I"); time.sleep(0.2)
            check(props(st)["invert"] is True, "invert")
            kb.press("Shift+H"); time.sleep(0.2)
            check(props(st)["flipH"] is True, "flip H")
            kb.press("Shift+V"); time.sleep(0.2)
            check(props(st)["flipV"] is True, "flip V")
            kb.press("Shift+R"); time.sleep(0.2)
            r1 = props(st)["rotation"]
            st.shot("view-transformed", out)
            kb.press("Shift+L"); kb.press("Shift+L"); time.sleep(0.2)
            r2 = props(st)["rotation"]
            st.page.get_by_role("combobox", name="Color map").select_option("Black-Body Radiation")
            time.sleep(0.2)
            check(props(st)["colormap"] == "Black-Body Radiation", props(st)["colormap"])
            st.page.get_by_role("button", name="Interpolation: smooth (linear) or nearest-neighbour pixels").click()
            check(props(st)["interpolation"] == 0, f"nearest interpolation {props(st)['interpolation']}")
            kb.press("="); time.sleep(0.3)
            p = props(st)
            check(not p["flipH"] and not p["flipV"] and p["rotation"] == 0, f"reset {p}")
            st.page.get_by_role("combobox", name="Window / level preset").select_option("full")
            time.sleep(0.2)
            v = props(st)["voi"]
            check(v["lower"] <= 5 and v["upper"] >= 250, f"full range {v}")
            return f"invert/flip/rotate {r1}°→{r2}°, colormap, nearest, reset, full-range {v}"

        R.run("invert/flip/rotate/reset/colormap", session(t_view))

        def t_magnifier(st):
            c = img(st, 930, 650)
            st.page.mouse.move(*c)
            st.page.keyboard.press("m")
            st.page.mouse.move(c[0] + 5, c[1] + 5)
            time.sleep(0.3)
            vis = st.page.evaluate("() => { const m = document.querySelector('[data-testid=magnifier]'); return m && getComputedStyle(m).visibility }")
            check(vis == "visible", f"loupe visible ({vis})")
            nonblack = st.page.evaluate("""() => { const c = document.querySelector('[data-testid=magnifier]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 30) n++; return n }""")
            check(nonblack > 1000, f"loupe shows the image ({nonblack} lit px)")
            st.shot("magnifier", out)
            st.page.get_by_role("button", name="Magnifier: 3× loupe under the cursor (M)").click()
            check(st.page.evaluate("() => !document.querySelector('[data-testid=magnifier]')"), "toggle off")
            return f"loupe {nonblack} lit px"

        def t_space_pan(st):
            before = item_annotations(st, ITEM)
            tool(st, "r")
            c = img(st, 900, 1000)
            pan0 = props(st)["pan"]
            st.page.mouse.move(*c)
            st.page.keyboard.down("Space")
            time.sleep(0.2)
            drag(st.page, c, (c[0] + 120, c[1] - 60))
            st.page.keyboard.up("Space")
            time.sleep(0.3)
            check(props(st)["pan"] != pan0, "space-drag pans")
            check(not new_annotations(st, ITEM, before), "space-drag draws nothing")
            check(st.store("s => s.tool") == "box", "tool unchanged")
            drag(st.page, img(st, 150, 1000), img(st, 300, 1150))
            only_new(st, before)
            return "space pans, then box tool draws again"

        R.run("magnifier (M)", session(t_magnifier))
        R.run("space-to-pan", session(t_space_pan))

        # ------------------------------------------------------------ COCO export
        def t_coco(st):
            before = item_annotations(st, ITEM)
            tool(st, "p")
            for p in [(200, 1000), (400, 980), (420, 1200), (200, 1000)]:
                click(st.page, img(st, *p)); time.sleep(0.15)
            tool(st, "b")
            drag(st.page, img(st, 1300, 1100), img(st, 1500, 1110))
            wait_for(lambda: masks(st, ITEM), "mask")
            tool(st, "k")
            click(st.page, img(st, 900, 1100))
            only_new(st, before, n=3)
            raw = blob_from_exporter(st, "inkling.image2d.exporters.coco")
            doc = json.loads(raw)
            (out / "coco.json").write_bytes(raw)
            im = next(i for i in doc["images"] if i["file_name"] == ITEM)
            check((im["width"], im["height"]) == (1857, 1317), im)
            anns = [a for a in doc["annotations"] if a["image_id"] == im["id"]]
            kinds = {"bbox": 0, "poly": 0, "rle": 0, "kp": 0}
            for a in anns:
                if a.get("keypoints"): kinds["kp"] += 1
                elif isinstance(a.get("segmentation"), dict): kinds["rle"] += 1
                elif a.get("segmentation"): kinds["poly"] += 1
                else: kinds["bbox"] += 1
            check(kinds == {"bbox": 5, "poly": 1, "rle": 1, "kp": 1}, kinds)
            rle = next(a for a in anns if isinstance(a.get("segmentation"), dict))
            check(rle["segmentation"]["size"] == [1317, 1857] and sum(rle["segmentation"]["counts"]) == 1857 * 1317, "RLE size")
            check([c["name"] for c in doc["categories"]] == ["normal", "pneumonia"], doc["categories"])
            return f"{len(doc['images'])} images, item kinds {kinds}"

        R.run("COCO export", session(t_coco))

        # ------------------------------------------------------------ DICOM 2D
        fx = ensure_dicom_fixtures(dicom_dir)
        cr = fx["cr"]
        dicom_project = {
            "id": "dicom-dx", "title": "DICOM DX (synthetic)", "viewer": "image-2d", "task": "detection",
            "labels": ["opacity", "device"], "source": "synthetic", "license": "test", "status": "available",
            "assets": [{"path": "dicom-dx/dx1.dcm", "sha256": "", "bytes": 0}],
        }
        dicom_kw = {"fixtures": {"dicom-dx/dx1.dcm": dicom_dir / "cr/cr1.dcm"}, "extra_projects": [dicom_project]}
        DX = "dicom-dx/dx1.dcm"

        def t_dicom(st):
            check("Calibrated (mm)" in st.page.inner_text("body"), "calibrated banner")
            before = item_annotations(st, DX)
            tool(st, "l")
            drag(st.page, img(st, 400, 1000), img(st, 700, 1000))
            g = only_new(st, before, item=DX)[0]["geometry"]
            check(g["unit"] == "mm", g)
            close(g["stats"]["length"], 300 * cr["pixelSpacing"], 0.5, "length mm = px × PixelSpacing")
            tool(st, "r")
            drag(st.page, img(st, 900, 300), img(st, 1100, 500))
            tool(st, "b")
            drag(st.page, img(st, 500, 600), img(st, 800, 620))
            wait_for(lambda: masks(st, DX), "mask")
            mask = next(a for a in item_annotations(st, DX) if a["geometry"]["type"] == "mask")
            check(abs(mask["geometry"]["volumeMm3"] - mask["geometry"]["voxels"] * 0.0225) < 1, "mask area in mm²")
            st.shot("dicom-dx", out)
            seg = blob_from_exporter(st, "inkling.dicom-export.exporters.dicom-seg")
            (out / "dx-seg.dcm").write_bytes(seg)
            v = validate_dicom(out / "dx-seg.dcm", "seg")
            check(v["sopClassUID"] == "1.2.840.10008.5.1.4.1.1.66.4", v["sopClassUID"])
            check(v["frames"] == 1 and v["rows"] == cr["rows"] and v["columns"] == cr["columns"], v)
            check([s["label"] for s in v["segments"]] == ["opacity"], v["segments"])
            check(v["studyUID"] == cr["studyUID"] and cr["seriesUID"] in v["referencedSeries"], "references the DX study/series")
            check(v["totalPixels"] == mask["geometry"]["voxels"], f"SEG pixels {v['totalPixels']} vs mask {mask['geometry']['voxels']}")
            sr = blob_from_exporter(st, "inkling.dicom-export.exporters.dicom-sr")
            (out / "dx-sr.dcm").write_bytes(sr)
            s = validate_dicom(out / "dx-sr.dcm", "sr")
            check(s["template"] == "1500", s)
            lengths = [n for n in s["nums"] if n["name"] == "Length"]
            check(lengths and abs(lengths[0]["value"] - g["stats"]["length"]) < 0.01 and lengths[0]["unit"] == "mm", s["nums"])
            check(s["groups"] >= 2, f"groups {s['groups']}")
            return f"length {g['stats']['length']} mm; SEG {v['sopClass']} 1 frame {v['totalPixels']} px; SR groups {s['groups']}, nums {[(n['name'], round(n['value'], 2)) for n in s['nums']][:4]}"

        R.run("DICOM DX: mm calibration + SEG + SR", session(t_dicom, "dicom-dx", **dicom_kw))

        browser.close()
    return R.summary()


if __name__ == "__main__":
    raise SystemExit(main())
