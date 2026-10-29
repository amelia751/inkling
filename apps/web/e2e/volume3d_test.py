"""End-to-end tests for the Cornerstone 3D viewer (BraTS NIfTI subjects + a synthetic DICOM CT series).

    pnpm exec vite --port 5181 --strictPort          # in apps/web
    INKLING_DICOM_DIR=… python3 e2e/volume3d_test.py --port 5181

Real mouse / keyboard input throughout; saves are intercepted by harness.open_studio.
"""

from __future__ import annotations

import gzip
import json
import os
import struct
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
    dist,
    drag,
    ensure_dicom_fixtures,
    item_annotations,
    masks,
    new_annotations,
    validate_dicom,
    wait_for,
)
from harness import open_studio, parse_args, sync_playwright  # noqa: E402

SUBJECT = "BraTS2021_00495"
REF_COUNTS = {"necrotic core": 20808, "edema": 46447, "enhancing tumor": 32047}
MOD = "Meta" if sys.platform == "darwin" else "Control"


def open_3d(browser, port, dataset="3d-brain-mri", **kw):
    st = open_with_fixtures(open_studio, browser, port, dataset, kw["fixtures"], kw["extra_projects"]) if kw.get("fixtures") else open_studio(browser, port, dataset, **kw)
    wait_for(lambda: st.page.evaluate("() => !!window.__inkling3d"), "3D viewer ready", 120)
    wait_for(lambda: st.store("s => s.projectId") == dataset, "annotations loaded")
    time.sleep(1)
    return st


def hook(st, expr):
    return st.page.evaluate(f"() => window.__inkling3d.{expr}")


def props(st, cell="axial"):
    return hook(st, f"props('{cell}')")


def at(st, cell, ijk):
    return tuple(hook(st, f"ijkToClient('{cell}', {json.dumps(list(ijk))})"))


def cell_center(st, cell):
    b = st.page.locator(f"[data-testid=plane-{cell}]").bounding_box()
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


KEY_TOOL = {"v": "select", "h": "pan", "z": "zoom", "w": "windowLevel", "c": "crosshairs", "r": "box", "o": "ellipse", "p": "polygon",
            "f": "freehand", "k": "KEYPOINT", "l": "length", "a": "angle", "j": "cobb", "d": "bidirectional", "i": "probe", "x": "arrow",
            "b": "brush", "e": "eraser", "g": "wand"}


def tool(st, key):
    """Pick a tool with its keyboard shortcut (retrying if the first key lands before focus settles)."""
    want = KEY_TOOL[key].replace("KEYPOINT", "point")
    for attempt in range(4):
        st.page.mouse.move(3, 3)
        st.page.keyboard.press(key)
        time.sleep(0.25)
        if st.store("s => s.tool") == want:
            if attempt:
                print(f"  note: key {key!r} needed {attempt + 1} presses", flush=True)
            return
    raise AssertionError(f"key {key!r} did not select {want} (tool is {st.store('s => s.tool')})")


def goto_slice(st, cell, k):
    st.page.mouse.move(*cell_center(st, cell))
    for _ in range(400):
        cur = props(st, cell)["slice"]
        if cur == k:
            return
        st.page.keyboard.press("ArrowUp")
        nxt = props(st, cell)["slice"]
        if (nxt - cur) * (k - cur) < 0 or nxt == cur:
            # Wrong way (or at the end): go the other direction.
            for _ in range(400):
                if props(st, cell)["slice"] == k:
                    return
                st.page.keyboard.press("ArrowDown")
            break
    check(props(st, cell)["slice"] == k, f"could not reach slice {k} on {cell}")


def only_new(st, before, item=SUBJECT, n=1):
    return wait_for(lambda: (lambda x: x if len(x) >= n else None)(new_annotations(st, item, before)), f"{n} new annotation(s)", 15)


def main() -> int:
    args = parse_args()
    out = Path(args.out) / "volume3d"
    out.mkdir(parents=True, exist_ok=True)
    dicom_dir = Path(os.environ.get("INKLING_DICOM_DIR", str(Path(args.out) / "dicom")))
    R = Results(out)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed, args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"])

        def session(fn, dataset="3d-brain-mri", **kw):
            def run():
                st = open_3d(browser, args.port, dataset, **kw)
                try:
                    note = fn(st)
                    errs = [e for e in st.errors if "favicon" not in e and "WebGL" not in e]
                    check(not errs, f"console errors: {errs[:3]}")
                    return note
                finally:
                    st.page.context.close()
            return run

        # ------------------------------------------------------------ load / layouts / navigation
        def t_load(st):
            pts = [a for a in item_annotations(st, SUBJECT) if a["geometry"]["type"] == "point3d"]
            check(len(pts) == 4, f"4 legacy points (migrated to point3d), got {len(pts)}")
            time.sleep(2)
            check(st.store("s => s.past.length") == 0, "loading must not edit annotations")
            g = hook(st, "geom()")
            check(g["dims"] == [240, 240, 155] and g["modality"] == "MR", g)
            goto_slice(st, "axial", 101)
            time.sleep(0.4)
            n_probe = st.page.evaluate("() => document.querySelectorAll('[data-testid=plane-axial] svg circle').length")
            check(n_probe >= 4, f"legacy points drawn on slice 102 ({n_probe} circles)")
            st.shot("load-slice102", out)
            return f"4 points drawn at k=101, dims {g['dims']}"

        def t_layouts(st):
            notes = []
            for value, n in [("main", 3), ("single", 1), ("mpr3d", 4), ("mpr", 3)]:
                st.page.get_by_role("combobox", name="Layout").select_option(value)
                wait_for(lambda: len(hook(st, "cells()")) == n, f"{value} has {n} viewports", 30)
                wait_for(lambda: st.page.locator("canvas.cornerstone-canvas").count() >= n, "canvases")
                time.sleep(1.5)
                st.shot(f"layout-{value}", out)
                notes.append(f"{value}:{n}")
            return ", ".join(notes)

        def t_slices(st):
            st.page.mouse.move(*cell_center(st, "axial"))
            s0 = props(st)["slice"]
            for _ in range(3):
                st.page.keyboard.press("ArrowUp")
            s1 = props(st)["slice"]
            check(abs(s1 - s0) == 3, f"ArrowUp ×3: {s0} → {s1}")
            st.page.keyboard.press("Home")
            s2 = props(st)["slice"]
            st.page.keyboard.press("End")
            s3 = props(st)["slice"]
            check({s2, s3} == {0, 154}, f"Home/End {s2}/{s3}")
            check(st.store("s => s.itemIndex") == 0, "arrows must not change item")
            st.page.mouse.wheel(0, -300)
            time.sleep(0.3)
            check(props(st)["slice"] != s3, "wheel scrolls slices")
            return f"{s0}→{s1}, Home {s2}, End {s3}"

        def t_crosshairs(st):
            tool(st, "c")
            click(st.page, at(st, "axial", (150, 90, 77)))
            time.sleep(0.6)
            sag, cor = props(st, "sagittal")["slice"], props(st, "coronal")["slice"]
            close(sag, 150, 1, "sagittal slice follows"); close(cor, 90, 1, "coronal slice follows")
            st.shot("crosshairs", out)
            st.page.get_by_role("combobox", name="Layout").select_option("main")
            wait_for(lambda: len(hook(st, "cells()")) == 3, "main layout")
            time.sleep(1)
            close(props(st, "sagittal")["slice"], 150, 1, "slice kept across layout")
            return f"jump to sagittal {sag}, coronal {cor}; kept after layout change"

        def t_sequence(st):
            goto_slice(st, "axial", 90)
            st.page.get_by_role("button", name="Show the T1CE sequence (camera and masks are kept)").click()
            wait_for(lambda: hook(st, "props('axial')")["voi"]["upper"] > 2000, "T1CE window", 30)
            check(props(st)["slice"] == 90, "slice kept across sequence switch")
            st.shot("t1ce", out)
            return f"T1CE at slice 90, window {props(st)['voi']}"

        for name, fn in [("load + legacy points", t_load), ("layouts 1×3/1+2/single/MPR+3D", t_layouts), ("slice keys, Home/End, wheel", t_slices), ("crosshairs (C) jump", t_crosshairs), ("sequence switch", t_sequence)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ measurements on the axial plane (k = 77)
        def measure(key, pts, gesture="drag"):
            def fn(st):
                before = item_annotations(st, SUBJECT)
                tool(st, key)
                if gesture == "drag":
                    drag(st.page, at(st, "axial", pts[0]), at(st, "axial", pts[1]))
                else:
                    for p in pts:
                        click(st.page, at(st, "axial", p))
                        time.sleep(0.15)
                return only_new(st, before)[0]
            return fn

        def t_point(st):
            a = measure("k", [(110, 130, 77)], "click")(st)
            g = a["geometry"]
            check(g["type"] == "point3d" and g["plane"] == "axial" and g["ijk"] == [110, 130, 77] and g["slice"] == 77, g)
            return f"point {g['ijk']}"

        def t_length(st):
            a = measure("l", [(100, 100, 77), (140, 100, 77)])(st)
            g = a["geometry"]
            check(g["kind"] == "length" and g["space"] == "world" and g["plane"] == "axial" and g["slice"] == 77, g)
            close(g["stats"]["length"], 40, 0.5, "length mm")
            close(dist(g["points"][0], g["points"][1]), 40, 0.5, "world points 40 mm apart")
            return f"{g['stats']['length']} {g['unit']}"

        def t_angle(st):
            g = measure("a", [(100, 100, 77), (100, 140, 77), (140, 140, 77)], "click")(st)["geometry"]
            close(g["stats"]["angle"], 90, 2, "angle")
            return f"{g['stats']['angle']}°"

        def t_bidi(st):
            g = measure("d", [(90, 120, 77), (150, 120, 77)])(st)["geometry"]
            close(g["stats"]["length"], 60, 1, "long axis mm")
            return f"long {g['stats']['length']} short {g['stats'].get('width')}"

        def t_box(st):
            g = measure("r", [(100, 100, 77), (140, 130, 77)])(st)["geometry"]
            check(g["kind"] == "rectangle-roi", g)
            close(g["stats"]["area"], 40 * 30, 60, "area mm²")
            check("mean" in g["stats"], g["stats"])
            return f"area {g['stats']['area']} mm², mean {g['stats']['mean']}"

        def t_ellipse(st):
            g = measure("o", [(100, 100, 77), (140, 140, 77)])(st)["geometry"]
            check(g["kind"] == "ellipse-roi" and g["stats"].get("area", 0) > 100, g)
            return f"area {g['stats']['area']} mm²"

        def t_polygon(st):
            pts = [(100, 100, 77), (140, 100, 77), (140, 140, 77), (100, 140, 77), (100, 100, 77)]
            a = measure("p", pts, "click")(st)
            g = a["geometry"]
            check(g["kind"] == "freehand-roi" and a.get("attributes", {}).get("tool") == "polygon" and len(g["points"]) == 4, a)
            return "polygon stored as freehand-roi (tool=polygon)"

        def t_freehand(st):
            before = item_annotations(st, SUBJECT)
            tool(st, "f")
            import math
            st.page.mouse.move(*at(st, "axial", (150, 120, 77)))
            st.page.mouse.down()
            for k in range(1, 41):
                t = k / 40 * 2 * math.pi
                st.page.mouse.move(*at(st, "axial", (120 + 30 * math.cos(t), 120 + 30 * math.sin(t), 77)))
            st.page.mouse.up()
            g = only_new(st, before)[0]["geometry"]
            close(g["stats"]["area"], math.pi * 900, 300, "freehand area mm²")
            return f"area {g['stats']['area']} mm²"

        def t_probe(st):
            p = at(st, "axial", (120, 120, 77))
            st.page.mouse.move(*p)
            time.sleep(0.3)
            status = st.store("s => s.viewerStatus")
            g = measure("i", [(120, 120, 77)], "click")(st)["geometry"]
            v = g["stats"]["value"]
            check(f"= {int(v)}" in status or f"= {round(v, 2)}" in status, f"probe {v} vs readout '{status[-40:]}'")
            return f"value {v}"

        def t_arrow(st):
            before = item_annotations(st, SUBJECT)
            tool(st, "x")
            drag(st.page, at(st, "axial", (100, 100, 77)), at(st, "axial", (120, 120, 77)))
            st.page.wait_for_selector("input[placeholder='Arrow note…']", timeout=5000)
            st.page.keyboard.type("necrosis?")
            st.page.keyboard.press("Enter")
            g = only_new(st, before)[0]["geometry"]
            check(g.get("text") == "necrosis?", g)
            return "arrow note stored"

        for name, fn in [("point (K) → ijk", t_point), ("length (L) mm", t_length), ("angle (A)", t_angle), ("bidirectional (D)", t_bidi),
                         ("box (R) → rectangle ROI", t_box), ("ellipse (O)", t_ellipse), ("polygon (P)", t_polygon), ("freehand (F)", t_freehand),
                         ("probe (I) value", t_probe), ("arrow (X) note", t_arrow)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ masks
        def t_masks(st):
            label = st.store("s => s.activeLabel")
            tool(st, "b")
            drag(st.page, at(st, "axial", (100, 100, 77)), at(st, "axial", (130, 105, 77)))
            m1 = wait_for(lambda: masks(st, SUBJECT).get(label), "brush", 10)
            goto_slice(st, "axial", 85)
            drag(st.page, at(st, "axial", (100, 100, 85)), at(st, "axial", (130, 105, 85)))
            m2 = wait_for(lambda: (lambda v: v if v and v > m1 else None)(masks(st, SUBJECT).get(label)), "second slice", 10)
            button(st.page, "Interpolate").click()
            m3 = wait_for(lambda: (lambda v: v if v and v > m2 * 2.5 else None)(masks(st, SUBJECT).get(label)), "interpolated slices", 60)
            tool(st, "e")
            drag(st.page, at(st, "axial", (100, 102, 85)), at(st, "axial", (130, 102, 85)))
            m4 = wait_for(lambda: (lambda v: v if v and v < m3 else None)(masks(st, SUBJECT).get(label)), "eraser", 10)
            # A separate blob far away is an island of the same label.
            tool(st, "b")
            drag(st.page, at(st, "axial", (60, 180, 85)), at(st, "axial", (64, 182, 85)))
            m5 = wait_for(lambda: (lambda v: v if v and v > m4 else None)(masks(st, SUBJECT).get(label)), "island blob", 10)
            button(st.page, "Remove islands").click()
            m6 = wait_for(lambda: (lambda v: v if v and v < m5 else None)(masks(st, SUBJECT).get(label)), "islands removed", 20)
            close(m6, m4, 0, "only the island is removed")
            tool(st, "g")
            button(st.page, "Similar intensity").click()
            click(st.page, at(st, "axial", (150, 80, 85)))
            m7 = wait_for(lambda: (lambda v: v if v and v > m6 else None)(masks(st, SUBJECT).get(label)), "wand", 10)
            st.shot("masks", out)
            mask = next(a for a in item_annotations(st, SUBJECT) if a["geometry"]["type"] == "mask")
            close(mask["geometry"]["volumeMm3"], mask["geometry"]["voxels"] * 1.0, 1, "volume = voxels × 1 mm³")
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: masks(st, SUBJECT).get(label) == m6, "undo wand", 10)
            return f"brush {m1}, +slice {m2}, interpolate {m3}, eraser {m4}, +island {m5} → removed {m6}, wand {m7}; undo"

        def decode(counts, n):
            out = bytearray(n)
            at_, fg = 0, False
            for run in counts:
                if fg:
                    out[at_:at_ + run] = b"\x01" * run
                at_ += run
                fg = not fg
            return out

        def t_smart(st):
            nx, ny, nz = 240, 240, 155
            button(st.page, "Copy to my mask").click()
            wait_for(lambda: len(masks(st, SUBJECT)) == 3, "reference copied")
            refs = {a["label"]: decode(a["geometry"]["counts"], nx * ny * nz) for a in item_annotations(st, SUBJECT) if a["geometry"]["type"] == "mask"}
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: not masks(st, SUBJECT), "copy undone")
            edema = refs["edema"]
            # FLAIR shows the whole tumour (edema + core) as one bright region.
            whole = bytes(a | b | c for a, b, c in zip(refs["edema"], refs["necrotic core"], refs["enhancing tumor"]))
            k = 101
            pts = [(i, j) for j in range(ny) for i in range(nx) if edema[k * nx * ny + j * nx + i]]
            ci = round(sum(p[0] for p in pts) / len(pts)); cj = round(sum(p[1] for p in pts) / len(pts))
            seed = min(pts, key=lambda p: (p[0] - ci) ** 2 + (p[1] - cj) ** 2)
            st.page.mouse.move(3, 3)
            st.page.keyboard.press("2")  # pick label 2 = edema
            wait_for(lambda: st.store("s => s.activeLabel") == "edema", "label 2 picked by key")
            tool(st, "g")
            button(st.page, "Smart fill").click()
            goto_slice(st, "axial", k)
            click(st.page, at(st, "axial", (seed[0], seed[1], k)))
            v = wait_for(lambda: masks(st, SUBJECT).get("edema"), "smart fill", 30)
            fill = decode(next(a for a in item_annotations(st, SUBJECT) if a["label"] == "edema")["geometry"]["counts"], nx * ny * nz)
            inter = sum(1 for i in range(len(fill)) if fill[i] and whole[i])
            precision = inter / v
            recall = inter / sum(whole)
            st.shot("smart-fill", out)
            check(1000 < v < 200_000, f"smart fill size {v}")
            check(precision > 0.7 and recall > 0.5, f"smart fill vs reference whole tumour: precision {precision:.2f}, recall {recall:.2f}")
            return f"seed {seed}: {v} voxels; vs reference whole tumour precision {precision:.2f}, recall {recall:.2f}"

        def t_reference(st):
            button(st.page, "Copy to my mask").click()
            got = wait_for(lambda: (lambda m: m if len(m) == 3 else None)(masks(st, SUBJECT)), "3 masks", 20)
            check(got == REF_COUNTS, f"{got} vs {REF_COUNTS}")
            src = {a["attributes"].get("source") for a in item_annotations(st, SUBJECT) if a["geometry"]["type"] == "mask"}
            check(src == {"reference"}, src)
            button(st.page, "Reference mask").click()
            time.sleep(0.5)
            st.shot("reference-copied", out)
            st.page.keyboard.press(f"{MOD}+z")
            wait_for(lambda: not masks(st, SUBJECT), "one undo removes the copy", 10)
            return f"copied {got}"

        for name, fn in [("brush/interpolate/eraser/wand/islands", t_masks), ("smart fill (3D region grow)", t_smart), ("reference mask copy", t_reference)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ selection / view
        def t_select(st):
            before = item_annotations(st, SUBJECT)
            tool(st, "l")
            drag(st.page, at(st, "axial", (90, 90, 77)), at(st, "axial", (150, 90, 77)))
            drag(st.page, at(st, "axial", (90, 150, 77)), at(st, "axial", (150, 150, 77)))
            a, b = only_new(st, before, n=2)[:2]
            tool(st, "v")
            click(st.page, at(st, "axial", (120, 90, 77)))
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 1, "select")
            click(st.page, at(st, "axial", (120, 150, 77)), ["Shift"])
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 2, "shift-click")
            # Handle drag on the selected line's end point.
            drag(st.page, at(st, "axial", (150, 150, 77)), at(st, "axial", (160, 150, 77)))
            edited = wait_for(lambda: next((x for x in item_annotations(st, SUBJECT) if x["id"] == b["id"] and x["geometry"]["stats"]["length"] > 65), None), "handle drag", 10)
            close(edited["geometry"]["stats"]["length"], 70, 1, "edited length")
            st.page.keyboard.press(f"{MOD}+a")
            n_all = len(item_annotations(st, SUBJECT))
            wait_for(lambda: len(st.store("s => s.selectedIds")) == n_all, "select all")
            # Escape: nothing is being dragged, so the volume's cancel command falls through to deselect.
            st.page.keyboard.press("Escape")
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 0, "Escape clears the selection")
            click(st.page, at(st, "axial", (120, 90, 77)))
            click(st.page, at(st, "axial", (120, 150, 77)), [MOD])
            wait_for(lambda: len(st.store("s => s.selectedIds")) == 2, f"{MOD}-click adds")
            st.page.mouse.move(3, 3)
            st.page.keyboard.press("Delete")
            wait_for(lambda: not new_annotations(st, SUBJECT, before), "deleted both")
            return "shift/⌘ multi-select, handle drag 60→70 mm, ⌘A, Escape, Delete"

        def t_view(st):
            st.page.mouse.move(*cell_center(st, "axial"))
            kb = st.page.keyboard
            kb.press("Shift+I"); time.sleep(0.2)
            check(all(props(st, c)["invert"] for c in ("axial", "sagittal", "coronal")), "invert all planes")
            kb.press("Shift+H"); kb.press("Shift+R"); time.sleep(0.3)
            p = props(st)
            check(p["flipH"] and p["rotation"] == 90, p)
            st.shot("view-transformed", out)
            kb.press("="); time.sleep(0.3)
            p = props(st)
            check(not p["flipH"] and p["rotation"] == 0, f"reset {p}")
            st.page.get_by_role("combobox", name="Color map").select_option("Inferno (matplotlib)")
            check(props(st, "coronal")["colormap"] == "Inferno (matplotlib)", "colormap on all planes")
            st.page.get_by_role("button", name="Maximum-intensity projection over a 10 mm slab").click()
            time.sleep(0.3)
            check((props(st)["slab"] or 0) >= 9, f"MIP slab {props(st)['slab']}")
            st.shot("mip", out)
            c = cell_center(st, "axial")
            tool(st, "w")
            v0 = props(st)["voi"]
            drag(st.page, c, (c[0] + 100, c[1] + 40))
            check(props(st)["voi"] != v0 and props(st, "sagittal")["voi"] == props(st)["voi"], "W/L drag synced across planes")
            tool(st, "z")
            z0 = props(st)["zoom"]
            drag(st.page, c, (c[0], c[1] - 120))
            check(abs(props(st)["zoom"] - z0) > 0.1, "zoom drag")
            tool(st, "h")
            f0 = props(st)["focal"]
            drag(st.page, c, (c[0] + 80, c[1]))
            check(props(st)["focal"] != f0, "pan drag")
            return "invert/flip/rotate/reset/colormap/MIP/W-L/zoom/pan"

        def t_magnifier_space(st):
            c = cell_center(st, "axial")
            st.page.mouse.move(*c)
            st.page.keyboard.press("m")
            st.page.mouse.move(c[0] + 4, c[1] + 4)
            time.sleep(0.3)
            lit = st.page.evaluate("""() => { const c = document.querySelector('[data-testid=magnifier]'); if (!c || getComputedStyle(c).visibility !== 'visible') return 0;
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 30) n++; return n }""")
            check(lit > 1000, f"loupe shows the MRI ({lit})")
            st.shot("magnifier", out)
            st.page.keyboard.press("m")
            before = item_annotations(st, SUBJECT)
            tool(st, "l")
            f0 = props(st)["focal"]
            st.page.mouse.move(*c)
            st.page.keyboard.down("Space")
            drag(st.page, c, (c[0] + 90, c[1] + 30))
            st.page.keyboard.up("Space")
            time.sleep(0.3)
            check(props(st)["focal"] != f0 and not new_annotations(st, SUBJECT, before), "space pans without drawing")
            check(st.store("s => s.tool") == "length", "tool restored")
            return f"loupe {lit} lit px; space-pan"

        for name, fn in [("multi-select, handle drag, ⌘A, Delete", t_select), ("view controls, MIP, W/L sync, zoom, pan", t_view), ("magnifier + space-to-pan", t_magnifier_space)]:
            R.run(name, session(fn))

        # ------------------------------------------------------------ exports
        def t_nifti(st):
            button(st.page, "Copy to my mask").click()
            wait_for(lambda: len(masks(st, SUBJECT)) == 3, "masks")
            raw = blob_from_exporter(st, "inkling.volume.exporters.nifti-labelmap")
            (out / "labels.nii.gz").write_bytes(raw)
            nii = gzip.decompress(raw)
            hdr = struct.unpack_from("<i8h", nii, 0)[0], struct.unpack_from("<8h", nii, 40), struct.unpack_from("<h", nii, 70)[0], struct.unpack_from("<f", nii, 108)[0]
            check(hdr[0] == 348 and hdr[1][1:4] == (240, 240, 155) and hdr[2] == 2 and hdr[3] == 352, hdr)
            body = nii[352:]
            counts = {v: body.count(bytes([v])) for v in (1, 2, 4)}
            check(counts == {1: 20808, 2: 46447, 4: 32047}, counts)
            js = json.loads(blob_from_exporter(st, "inkling.volume.exporters.masks-json"))
            sub = next(s for s in js["subjects"] if s["subject"] == SUBJECT)
            check({m["label"]: m["voxels"] for m in sub["masks"]} == REF_COUNTS, sub["masks"])
            return f"NIfTI uint8 240×240×155 BraTS values {counts}; masks JSON ok"

        R.run("NIfTI + masks JSON export", session(t_nifti))

        # ------------------------------------------------------------ DICOM CT series
        fx = ensure_dicom_fixtures(dicom_dir)
        ct = fx["ct"]
        files = sorted((dicom_dir / "ct").glob("IM*.dcm"))
        ct_project = {
            "id": "dicom-ct", "title": "DICOM CT phantom (synthetic)", "viewer": "volume-3d", "task": "segmentation",
            "labels": ["lesion", "bone"], "source": "synthetic", "license": "test", "status": "available",
            "assets": [{"path": f"dicom-ct/CT1/{f.name}", "sha256": "", "bytes": 0, "subject": "CT1"} for f in files],
        }
        ct_kw = {"fixtures": {f"dicom-ct/CT1/{f.name}": f for f in files}, "extra_projects": [ct_project]}

        def ct_at(st, world):
            ijk = [round(v) for v in hook(st, f"worldToIjk({json.dumps(world)})")]
            goto_slice(st, "axial", ijk[2])
            return ijk, at(st, "axial", ijk)

        def t_ct(st):
            g = hook(st, "geom()")
            check(g["modality"] == "CT" and g["dims"] == ct["dims"], g)
            close(g["spacing"][0], 1.5, 1e-3, "pixel spacing"); close(g["spacing"][2], 2.5, 1e-3, "slice spacing")
            opts = st.page.get_by_role("combobox", name="Window / level").inner_text()
            check("Soft tissue 400/40" in opts and "Bone 2500/480" in opts, f"CT presets: {opts}")
            st.page.get_by_role("combobox", name="Window / level").select_option("bone")
            v = props(st)["voi"]
            close(v["upper"] - v["lower"], 2500, 1, "bone window"); close((v["upper"] + v["lower"]) / 2, 480, 1, "bone level")
            st.page.get_by_role("combobox", name="Window / level").select_option("soft")
            before = item_annotations(st, "CT1")
            ijk_l, p_l = ct_at(st, [-30, 10, 1.25])
            tool(st, "i")
            click(st.page, p_l)
            hu_l = only_new(st, before, item="CT1")[0]["geometry"]["stats"]["value"]
            close(hu_l, 60, 1, "lesion HU")
            before = item_annotations(st, "CT1")
            _, p_b = ct_at(st, [30, 0, 1.25])
            click(st.page, p_b)
            hu_b = only_new(st, before, item="CT1")[0]["geometry"]["stats"]["value"]
            close(hu_b, 700, 1, "bone HU")
            before = item_annotations(st, "CT1")
            tool(st, "l")
            k = ijk_l[2]
            drag(st.page, at(st, "axial", (20, 64, k)), at(st, "axial", (60, 64, k)))
            lg = only_new(st, before, item="CT1")[0]["geometry"]
            close(lg["stats"]["length"], 60, 0.5, "40 px × 1.5 mm")
            inspect = st.page.evaluate("""async () => { const inspect = await (await import('/src/platform/registry.ts')).registry.loadImpl('inkling.volume.inspectors.main');
                const runtime = (await import('/src/platform/runtime.ts')).runtimeFor('CT1'); const s = (await import('/src/stores/studio.ts')).useStudio.getState();
                const a = s.annotations.filter(a => a.itemId === 'CT1' && a.geometry.kind === 'probe')[0]; return inspect(a, { env: s.env, project: {}, item: { assets: [{ path: 'dicom-ct/CT1/IM0001.dcm' }] }, runtime }) }""")
            check(any("HU" in v for _, v in inspect), f"inspect shows HU: {inspect}")
            # Smart fill the lesion (3D), label "lesion".
            tool(st, "g")
            button(st.page, "Smart fill").click()
            _, p_l = ct_at(st, [-30, 10, 1.25])
            click(st.page, p_l)
            vox = wait_for(lambda: masks(st, "CT1").get("lesion"), "lesion mask", 20)
            expected = 4 / 3 * 3.14159 * 12**3 / (1.5 * 1.5 * 2.5)
            close(vox, expected, expected * 0.25, "lesion voxels ≈ sphere volume")
            st.shot("ct-lesion", out)
            seg = blob_from_exporter(st, "inkling.dicom-export.exporters.dicom-seg")
            (out / "ct-seg.dcm").write_bytes(seg)
            sv = validate_dicom(out / "ct-seg.dcm", "seg")
            check(sv["sopClassUID"] == "1.2.840.10008.5.1.4.1.1.66.4", sv["sopClassUID"])
            check([s["label"] for s in sv["segments"]] == ["lesion"] and sv["segments"][0]["algorithm"] == "MANUAL", sv["segments"])
            check(sv["referencedSeries"] == [ct["seriesUID"]] and sv["studyUID"] == ct["studyUID"] and sv["frameOfReferenceUID"] == ct["frameOfReferenceUID"], "references")
            check(sv["totalPixels"] == vox, f"SEG pixels {sv['totalPixels']} = mask {vox}")
            zs = [f["position"][2] for f in sv["perFrame"]]
            check(all(abs(z) <= 12 + 1.25 for z in zs), f"frames lie inside the lesion's z-range: {zs}")
            # Each frame's pixel count must equal the sphere cross-section at its z (±30%).
            for f in sv["perFrame"]:
                r2 = 12**2 - f["position"][2] ** 2
                area = 3.14159 * max(r2, 0) / (1.5 * 1.5)
                check(f["pixels"] == 0 or abs(f["pixels"] - area) <= max(25, area * 0.35), f"frame z={f['position'][2]}: {f['pixels']} px vs {area:.0f}")
            sr = blob_from_exporter(st, "inkling.dicom-export.exporters.dicom-sr")
            (out / "ct-sr.dcm").write_bytes(sr)
            s = validate_dicom(out / "ct-sr.dcm", "sr")
            lengths = [n for n in s["nums"] if n["name"] == "Length"]
            check(s["template"] == "1500" and lengths and abs(lengths[0]["value"] - 60) < 0.5 and lengths[0]["unit"] == "mm", s)
            check(s["groups"] >= 3, f"groups {s['groups']} (2 probes + length)")
            return f"CT HU lesion {hu_l} bone {hu_b}; length {lg['stats']['length']} mm; smart fill {vox} vox (≈{expected:.0f}); SEG {len(zs)} frames z∈[{min(zs)},{max(zs)}]; SR {s['groups']} groups"

        R.run("DICOM CT series: HU, mm, presets, SEG, SR", session(t_ct, "dicom-ct", **ct_kw))

        browser.close()
    return R.summary()


if __name__ == "__main__":
    raise SystemExit(main())
