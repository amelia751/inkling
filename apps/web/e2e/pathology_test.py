"""Whole-slide (pathology) viewer end-to-end tests.

    pnpm exec vite --port 5182 --strictPort          # in apps/web (HMR is stubbed out by the test)
    python3 e2e/pathology_test.py --port 5182 [--only name1,name2] [--headed]

Every gesture is driven with real mouse / keyboard events through Playwright. Saves are
intercepted by `open_studio`, so seed-data is never modified. Each test starts from an
empty annotation list (store.load) and a known viewport; screenshots go to e2e/.artifacts/.
The viewer exposes `window.__pathology` (modules/wsi WsiController) in dev builds, which the
tests use only to *read* state (view transform, ui flags) and to place the viewport.
"""

from __future__ import annotations

import io
import json
import math
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from harness import Studio, launch, open_studio, parse_args, src_url, sync_playwright  # noqa: E402

DATASET = "pathology-wsi"
MPP = 0.252
# A tissue fragment on the left of the TCGA slide (level-0 px).
TISSUE = (9600, 14500)
MOD = "ControlOrMeta"

# Other agents edit the shared tree while tests run; Vite would hot-update the Studio and
# remount the viewer mid-test. Stub the HMR socket (it never opens, so no updates arrive and
# the client never reloads). App modules still load normally over HTTP.
NO_HMR = """
(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (String(protocols).includes('vite-hmr') || String(url).includes('token=')) {
      const fake = new EventTarget();
      Object.assign(fake, { readyState: 0, url: String(url), protocol: 'vite-hmr', send() {}, close() {} });
      return fake;
    }
    return new Real(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();
"""


# --------------------------------------------------------------------------- helpers


def shoelace(pts):
    return abs(sum(pts[i - 1][0] * p[1] - p[0] * pts[i - 1][1] for i, p in enumerate(pts))) / 2


def region_area(g):
    if g["type"] == "polygon":
        return shoelace(g["points"]) - sum(shoelace(h) for h in g.get("holes", []))
    if g["type"] == "multipolygon":
        return sum(shoelace(p[0]) - sum(shoelace(h) for h in p[1:]) for p in g["polygons"])
    if g["type"] == "box":
        return g["w"] * g["h"]
    if g["type"] == "ellipse":
        return math.pi * g["rx"] * g["ry"]
    return 0.0


class P:
    """Page-level helpers for the pathology viewer."""

    def __init__(self, st: Studio, out: Path):
        self.st, self.page, self.out = st, st.page, out

    # ---- controller / coordinates
    def js(self, body: str, arg=None):
        # Other agents' edits can hot-reload the page; wait for the viewer to be back.
        self.page.wait_for_function("() => window.__pathology && window.__pathology.ui && window.__pathology.ui.ready", timeout=60000)
        return self.page.evaluate(f"async (arg) => {{ const c = window.__pathology; {body} }}", arg)

    def frames(self, n=3):
        self.page.evaluate(f"() => new Promise(r => {{ let k = {n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }})")

    def wait_ready(self):
        self.page.wait_for_function("() => window.__pathology && window.__pathology.ui && window.__pathology.ui.ready", timeout=60000)

    def fit(self, x, y, w, h):
        """Show image rect [x, y, w, h] immediately (no animation)."""
        self.js("const vp = c.viewer.viewport; vp.fitBounds(vp.imageToViewportRectangle(arg[0], arg[1], arg[2], arg[3]), true); c.viewer.forceRedraw();", [x, y, w, h])
        self.frames(4)

    def settle(self, timeout=20.0):
        """Wait for OSD animations to finish and tiles in view to load."""
        self.page.wait_for_timeout(700)
        self.page.wait_for_function("() => { const i = window.__pathology.viewer.world.getItemAt(0); return !i || i.getFullyLoaded(); }", timeout=timeout * 1000)
        self.frames(3)

    def xy(self, x, y):
        """Image px → page px."""
        return self.js("const r = c.stage.getBoundingClientRect(); const s = c.view.toScreen(arg[0], arg[1]); return [r.left + s[0], r.top + s[1]];", [x, y])

    def img(self, px, py):
        """Page px → image px."""
        return self.js("const r = c.stage.getBoundingClientRect(); return c.view.toImage(arg[0] - r.left, arg[1] - r.top);", [px, py])

    def scale(self):
        return self.js("return c.view.scale;")

    def ui(self):
        return self.js("return c.ui;")

    # ---- store
    def anns(self):
        return self.st.store("s => s.annotations")

    def sel(self):
        return self.st.store("s => ({ id: s.selectedId, ids: s.selectedIds })")

    def reset(self, label="tumor"):
        self.wait_ready()
        self.page.keyboard.press("Escape")
        self.st.act(f"s => s.load(s.projectId, [], 0, {json.dumps(label)})")
        self.js("c.resetRotation(); c.viewer.viewport.goHome(true);")
        self.frames(3)

    def add(self, geometry, label="tumor", **extra):
        """Insert a fixture annotation through the store (as an import would); returns its id."""
        return self.page.evaluate(
            """async ([g, label, extra]) => {
                const m = await import('/src/studio/stores/studio.ts');
                const s = m.useStudio.getState();
                const a = m.newAnnotation({ itemId: s.annotations[0]?.itemId ?? window.__pathology.item.id, label, geometry: g, ...extra });
                s.add(a);
                return a.id;
            }""",
            [geometry, label, extra],
        )

    def tool(self, key):
        self.page.keyboard.press(key)

    # ---- mouse
    def click_img(self, x, y, modifiers=()):
        px, py = self.xy(x, y)
        for m in modifiers:
            self.page.keyboard.down(m)
        self.page.mouse.click(px, py)
        for m in modifiers:
            self.page.keyboard.up(m)
        self.frames(2)

    def drag_img(self, a, b, steps=12, modifiers=(), via=None):
        pts = [self.xy(*a)] + [self.xy(*v) for v in (via or [])] + [self.xy(*b)]
        self.drag_px(pts, steps, modifiers)

    def drag_px(self, pts, steps=12, modifiers=()):
        for m in modifiers:
            self.page.keyboard.down(m)
        self.page.mouse.move(*pts[0])
        self.page.mouse.down()
        for p in pts[1:]:
            self.page.mouse.move(*p, steps=steps)
        self.page.mouse.up()
        for m in modifiers:
            self.page.keyboard.up(m)
        self.frames(2)

    def shot(self, name):
        return self.st.shot(f"pathology-{name}", self.out)

    def viewer_pixels(self, below=None):
        """RGB array of the slide area from a real screenshot, avoiding toolbar, navigator and `below` (a bbox)."""
        box = self.page.locator('[data-testid="wsi-viewer"]').bounding_box()
        top = box["y"] + 60 if below is None else below["y"] + below["height"] + 10
        clip = {"x": box["x"] + 20, "y": top, "width": box["width"] - 20 - 250, "height": box["y"] + box["height"] - 30 - top}
        png = self.page.screenshot(clip=clip)
        return np.asarray(Image.open(io.BytesIO(png)).convert("RGB")).astype(np.float32)


def near(a, b, tol):
    return abs(a - b) <= tol


# --------------------------------------------------------------------------- tests

TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def loads_slide(p: P):
    ui = p.ui()
    assert ui["ready"] and not ui["error"], ui
    assert ui["drawer"] in ("webgl", "canvas"), ui["drawer"]
    status = p.page.get_by_test_id("viewer-status").inner_text()
    assert "114,150×54,086" in status and "0.252 µm/px" in status, status
    p.shot("loaded")


@test
def box_and_shift_square(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("r")
    p.drag_img((TISSUE[0] - 1000, TISSUE[1] - 500), (TISSUE[0] + 600, TISSUE[1] + 200))
    p.drag_img((TISSUE[0] - 2000, TISSUE[1] + 400), (TISSUE[0] - 1200, TISSUE[1] + 1500), modifiers=["Shift"])
    a = p.anns()
    assert [x["geometry"]["type"] for x in a] == ["box", "box"], a
    g0, g1 = a[0]["geometry"], a[1]["geometry"]
    assert near(g0["w"], 1600, 40) and near(g0["h"], 700, 40), g0
    assert near(g1["w"], g1["h"], 1), f"shift should make a square: {g1}"
    assert p.sel()["id"] == a[1]["id"], "new shapes are selected"
    p.shot("box")


@test
def ellipse_and_shift_circle(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("o")
    p.drag_img((TISSUE[0] - 1000, TISSUE[1] - 500), (TISSUE[0] + 1000, TISSUE[1] + 300))
    p.drag_img((TISSUE[0] - 2000, TISSUE[1] + 600), (TISSUE[0] - 1000, TISSUE[1] + 1100), modifiers=["Shift"])
    a = p.anns()
    assert [x["geometry"]["type"] for x in a] == ["ellipse", "ellipse"], a
    g0, g1 = a[0]["geometry"], a[1]["geometry"]
    assert near(g0["rx"], 1000, 30) and near(g0["ry"], 400, 30), g0
    assert near(g1["rx"], g1["ry"], 1), f"shift should make a circle: {g1}"
    rows = p.page.evaluate(
        """async (a) => { const { registry } = await import('/src/extension-host/registry.ts'); const inspect = await registry.loadImpl('inkling.wsi.inspectors.main'); return inspect(a, { project: {}, item: { assets: [] }, runtime: { get: (k) => (k === 'mpp' ? 0.252 : undefined) } }); }""",
        a[0],
    )
    area_um2 = math.pi * g0["rx"] * g0["ry"] * MPP * MPP
    area_row = dict(rows)["Area"]
    assert area_row.endswith("µm²") or area_row.endswith("mm²"), rows
    shown = float(area_row.split()[0].replace(",", ""))
    expect = area_um2 / 1e6 if area_row.endswith("mm²") else area_um2
    assert abs(shown - expect) / expect < 0.01, (rows, expect)
    p.shot("ellipse")


@test
def polygon_click_backspace_enter_and_close(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("p")
    cx, cy = TISSUE
    for dx, dy in [(-800, -600), (800, -600), (900, 500), (300, 300)]:
        p.click_img(cx + dx, cy + dy)
    hint = p.ui()["hint"]
    assert hint and hint.startswith("4 points"), hint
    p.page.keyboard.press("Backspace")
    assert p.ui()["hint"].startswith("3 points")
    p.page.mouse.move(*p.xy(cx - 900, cy + 600))
    p.frames(2)
    p.shot("polygon-draft")
    p.page.keyboard.press("Enter")
    a = p.anns()
    assert len(a) == 1 and a[0]["geometry"]["type"] == "polygon" and len(a[0]["geometry"]["points"]) == 3, a
    # Close by clicking the first vertex.
    for dx, dy in [(-1500, 800), (-500, 800), (-1000, 1600)]:
        p.click_img(cx + dx, cy + dy)
    p.click_img(cx - 1500, cy + 800)
    a = p.anns()
    assert len(a) == 2 and len(a[1]["geometry"]["points"]) == 3, a[1]
    # Double-click finishes too; Escape cancels a draft.
    for dx, dy in [(1200, 800), (2000, 900)]:
        p.click_img(cx + dx, cy + dy)
    px, py = p.xy(cx + 1600, cy + 1600)
    p.page.mouse.dblclick(px, py)
    p.frames(2)
    a = p.anns()
    assert len(a) == 3 and len(a[2]["geometry"]["points"]) == 3, a[2]
    p.click_img(cx, cy - 1500)
    p.click_img(cx + 500, cy - 1500)
    p.page.keyboard.press("Escape")
    assert len(p.anns()) == 3 and p.ui()["hint"] is None


@test
def freehand_lasso(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("f")
    cx, cy = TISSUE
    ring = [(cx + 1200 * math.cos(t / 20 * 2 * math.pi), cy + 900 * math.sin(t / 20 * 2 * math.pi)) for t in range(21)]
    p.drag_img(ring[0], ring[-1], steps=4, via=ring[1:-1])
    a = p.anns()
    assert len(a) == 1 and a[0]["geometry"]["type"] == "polygon", a
    pts = a[0]["geometry"]["points"]
    assert 8 <= len(pts) < 200, len(pts)
    area = shoelace(pts)
    assert abs(area - math.pi * 1200 * 900) / (math.pi * 1200 * 900) < 0.08, area
    p.shot("freehand")


@test
def polyline_double_click_and_enter(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("y")
    cx, cy = TISSUE
    p.click_img(cx - 1000, cy)
    p.click_img(cx, cy - 500)
    px, py = p.xy(cx + 1000, cy)
    p.page.mouse.dblclick(px, py)
    p.frames(2)
    p.click_img(cx - 1000, cy + 1000)
    p.click_img(cx + 1000, cy + 1000)
    p.page.keyboard.press("Enter")
    a = p.anns()
    assert [x["geometry"]["type"] for x in a] == ["polyline", "polyline"], a
    assert len(a[0]["geometry"]["points"]) == 3 and len(a[1]["geometry"]["points"]) == 2, a
    rows = dict(p.page.evaluate("""async (a) => { const m = await import('""" + src_url("plugins/wsi/ui/measure.ts") + """'); return m.inspectRows(a, 0.252, []); }""", a[1]))
    assert rows["Length"] in ("504 µm", "504.0 µm"), rows


@test
def length_matches_mpp(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("l")
    cx, cy = TISSUE
    p.drag_img((cx - 1000, cy), (cx + 1000, cy))
    a = p.anns()
    assert len(a) == 1, a
    g = a[0]["geometry"]
    assert g["type"] == "measurement" and g["kind"] == "length", g
    (x0, y0), (x1, y1) = g["points"]
    px_len = math.hypot(x1 - x0, y1 - y0)
    assert near(px_len, 2000, 20), px_len
    assert near(g["stats"]["length_um"], px_len * MPP, 0.05), g["stats"]
    assert g["unit"] == "µm"
    p.shot("length")


@test
def vertex_drag_edge_insert_alt_delete_and_move(p: P):
    cx, cy = TISSUE
    pid = p.add({"type": "polygon", "points": [[cx - 1000, cy - 1000], [cx + 1000, cy - 1000], [cx + 1000, cy + 1000], [cx - 1000, cy + 1000]]})
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    p.tool("v")
    p.click_img(cx, cy)
    assert p.sel()["id"] == pid
    # Drag vertex 0 up-left by 400 px.
    p.drag_img((cx - 1000, cy - 1000), (cx - 1400, cy - 1400))
    g = p.anns()[0]["geometry"]
    assert near(g["points"][0][0], cx - 1400, 15) and near(g["points"][0][1], cy - 1400, 15), g["points"][0]
    # Click the middle of the bottom edge → inserts a vertex.
    p.click_img(cx, cy + 1000)
    g = p.anns()[0]["geometry"]
    assert len(g["points"]) == 5, g
    inserted = g["points"][3]
    assert near(inserted[0], cx, 15) and near(inserted[1], cy + 1000, 15), g["points"]
    # Alt-click the new vertex → deleted.
    p.click_img(cx, cy + 1000, modifiers=["Alt"])
    g = p.anns()[0]["geometry"]
    assert len(g["points"]) == 4, g
    # Drag the body → translated.
    before = p.anns()[0]["geometry"]["points"]
    p.drag_img((cx + 200, cy + 200), (cx + 700, cy - 100))
    after = p.anns()[0]["geometry"]["points"]
    dx, dy = after[1][0] - before[1][0], after[1][1] - before[1][1]
    assert near(dx, 500, 15) and near(dy, -300, 15), (dx, dy)
    p.shot("vertex-edit")
    # Undo / redo walk the four edits.
    p.page.keyboard.press(f"{MOD}+z")
    assert p.anns()[0]["geometry"]["points"] == before
    p.page.keyboard.press(f"Shift+{MOD}+z")
    assert p.anns()[0]["geometry"]["points"] == after


@test
def marks_counts_and_density(p: P):
    cx, cy = TISSUE
    rid = p.add({"type": "box", "x": cx - 1000, "y": cy - 1000, "w": 2000, "h": 2000})
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    p.tool(".")
    for dx, dy in [(-500, -500), (300, 200), (600, -700)]:
        p.click_img(cx + dx, cy + dy)
    p.page.keyboard.press("4")  # lymphocytes
    p.click_img(cx + 100, cy + 600)
    p.click_img(cx + 2200, cy)  # outside the region
    a = p.anns()
    marks = [x for x in a if x["geometry"]["type"] == "keypoint"]
    assert len(marks) == 5 and [m["label"] for m in marks].count("lymphocytes") == 2, marks
    panel = p.page.get_by_test_id("point-counts")
    text = panel.inner_text()
    assert "Points\n5" in text.replace("\t", "\n") or "Points5" in text.replace("\n", ""), text
    # Select the region: counts inside + density.
    p.tool("v")
    p.click_img(cx - 800, cy + 800)
    assert p.sel()["id"] == rid
    p.frames(2)
    text = panel.inner_text()
    area_mm2 = 2000 * 2000 * MPP * MPP * 1e-6
    density = round(4 / area_mm2)
    assert "In selected tumor" in text and f"{density:,} /mm²" in text, (text, density)
    assert "/mm²)" in text and "Mm²" not in text, text
    status = p.page.get_by_test_id("viewer-status").inner_text()
    assert "5 points" in status and "1 regions" in status, status
    p.shot("marks-counts")


@test
def names_toggle_n(p: P):
    cx, cy = TISSUE
    p.add({"type": "box", "x": cx - 1000, "y": cy - 600, "w": 2000, "h": 1200}, attributes={"name": "Region A"})
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    sx, sy = p.js("return c.view.toScreen(arg[0], arg[1]);", [cx - 1000, cy - 600])
    probe = "const ctx = c.bulk.getContext('2d'); const d = c.dpr; return ctx.getImageData(Math.round((arg[0] + 6) * d), Math.round((arg[1] - 8) * d), 1, 1).data[3];"
    assert p.ui()["showNames"] is False
    off = p.js(probe, [sx, sy])
    p.page.keyboard.press("n")
    p.frames(2)
    on = p.js(probe, [sx, sy])
    assert p.ui()["showNames"] is True and on > 150 and off == 0, (off, on)
    p.shot("names-on")
    p.page.keyboard.press("n")
    assert p.ui()["showNames"] is False


@test
def import_qupath_geojson(p: P):
    cx, cy = TISSUE
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[cx - 900, cy - 900], [cx + 900, cy - 900], [cx + 900, cy + 900], [cx - 900, cy + 900], [cx - 900, cy - 900]], [[cx - 200, cy - 200], [cx + 200, cy - 200], [cx + 200, cy + 200], [cx - 200, cy + 200], [cx - 200, cy - 200]]]},
             "properties": {"objectType": "annotation", "name": "Imported tumour", "classification": {"name": "Tumor", "color": [200, 0, 0]}, "isLocked": True}},
            {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[[[cx + 1200, cy], [cx + 1600, cy], [cx + 1600, cy + 400], [cx + 1200, cy]]], [[[cx + 1800, cy], [cx + 2200, cy], [cx + 2200, cy + 400], [cx + 1800, cy]]]]},
             "properties": {"objectType": "annotation", "classification": {"name": "stroma"}}},
            {"type": "Feature", "geometry": {"type": "MultiPoint", "coordinates": [[cx - 300, cy - 600], [cx + 300, cy - 600], [cx, cy + 600]]},
             "properties": {"objectType": "annotation", "classification": {"name": "lymphocytes"}}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[cx - 1500, cy + 1200], [cx + 1500, cy + 1200]]}, "properties": {}},
            {"type": "Feature", "geometry": {"type": "GeometryCollection", "geometries": []}, "properties": {}},
        ],
    }
    f = p.out / "import-fixture.geojson"
    f.write_text(json.dumps(fc))
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    p.page.locator('[data-testid="wsi-viewer"] input[type=file]').set_input_files(str(f))
    p.page.get_by_text("Imported 6 objects, skipped 1").wait_for(timeout=5000)
    a = p.anns()
    kinds = sorted(f"{x['geometry']['type']}:{x['label']}" for x in a)
    assert sorted(kinds) == sorted(["polygon:tumor", "multipolygon:stroma", "keypoint:lymphocytes", "keypoint:lymphocytes", "keypoint:lymphocytes", "polyline:tumor"]), kinds
    poly = next(x for x in a if x["geometry"]["type"] == "polygon")
    assert poly["locked"] is True and poly["attributes"]["name"] == "Imported tumour" and poly["attributes"]["source"] == "import", poly
    assert len(poly["geometry"]["holes"]) == 1 and len(poly["geometry"]["points"]) == 4
    assert all(x["provenance"] == "human-created" for x in a)
    # One undo step removes the whole import.
    p.page.keyboard.press(f"{MOD}+z")
    assert p.anns() == []
    p.page.keyboard.press(f"Shift+{MOD}+z")
    assert len(p.anns()) == 6
    p.frames(3)
    p.shot("import")


@test
def pan_to_selection_from_sidebar(p: P):
    far = (100000, 45000)
    p.add({"type": "box", "x": far[0], "y": far[1], "w": 1500, "h": 1000})
    p.fit(TISSUE[0] - 2000, TISSUE[1] - 1500, 4000, 3000)
    sx, sy = p.js("return c.view.toScreen(arg[0], arg[1]);", far)
    assert sx > p.js("return c.view.width;"), "fixture should start off-screen"
    p.page.get_by_role("tab", name="Labels").click()
    p.page.locator("[data-testid='on-this-item'] [data-testid='annotation-row'] button", has_text="Box 1500").first.click()
    p.page.wait_for_timeout(1200)
    p.frames(3)
    w, h = p.js("return [c.view.width, c.view.height];")
    corners = [p.js("return c.view.toScreen(arg[0], arg[1]);", q) for q in [far, (far[0] + 1500, far[1] + 1000)]]
    assert all(0 <= x <= w and 0 <= y <= h for x, y in corners), corners
    p.page.get_by_role("tab", name="Slides").click()
    p.shot("pan-to-selection")


@test
def space_pan_with_drawing_tool(p: P):
    p.fit(TISSUE[0] - 3000, TISSUE[1] - 2000, 6000, 4000)
    p.tool("r")
    box = p.page.locator('[data-testid="wsi-viewer"]').bounding_box()
    mid = (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    before = p.img(*mid)
    p.page.keyboard.down(" ")
    p.drag_px([mid, (mid[0] + 200, mid[1] + 100)])
    p.page.keyboard.up(" ")
    p.page.wait_for_timeout(600)
    p.frames(2)
    after = p.img(*mid)
    s = p.scale()
    assert near(before[0] - after[0], 200 / s, 30 / s) and near(before[1] - after[1], 100 / s, 30 / s), (before, after, s)
    assert p.anns() == [], "space-drag must not draw"
    # Space released: the box tool draws again.
    p.drag_img((TISSUE[0], TISSUE[1]), (TISSUE[0] + 800, TISSUE[1] + 500))
    assert len(p.anns()) == 1


@test
def brush_merge_and_eraser_hole(p: P):
    cx, cy = TISSUE
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    p.tool("r")
    p.drag_img((cx - 800, cy - 800), (cx + 800, cy + 800))
    a = p.anns()
    bid = a[0]["id"]
    assert p.sel()["id"] == bid
    p.tool("b")
    s = p.scale()
    brush_img = p.st.store("s => s.toolOptions.brush.size") / s
    p.drag_img((cx + 400, cy), (cx + 2200, cy))
    a = p.anns()
    assert len(a) == 1 and a[0]["id"] == bid and a[0]["geometry"]["type"] == "polygon", a
    area = region_area(a[0]["geometry"])
    expect = 1600 * 1600 + (2200 - 800) * brush_img + math.pi * (brush_img / 2) ** 2 / 2
    assert abs(area - expect) / expect < 0.06, (area, expect)
    # Stroke outside the selection (no Shift) makes a new region.
    p.drag_img((cx - 400, cy + 1500), (cx + 400, cy + 1500))
    assert len(p.anns()) == 2
    # Eraser punches a hole in the selected region.
    p.tool("v")
    p.click_img(cx - 400, cy - 400)
    assert p.sel()["id"] == bid
    p.tool("e")
    p.click_img(cx, cy)
    g = next(x for x in p.anns() if x["id"] == bid)["geometry"]
    assert g["type"] == "polygon" and len(g.get("holes", [])) == 1, g
    hole = shoelace(g["holes"][0])
    assert abs(hole - math.pi * (brush_img / 2) ** 2) / (math.pi * (brush_img / 2) ** 2) < 0.15, hole
    # Alt+brush erases as well.
    p.tool("b")
    p.click_img(cx - 400, cy - 400, modifiers=["Alt"])
    g = next(x for x in p.anns() if x["id"] == bid)["geometry"]
    assert len(g.get("holes", [])) == 2, g
    p.shot("brush-eraser")


@test
def eraser_across_regions_is_one_undo(p: P):
    cx, cy = TISSUE
    ids = [p.add({"type": "box", "x": cx - 1500 + k * 1100, "y": cy - 400, "w": 900, "h": 800}) for k in range(3)]
    p.add({"type": "box", "x": cx - 1500, "y": cy + 800, "w": 900, "h": 800}, label="stroma")
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    before = {x["id"]: x["geometry"] for x in p.anns()}
    p.tool("e")
    p.drag_img((cx - 1800, cy), (cx + 1800, cy), steps=30)
    after = {x["id"]: x for x in p.anns()}
    changed = [i for i in ids if after[i]["geometry"] != before[i]]
    assert changed == ids, f"stroke should cut all three tumor boxes: {changed}"
    assert all(after[i]["geometry"]["type"] == "multipolygon" for i in ids), [after[i]["geometry"]["type"] for i in ids]
    stroma = [x for x in after.values() if x["label"] == "stroma"][0]
    assert stroma["geometry"]["type"] == "box", "other labels are untouched"
    p.shot("eraser-multi")
    p.page.keyboard.press(f"{MOD}+z")
    restored = {x["id"]: x["geometry"] for x in p.anns()}
    assert restored == before, ("one undo restores every cut region", p.st.store("s => ({ past: s.past.length, n: s.annotations.length })"), {k: (before.get(k), restored.get(k)) for k in set(before) | set(restored) if before.get(k) != restored.get(k)})
    # Erasing a whole small region removes it.
    small = p.add({"type": "box", "x": cx + 1510, "y": cy - 1490, "w": 20, "h": 20})
    p.click_img(cx + 1520, cy - 1480)
    assert all(x["id"] != small for x in p.anns())


@test
def wand_new_shift_add_alt_subtract(p: P):
    cx, cy = TISSUE
    p.fit(cx - 2000, cy - 1333, 4000, 2667)
    p.settle()
    p.tool("g")
    seed = (cx, cy)
    p.click_img(*seed)
    p.page.wait_for_function("() => !window.__pathology.ui.busy && window.__pathology.scene.size > 0", timeout=15000)
    a = p.anns()
    assert len(a) == 1 and a[0]["geometry"]["type"] in ("polygon", "multipolygon"), a
    runner = p.js("return c.wandRunner;")
    assert runner == "worker", runner
    area0 = region_area(a[0]["geometry"])
    s = p.scale()
    view_area = p.js("return c.view.width * c.view.height;") / (s * s)
    print(f"      wand region: {area0 * s * s:.0f} screen px² ({100 * area0 / view_area:.2f}% of view)")
    assert area0 * s * s > 400 and area0 < view_area * 0.9, "the wand should grow a usable region, neither one nucleus nor the whole view"
    wid = a[0]["id"]
    p.shot("wand")
    # Shift-click on another spot adds to the selected region.
    for spot in [(cx - 1500, cy - 1000), (cx + 1500, cy + 800), (cx - 1200, cy + 1000), (cx + 1500, cy - 1000)]:
        p.click_img(*spot, modifiers=["Shift"])
        p.page.wait_for_function("() => !window.__pathology.ui.busy")
        p.frames(2)
        a = p.anns()
        if region_area(a[0]["geometry"]) > area0 * 1.02:
            break
    assert len(a) == 1 and a[0]["id"] == wid, a
    area1 = region_area(a[0]["geometry"])
    assert area1 > area0 * 1.02, (area0, area1)
    # Alt-click at the first seed subtracts its region again.
    p.click_img(*seed, modifiers=["Alt"])
    p.page.wait_for_function("() => !window.__pathology.ui.busy")
    p.frames(2)
    a = p.anns()
    area2 = region_area(a[0]["geometry"]) if a else 0
    assert area2 < area1 * 0.98, (area1, area2)
    p.shot("wand-after")


@test
def rotate_flip_overlay_alignment(p: P):
    cx, cy = TISSUE
    pid = p.add({"type": "polygon", "points": [[cx - 700, cy - 300], [cx + 900, cy - 500], [cx + 500, cy + 700], [cx - 600, cy + 400]]})
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    probe = (cx + 300, cy - 250)  # inside, away from the centroid

    def check(tag):
        # 1) Our overlay transform agrees with OSD's own conversion (flip handled by OSD mirroring).
        diff = p.js(
            """const [sx, sy] = c.view.toScreen(arg[0], arg[1]);
               const vp = c.viewer.viewport, W = vp.getContainerSize().x;
               const pt = vp.getCenter(); pt.x = vp.getFlip() ? W - sx : sx; pt.y = sy;
               const q = vp.viewerElementToImageCoordinates(pt);
               return Math.hypot(q.x - arg[0], q.y - arg[1]);""",
            probe,
        )
        assert diff < 1.0, (tag, diff)
        # 2) The polygon's fill is drawn at that point on the bulk layer.
        p.tool("v")
        p.page.keyboard.press("Escape")
        p.frames(2)
        alpha = p.js("const [sx, sy] = c.view.toScreen(arg[0], arg[1]); const d = c.dpr; return c.bulk.getContext('2d').getImageData(Math.round(sx * d), Math.round(sy * d), 1, 1).data[3];", probe)
        assert alpha > 0, (tag, "no overlay pixel at the polygon")
        # 3) A real click there hit-tests to the polygon.
        p.click_img(*probe)
        assert p.sel()["id"] == pid, (tag, p.sel())
        p.shot(f"align-{tag}")

    check("0")
    p.page.keyboard.press("Shift+r")
    p.page.wait_for_timeout(900)
    p.frames(3)
    assert p.ui()["rotation"] == 90
    check("rot90")
    p.page.get_by_role("button", name="Flip horizontally").click()
    p.page.wait_for_timeout(900)
    p.frames(3)
    assert p.ui()["flipped"] is True
    check("rot90-flip")
    # Drawing while rotated + flipped lands where the pointer is.
    p.tool("r")
    a_pt, b_pt = (cx + 1500, cy + 900), (cx + 2300, cy + 1500)
    p.drag_img(a_pt, b_pt)
    g = p.anns()[-1]["geometry"]
    assert near(g["x"], 1500 + cx, 25) and near(g["y"], 900 + cy, 25) and near(g["w"], 800, 25) and near(g["h"], 600, 25), g
    p.page.get_by_role("button", name="Rotate left").click()
    p.page.wait_for_timeout(900)
    assert p.ui()["rotation"] == 0


@test
def image_adjustments_change_pixels(p: P):
    cx, cy = TISSUE
    p.fit(cx - 6000, cy - 4000, 12000, 8000)
    p.settle()
    p.page.get_by_role("button", name="Image adjustments").click()
    pop = p.page.get_by_role("dialog")
    pop.wait_for()
    p.page.wait_for_timeout(300)
    pop_box = pop.bounding_box()

    def set_slider(name, key):
        s = pop.get_by_role("slider", name=name)
        s.focus()
        p.page.keyboard.press(key)
        p.frames(3)
        p.page.wait_for_timeout(150)

    def measure(tag=None):
        p.page.mouse.move(5, 5)
        p.page.wait_for_timeout(250)
        a = p.viewer_pixels(below=pop_box)
        if tag:
            Image.fromarray(a.astype(np.uint8)).save(p.out / f"pathology-adjust-{tag}.png")
        return a

    base = measure("base")

    def lum(a):
        return a.mean()

    def sat(a):
        return (a.max(axis=2) - a.min(axis=2)).mean()

    set_slider("Brightness", "Home")
    dark = measure("dark")
    set_slider("Brightness", "End")
    bright = measure("bright")
    assert lum(dark) < lum(base) - 20 and lum(bright) > lum(base) + 5 or lum(bright) > 250, (lum(dark), lum(base), lum(bright))
    set_slider("Brightness", "PageDown")  # back toward 1 is fiddly; use Reset below
    pop.get_by_role("button", name="Reset").click()
    p.frames(3)
    set_slider("Contrast", "End")
    hi = measure()
    assert hi.std() > base.std() * 1.2, (hi.std(), base.std())
    pop.get_by_role("button", name="Reset").click()
    set_slider("Gamma", "End")
    g = measure()
    assert lum(g) > lum(base) + 3, (lum(g), lum(base))
    pop.get_by_role("button", name="Reset").click()
    set_slider("Saturation", "Home")
    grey = measure()
    assert sat(grey) < 3 and sat(base) > sat(grey) + 5, (sat(base), sat(grey))
    p.shot("adjust-grey")
    pop.get_by_role("button", name="Reset").click()
    p.frames(3)
    back = measure()
    assert abs(lum(back) - lum(base)) < 2, (lum(back), lum(base))
    p.page.keyboard.press("Escape")


@test
def multi_select_shift_area_group_move_delete(p: P):
    cx, cy = TISSUE
    ids = [p.add({"type": "box", "x": cx - 1500 + k * 1100, "y": cy - 400, "w": 800, "h": 800}) for k in range(3)]
    mid = p.add({"type": "keypoint", "x": cx, "y": cy + 1200}, label="stroma")
    p.fit(cx - 3000, cy - 2000, 6000, 4000)
    p.tool("v")
    p.click_img(cx - 1100, cy)
    p.click_img(cx + 1100 - 400 + 400, cy, modifiers=["Shift"])
    assert sorted(p.sel()["ids"]) == sorted([ids[0], ids[2]]), p.sel()
    p.click_img(cx + 1100 - 400 + 400, cy, modifiers=["Shift"])  # toggles off
    assert p.sel()["ids"] == [ids[0]], p.sel()
    # Shift-drag rectangle on empty slide adds everything whose centre is inside.
    p.drag_img((cx - 1800, cy - 900), (cx + 1800, cy + 1500), modifiers=["Shift"])
    assert sorted(p.sel()["ids"]) == sorted(ids + [mid]), p.sel()
    p.shot("multi-select")
    # Dragging one selected body moves all of them, as one undo step.
    before = {x["id"]: x["geometry"] for x in p.anns()}
    p.drag_img((cx - 1100, cy), (cx - 600, cy + 300))
    after = {x["id"]: x["geometry"] for x in p.anns()}
    for i in ids:
        assert near(after[i]["x"] - before[i]["x"], 500, 15) and near(after[i]["y"] - before[i]["y"], 300, 15), (before[i], after[i])
    assert near(after[mid]["x"] - before[mid]["x"], 500, 15)
    assert len(p.sel()["ids"]) == 4, "group move keeps the selection"
    p.shot("multi-move")
    p.page.keyboard.press(f"{MOD}+z")
    assert {x["id"]: x["geometry"] for x in p.anns()} == before
    # A click (no drag) on a member narrows to it.
    p.click_img(cx - 1100, cy)
    assert p.sel()["ids"] == [ids[0]], p.sel()
    # Alt lasso replaces the selection.
    lasso = [(cx - 300, cy - 900), (cx + 1800, cy - 900), (cx + 1800, cy + 900), (cx - 300, cy + 900)]
    p.drag_img(lasso[0], lasso[0], via=lasso[1:], steps=6, modifiers=["Alt"])
    assert sorted(p.sel()["ids"]) == sorted(ids[1:]), p.sel()
    # Delete removes every selected annotation.
    p.page.keyboard.press("Delete")
    left = [x["id"] for x in p.anns()]
    assert sorted(left) == sorted([ids[0], mid]), left
    # Click on empty slide clears the selection.
    p.click_img(cx, cy - 1800)
    assert p.sel()["ids"] == []


@test
def exporters_content(p: P):
    cx, cy = TISSUE
    p.add({"type": "polygon", "points": [[cx, cy], [cx + 1000, cy], [cx + 1000, cy + 1000], [cx, cy + 1000]], "holes": [[[cx + 400, cy + 400], [cx + 600, cy + 400], [cx + 600, cy + 600], [cx + 400, cy + 600]]]})
    for k in range(3):
        p.add({"type": "keypoint", "x": cx + 100 + k * 100, "y": cy + 100})
    p.add({"type": "keypoint", "x": cx + 500, "y": cy + 500}, label="lymphocytes")  # inside the hole
    p.add({"type": "measurement", "kind": "length", "points": [[cx, cy], [cx, cy + 4000]], "space": "image", "stats": {"length_um": 1008}})
    out = p.page.evaluate(
        """async () => {
            const { registry } = await import('/src/extension-host/registry.ts');
            const { fetchProjects } = await import('/src/studio/lib/api.ts');
            const project = (await fetchProjects()).find((x) => x.id === 'pathology-wsi');
            const { useStudio } = await import('/src/studio/stores/studio.ts');
            const annotations = useStudio.getState().annotations;
            const itemId = annotations[0].itemId;
            const items = [{ id: itemId, name: 'slide', group: '', assets: project.assets.filter((a) => a.path.endsWith('.dzi')) }];
            const res = {};
            for (const id of ['qupath-geojson', 'asap-xml', 'point-counts-csv']) {
                const ex = await registry.loadImpl(`inkling.wsi.exporters.${id}`);
                res[id] = { name: ex.filename(project), text: await (await ex.build({ project, items, annotations })).text() };
            }
            return res;
        }"""
    )
    assert set(out) == {"qupath-geojson", "asap-xml", "point-counts-csv"}, out.keys()
    gj = json.loads(out["qupath-geojson"]["text"])
    assert gj["type"] == "FeatureCollection"
    types = sorted(f["geometry"]["type"] for f in gj["features"])
    assert types == ["LineString", "MultiPoint", "Point", "Polygon"], types
    poly = next(f for f in gj["features"] if f["geometry"]["type"] == "Polygon")
    rings = poly["geometry"]["coordinates"]
    assert len(rings) == 2 and rings[0][0] == rings[0][-1], "closed rings with a hole"
    props = poly["properties"]
    assert props["objectType"] == "annotation" and props["classification"]["name"] == "tumor"
    assert len(props["classification"]["color"]) == 3 and all(0 <= v <= 255 for v in props["classification"]["color"])
    assert near(props["measurements"]["Area µm^2"], (1e6 - 4e4) * MPP * MPP, 1), props
    mp = next(f for f in gj["features"] if f["geometry"]["type"] == "MultiPoint")
    assert len(mp["geometry"]["coordinates"]) == 3 and mp["properties"]["classification"]["name"] == "tumor"
    line = next(f for f in gj["features"] if f["geometry"]["type"] == "LineString")
    assert near(line["properties"]["measurements"]["Length µm"], 4000 * MPP, 0.01)

    root = ET.fromstring(out["asap-xml"]["text"])
    anns = root.find("Annotations")
    kinds = sorted((a.get("Type"), a.get("PartOfGroup")) for a in anns)
    assert kinds == sorted([("Polygon", "tumor"), ("Polygon", "tumor_exclusion"), ("Measurement", "tumor"), ("PointSet", "tumor"), ("Dot", "lymphocytes")]), kinds
    for a in anns:
        coords = a.find("Coordinates")
        orders = [int(c.get("Order")) for c in coords]
        assert orders == list(range(len(orders))) and all(float(c.get("X")) >= 0 for c in coords)
        assert a.get("Color", "").startswith("#") and len(a.get("Color")) == 7
    groups = {g.get("Name") for g in root.find("AnnotationGroups")}
    assert groups == {"tumor", "tumor_exclusion", "lymphocytes"}, groups

    lines = out["point-counts-csv"]["text"].strip().split("\n")
    assert lines[0] == "slide,class,points,regions,region_area,area_unit,points_per_mm2", lines[0]
    rows = {r.split(",")[1].strip('"'): r.split(",") for r in lines[1:]}
    assert rows["tumor"][2] == "3" and rows["tumor"][3] == "1" and rows["lymphocytes"][2] == "1", rows
    area_um2 = (1e6 - 4e4) * MPP * MPP
    assert near(float(rows["tumor"][4]), area_um2, 0.2) and rows["tumor"][5] == "um2"
    assert near(float(rows["tumor"][6]), 3 / (area_um2 * 1e-6), 0.1), rows["tumor"]
    for k, v in out.items():
        (p.out / v["name"]).write_text(v["text"])


@test
def perf_self_check(p: P):
    r = p.js("const r = await c.selfCheck(); return { index: r.index, mean: r.frames.mean, max: r.frames.max, stats: r.frames.stats };")
    print("      self-check:", json.dumps({"buildMs": round(r["index"]["buildMs"], 1), "appendMs": round(r["index"]["appendMs"], 3), "replaceMs": round(r["index"]["replaceMs"], 3), "removeMs": round(r["index"]["removeMs"], 3), "fullRebuildMs": round(r["index"]["fullRebuildMs"], 1), "modes": r["index"]["modes"], "frameMean": round(r["mean"], 2), "frameMax": round(r["max"], 1), "drawn": r["stats"]}))
    assert r["index"]["modes"] == ["patch"], r["index"]["modes"]
    assert r["index"]["appendMs"] < 3, r["index"]
    assert r["mean"] < 50, r


# --------------------------------------------------------------------------- runner


def main():
    only = None
    if "--only" in sys.argv:
        k = sys.argv.index("--only")
        only = set(sys.argv[k + 1].split(","))
        del sys.argv[k : k + 2]
    args = parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        st = open_studio(browser, args.port, DATASET, init_script=NO_HMR)
        p = P(st, out)
        p.wait_ready()
        for fn in TESTS:
            if only and fn.__name__ not in only:
                continue
            p.reset()
            t0 = time.time()
            n_err = len(st.errors)
            try:
                fn(p)
                errs = [e for e in st.errors[n_err:] if "favicon" not in e]
                assert not errs, f"page errors: {errs}"
                results.append((fn.__name__, True, time.time() - t0, ""))
                print(f"PASS {fn.__name__} ({time.time() - t0:.1f}s)")
            except Exception as e:  # noqa: BLE001
                results.append((fn.__name__, False, time.time() - t0, str(e)))
                print(f"FAIL {fn.__name__}: {e}")
                traceback.print_exc()
                try:
                    p.shot(f"FAIL-{fn.__name__}")
                except Exception:  # noqa: BLE001
                    pass
        assert all(d.get("annotations") is not None for d in st.saves), "intercepted saves are documents"
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
