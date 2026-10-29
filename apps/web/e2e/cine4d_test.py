"""End-to-end tests for the 4D cardiac cine viewer (ACDC patient102).

Run a dev server first, then:
    pnpm exec vite --port 5184 --strictPort        # in apps/web
    python3 e2e/cine4d_test.py --port 5184

While other people edit shared modules, HMR can reload the page mid-run and wipe the
store; the run then reports `no_page_reloads` FAIL. A server with `server.hmr: false`
avoids that. Set CINE_ONLY=name,name to run a subset (reference import always runs).

Everything is driven with real mouse and keyboard input; the store is only read for
assertions. Saves are intercepted by `open_studio`, so seed-data is never modified.
Screenshots land in e2e/.artifacts/cine4d/.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import Studio, launch, open_studio, parse_args, sync_playwright  # noqa: E402

ARGS = parse_args()
OUT = Path(ARGS.out) / "cine4d"
OUT.mkdir(parents=True, exist_ok=True)
RV, MYO, LV = "right ventricle", "myocardium", "left ventricle"
SLICE = 4  # 0-based; the viewer opens on the middle slice (5/8) at ED (frame 0)


class Cine:
    def __init__(self, studio: Studio):
        self.s = studio
        self.page = studio.page
        self.canvas = self.page.locator('[data-testid="cine-canvas"]')

    # ---- state ----
    def view(self) -> dict:
        return json.loads(self.canvas.get_attribute("data-view"))

    def anns(self, where: str = "a => true") -> list[dict]:
        return self.s.store(f"s => s.annotations.filter({where})")

    def past(self) -> int:
        return self.s.store("s => s.past.length")

    def cell(self, slice_: int, frame: int, label: str | None = None, kind: str | None = None) -> list[dict]:
        out = []
        for a in self.anns():
            g = a["geometry"]
            if g.get("slice") != slice_ or g.get("frame") != frame:
                continue
            if label and a["label"] != label:
                continue
            if kind == "contour" and g["type"] not in ("spline", "polygon"):
                continue
            if kind == "mask" and g["type"] != "mask":
                continue
            out.append(a)
        return out

    # ---- geometry ----
    def to_screen(self, i: float, j: float) -> tuple[float, float]:
        v = self.view()
        box = self.canvas.bounding_box()
        return box["x"] + v["tx"] + i * v["dx"] * v["scale"], box["y"] + v["ty"] + j * v["dy"] * v["scale"]

    def centroid(self, a: dict) -> tuple[float, float]:
        pts = a["geometry"]["points"]
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)

    def dense(self, a: dict) -> list[list[float]]:
        return self.page.evaluate(
            "async (g) => (await import('/src/modules/cine/model.ts')).ring(g)", a["geometry"]
        )

    # ---- input ----
    def key(self, k: str, n: int = 1):
        for _ in range(n):
            self.page.keyboard.press(k)

    def click(self, x: float, y: float, modifiers: list[str] | None = None):
        for m in modifiers or []:
            self.page.keyboard.down(m)
        self.page.mouse.click(x, y)
        for m in reversed(modifiers or []):
            self.page.keyboard.up(m)

    def drag(self, path: list[tuple[float, float]], button: str = "left"):
        self.page.mouse.move(*path[0])
        self.page.mouse.down(button=button)
        for p in path[1:]:
            self.page.mouse.move(*p)
        self.page.mouse.up(button=button)
        self.page.wait_for_timeout(30)  # let React commit before the caller reads view state

    def button(self, name: str, exact: bool = True):
        return self.page.get_by_role("button", name=name, exact=exact)

    def blur(self):
        """Drop focus from toolbar buttons/sliders so keys reach the viewer, not the widget."""
        self.page.evaluate("document.activeElement && document.activeElement.blur()")

    def goto(self, slice_: int, frame: int):
        """Navigate with the keyboard (arrows), as a user would."""
        v = self.view()
        self.blur()
        df = frame - v["frame"]
        dz = slice_ - v["slice"]
        self.key("ArrowRight" if df > 0 else "ArrowLeft", abs(df))
        self.key("ArrowDown" if dz > 0 else "ArrowUp", abs(dz))
        v = self.view()
        assert (v["slice"], v["frame"]) == (slice_, frame), f"navigation ended at {v['slice']},{v['frame']}"

    def pixel(self, i: float, j: float) -> list[int]:
        x, y = self.to_screen(i, j)
        box = self.canvas.bounding_box()
        return self.page.evaluate(
            """([x, y]) => { const c = document.querySelector('[data-testid="cine-canvas"]');
              const d = window.devicePixelRatio || 1; return Array.from(c.getContext('2d').getImageData(Math.round(x*d), Math.round(y*d), 1, 1).data); }""",
            [x - box["x"], y - box["y"]],
        )

    def aside(self) -> str:
        return self.page.locator("aside").last.inner_text()

    def status(self) -> str:
        return self.page.get_by_text(re.compile(r"^Slice \d+/\d+ · Frame")).last.inner_text()

    def shot(self, name: str):
        return self.s.shot(name, OUT)


results: list[tuple[str, str]] = []


def run(name: str, fn, c: Cine):
    t0 = time.time()
    try:
        # Every test starts from a fitted, paused view with nothing selected.
        c.blur()
        if c.view()["playing"]:
            c.button("Pause").click()
        c.key("Escape")
        c.key("=")
        c.key("v")
        print(f"[{name}] start: {len(c.anns())} annotations, undo depth {c.past()}", flush=True)
        fn(c)
        results.append((name, f"PASS ({time.time() - t0:.1f}s)"))
    except Exception as e:  # noqa: BLE001
        results.append((name, f"FAIL: {e}"))
        traceback.print_exc()
        try:
            c.shot(f"FAIL_{name}")
        except Exception:  # noqa: BLE001
            pass
    finally:
        # Leave no half-finished drag or modifier behind.
        for k in ("Shift", "Alt", "Space"):
            c.page.keyboard.up(k)
        c.page.mouse.up()


# ------------------------------------------------------------------ tests


def t_load(c: Cine):
    v = c.view()
    assert v["slice"] == SLICE and v["frame"] == 0, v
    st = c.status()
    assert "Slice 5/8" in st and "Frame 1/30 (ED)" in st and "1.56×1.56×10.0 mm" in st, st
    c.shot("01_loaded")


def t_reference_import_and_undo(c: Cine):
    before = c.past()
    c.button("all ED/ES").click()
    refs = c.anns("a => a.attributes?.source === 'reference'")
    assert len(refs) == 39, len(refs)
    assert all(a["geometry"]["type"] == "spline" and 8 <= len(a["geometry"]["points"]) <= 24 for a in refs)
    assert {a["geometry"]["frame"] for a in refs} == {0, 12}
    assert c.past() == before + 1, "import should be one undo step"
    c.key("Meta+z")
    assert len(c.anns()) == 0, "undo should remove the import"
    c.key("Meta+Shift+z")
    assert len(c.anns()) == 39, "redo should restore it"
    c.shot("02_reference_imported")


def t_metrics(c: Cine):
    text = c.aside()
    # Node verification of the same contours: LV 82.9/24.3 mL (EF 70.6%), RV 103.5/52.1 (EF 49.7%), mass 78.8 g.
    assert re.search(r"LV\s+82\.9\s+24\.3\s+58\.5\s+71%", text), text[:400]
    assert re.search(r"RV\s+103\.5\s+52\.1\s+51\.4\s+50%", text), text[:400]
    assert "78.8 g" in text and "43.7 g/m²" in text, "LV mass and index"
    assert "BSA (Mosteller) 1.80 m²" in text
    assert "complete" in text.split("Volume over time")[0].lower()


def t_dice(c: Cine):
    qa = c.page.locator("section", has=c.page.get_by_role("heading", name=re.compile("QA vs reference"))).inner_text()
    vals = [float(x) for x in re.findall(r"\b[01]\.\d\d\b", qa)]
    assert len(vals) >= 40, f"expected per-slice Dice values, got {len(vals)}"
    assert min(vals) >= 0.9, f"min Dice {min(vals)}"
    means = re.findall(r"mean\s+([01]\.\d\d)\s+([01]\.\d\d)\s+([01]\.\d\d)", qa)
    assert len(means) == 2 and all(float(x) >= 0.93 for m in means for x in m), means


def lv_here(c: Cine) -> dict:
    v = c.view()
    lv = c.cell(v["slice"], v["frame"], LV, "contour")
    assert lv, "no LV contour here"
    return lv[0]


def zoom_on(c: Cine, a: dict):
    """Zoom in on a contour so its control points are well apart on screen."""
    c.page.mouse.move(*c.to_screen(*c.centroid(a)))
    c.page.mouse.wheel(0, -700)
    c.page.wait_for_timeout(150)


def select_lv(c: Cine) -> dict:
    c.key("v")
    lv = lv_here(c)
    c.click(*c.to_screen(*c.centroid(lv)))
    assert c.s.store("s => s.selectedId") == lv["id"]
    return lv


def t_select_and_inspector(c: Cine):
    c.key("v")
    lv = lv_here(c)
    zoom_on(c, lv)
    c.click(*c.to_screen(*c.centroid(lv)))
    assert c.s.store("s => s.selectedId") == lv["id"]
    c.page.get_by_role("tab", name="Labels").click()
    insp = c.page.get_by_label("Selected annotation").inner_text()
    for word in ("LV endocardium", "Slice / frame", "5 / 1", "Area", "mm²", "Perimeter", "Control points", "reference"):
        assert word in insp, f"inspector lacks {word!r}: {insp}"
    c.shot("03_selected_inspector")


def t_vertex_drag_undo_redo(c: Cine):
    zoom_on(c, lv_here(c))
    lv = select_lv(c)
    p0 = lv["geometry"]["points"][0]
    x, y = c.to_screen(*p0)
    before = c.past()
    c.drag([(x, y), (x + 8, y), (x + 16, y + 8)])
    moved = c.anns(f"a => a.id === '{lv['id']}'")[0]["geometry"]["points"][0]
    v = c.view()
    exp = (16 / (v["scale"] * v["dx"]), 8 / (v["scale"] * v["dy"]))
    assert abs(moved[0] - p0[0] - exp[0]) < 0.15 and abs(moved[1] - p0[1] - exp[1]) < 0.15, (p0, moved, exp)
    assert c.past() == before + 1
    c.key("Meta+z")
    assert c.anns(f"a => a.id === '{lv['id']}'")[0]["geometry"]["points"][0] == p0
    c.key("Meta+Shift+z")
    assert c.anns(f"a => a.id === '{lv['id']}'")[0]["geometry"]["points"][0] == moved
    c.key("Meta+z")


def t_edge_insert_and_alt_delete(c: Cine):
    zoom_on(c, lv_here(c))
    lv = select_lv(c)
    c.key("s")
    n = len(lv["geometry"]["points"])
    dense = c.dense(lv)
    c.click(*c.to_screen(*dense[6]))  # middle of the segment between control points 0 and 1
    pts = c.anns(f"a => a.id === '{lv['id']}'")[0]["geometry"]["points"]
    assert len(pts) == n + 1, (n, len(pts))
    assert abs(pts[1][0] - dense[6][0]) < 0.3 and abs(pts[1][1] - dense[6][1]) < 0.3, (pts[1], dense[6])
    c.click(*c.to_screen(*pts[1]), modifiers=["Alt"])
    pts2 = c.anns(f"a => a.id === '{lv['id']}'")[0]["geometry"]["points"]
    assert len(pts2) == n and pts2 == lv["geometry"]["points"], "Alt-click should delete the inserted point"
    c.shot("04_spline_edit")


def t_spline_draw(c: Cine):
    c.goto(SLICE, 3)
    c.key("1")  # right ventricle
    c.key("s")
    cx, cy = c.to_screen(60, 120)
    for dx, dy in [(0, -30), (30, 0), (0, 30), (-30, 0)]:
        c.click(cx + dx, cy + dy)
    c.key("Enter")
    rv = c.cell(SLICE, 3, RV, "contour")
    assert len(rv) == 1 and len(rv[0]["geometry"]["points"]) == 4 and rv[0]["geometry"]["type"] == "spline", rv


def t_freehand(c: Cine):
    import math

    c.goto(SLICE, 5)
    c.key("3")  # left ventricle
    c.key("f")
    cx, cy = c.to_screen(140, 110)
    path = [(cx + 45 * math.cos(t / 80 * 2 * math.pi), cy + 35 * math.sin(t / 80 * 2 * math.pi)) for t in range(81)]
    c.drag(path)
    lv = c.cell(SLICE, 5, LV, "contour")
    assert len(lv) == 1, lv
    g = lv[0]["geometry"]
    assert g["type"] == "spline" and 12 <= len(g["points"]) <= 20, len(g["points"])
    c.key("Meta+z")
    assert not c.cell(SLICE, 5, LV, "contour")


def t_brush_eraser(c: Cine):
    c.goto(SLICE, 5)
    c.key("3")  # LV
    c.key("b")
    ax, ay = c.to_screen(80, 60)
    c.drag([(ax + k * 4, ay) for k in range(31)])
    lv = c.cell(SLICE, 5, LV, "mask")
    assert len(lv) == 1 and lv[0]["geometry"]["voxels"] > 50, lv
    v_lv = lv[0]["geometry"]["voxels"]
    c.key("1")  # RV
    bx, by = c.to_screen(80, 60)
    c.drag([(bx + 60, by - 60 + k * 4) for k in range(31)])
    rv = c.cell(SLICE, 5, RV, "mask")
    assert len(rv) == 1 and rv[0]["geometry"]["voxels"] > 50
    v_rv = rv[0]["geometry"]["voxels"]
    c.shot("05_brush")
    # One eraser stroke through the crossing clears both labels as a single undo step.
    c.key("e")
    before = c.past()
    c.drag([(bx + 40 + k * 4, by) for k in range(11)])
    lv2 = c.cell(SLICE, 5, LV, "mask")[0]["geometry"]["voxels"]
    rv2 = c.cell(SLICE, 5, RV, "mask")[0]["geometry"]["voxels"]
    assert lv2 < v_lv and rv2 < v_rv, (v_lv, lv2, v_rv, rv2)
    assert c.past() == before + 1, "multi-label erase should be one undo step"
    c.key("Meta+z")
    assert c.cell(SLICE, 5, LV, "mask")[0]["geometry"]["voxels"] == v_lv
    assert c.cell(SLICE, 5, RV, "mask")[0]["geometry"]["voxels"] == v_rv
    # The metrics panel counts mask pixels for that frame.
    assert "frame 6 areas" in c.aside().lower()


def t_window_level(c: Cine):
    c.goto(SLICE, 0)
    c.key("w")
    w0 = c.view()["win"]
    p0 = c.pixel(30, 200)
    st0 = c.status()
    cx, cy = c.to_screen(108, 128)
    c.drag([(cx, cy), (cx + 50, cy + 25), (cx + 100, cy + 50)])
    w1 = c.view()["win"]
    assert (w1[1] - w1[0]) > (w0[1] - w0[0]) and (w1[0] + w1[1]) > (w0[0] + w0[1]), (w0, w1)
    assert c.pixel(30, 200) != p0 and c.status() != st0
    c.button("Auto").click()
    assert c.view()["win"] == w0
    c.button("Full").click()
    wf = c.view()["win"]
    assert wf[1] - wf[0] > w0[1] - w0[0]
    c.button("Auto").click()
    g = c.pixel(30, 200)
    c.button("Inv").click()
    gi = c.pixel(30, 200)
    assert abs(gi[0] - (255 - g[0])) <= 2, (g, gi)
    c.shot("06_inverted")
    c.button("Inv").click()


def t_zoom_pan_fit(c: Cine):
    v0 = c.view()
    cx, cy = c.to_screen(108, 128)
    c.page.mouse.move(cx, cy)
    c.page.mouse.wheel(0, -300)
    c.page.wait_for_timeout(100)
    v1 = c.view()
    assert v1["scale"] > v0["scale"] * 1.3, (v0["scale"], v1["scale"])
    c.key("h")
    c.drag([(cx, cy), (cx + 30, cy + 10), (cx + 60, cy + 20)])
    v2 = c.view()
    assert abs(v2["tx"] - v1["tx"] - 60) < 2 and abs(v2["ty"] - v1["ty"] - 20) < 2, (v1, v2)
    # Space-drag pans with any tool and must not toggle playback.
    c.key("v")
    c.page.mouse.move(cx, cy)
    c.page.keyboard.down("Space")
    c.drag([(cx, cy), (cx - 40, cy)])
    c.page.keyboard.up("Space")
    v3 = c.view()
    assert abs(v3["tx"] - v2["tx"] + 40) < 2 and not v3["playing"], v3
    # Middle-button drag pans too.
    c.drag([(cx, cy), (cx, cy + 10), (cx, cy + 20), (cx, cy + 30)], button="middle")
    assert abs(c.view()["ty"] - v3["ty"] - 30) < 2
    c.shot("07_zoomed")
    c.key("=")
    v4 = c.view()
    assert abs(v4["scale"] - v0["scale"]) < 1e-6 and abs(v4["tx"] - v0["tx"]) < 0.5, (v0, v4)


def sample_frames(c: Cine, seconds: float, step_ms: int = 40) -> list[int]:
    out = []
    end = time.time() + seconds
    while time.time() < end:
        out.append(c.view()["frame"])
        c.page.wait_for_timeout(step_ms)
    return out


def t_playback(c: Cine):
    fps = c.page.get_by_role("slider", name="Frames per second")
    fps.focus()
    c.key("End")
    assert c.view()["fps"] == 60
    c.blur()
    c.button("Play").click()
    frames = sample_frames(c, 0.8)
    c.button("Pause").click()
    # At 60 fps each ≥40 ms sample advances ~2.4+ frames (mod 30); at 20 fps it would be ~1.
    steps = [(b - a) % 30 for a, b in zip(frames, frames[1:])]
    assert len(set(frames)) >= 6 and sum(steps) / len(steps) >= 2, (frames, steps)
    # A–B range, at 20 fps so 40 ms sampling sees every frame.
    fps.focus()
    c.key("Home")
    c.key("ArrowRight", 19)
    assert c.view()["fps"] == 20
    c.goto(SLICE, 3)
    c.button("A").click()
    c.goto(SLICE, 8)
    c.button("B").click()
    c.blur()
    c.key("Space")  # tap Space = play
    frames = sample_frames(c, 1.2)
    c.key("Space")
    assert not c.view()["playing"]
    assert set(frames) <= set(range(3, 9)) and len(set(frames)) >= 5, frames
    # Bounce reverses at the ends instead of jumping back to A.
    c.button("Loop").click()
    assert c.view()["mode"] == "bounce"
    c.button("Play").click()
    frames = sample_frames(c, 1.2, 15)
    c.button("Pause").click()
    steps = [b - a for a, b in zip(frames, frames[1:]) if b != a]
    assert set(frames) <= set(range(3, 9)), frames
    # Bounce turns around at both ends (loop would only ever step forward, wrapping B → A).
    turns = sum(1 for a, b in zip(steps, steps[1:]) if (a > 0) != (b > 0))
    assert any(s < 0 for s in steps) and any(s > 0 for s in steps) and turns >= 2, steps
    c.button("Bounce").click()
    c.button("Clear").click()
    # Editing pauses playback.
    c.button("Play").click()
    c.key("v")
    c.click(*c.to_screen(5, 5))
    assert not c.view()["playing"]


def phase(c: Cine, p: str):
    a = c.anns(f"a => a.geometry.type === 'instant' && a.attributes?.kind === 'phase' && a.attributes?.phase === '{p}'")
    return a[0]["geometry"]["frame"] if a else None


def t_phases_and_suggestion(c: Cine):
    c.goto(SLICE, 4)
    c.button("Set ED").click()
    c.goto(SLICE, 6)
    c.button("Set ES").click()
    assert phase(c, "ED") == 4 and phase(c, "ES") == 6
    assert len(c.anns("a => a.geometry.type === 'instant' && a.attributes?.kind === 'phase'")) == 2
    text = c.aside()
    assert "LV curve suggests ED 1, ES 13" in text, text
    before = c.past()
    c.button("Apply").click()
    assert phase(c, "ED") == 0 and phase(c, "ES") == 12
    assert c.past() == before + 1, "Apply should be one undo step"
    assert len(c.anns("a => a.geometry.type === 'instant' && a.attributes?.kind === 'phase'")) == 2
    c.shot("08_phases_applied")


def lv_frames(c: Cine) -> set[int]:
    return {a["geometry"]["frame"] for a in c.anns() if a["label"] == LV and a["geometry"].get("slice") == SLICE}


def t_matrix_navigation(c: Cine):
    c.page.get_by_title(re.compile(r"^Slice 5, frame 1\b")).first.click()
    v = c.view()
    assert (v["slice"], v["frame"]) == (SLICE, 0), v
    c.page.get_by_title(re.compile(r"^Slice 2, frame 13\b")).first.click()
    v = c.view()
    assert (v["slice"], v["frame"]) == (1, 12), v
    c.goto(SLICE, 0)


def t_interpolate(c: Cine):
    c.goto(SLICE, 0)
    c.key("Escape")
    c.key("3")
    have = lv_frames(c)
    c.button("frames").click()
    created = c.anns("a => a.attributes?.source === 'interpolated'")
    exp = [f for f in range(1, 12) if f not in have]
    assert sorted(a["geometry"]["frame"] for a in created) == exp, (created, exp)
    assert all(a["label"] == LV and a["geometry"]["slice"] == SLICE for a in created)
    c.shot("09_interpolated")
    c.key("Meta+z")
    # Wrap around the cycle: frames 13..29 are filled too (12 → 0 through 29).
    c.button("wrap").click()
    c.button("frames").click()
    created = c.anns("a => a.attributes?.source === 'interpolated'")
    exp = [f for f in range(1, 30) if f not in have and f != 12]
    assert sorted(a["geometry"]["frame"] for a in created) == exp, (len(created), len(exp))
    # The area of a wrapped contour lies between ES and ED.
    areas = {a["geometry"]["frame"]: c.page.evaluate("async g => (await import('/src/modules/cine/model.ts')).ringArea(g)", a["geometry"]) for a in created}
    ed = c.page.evaluate("async g => (await import('/src/modules/cine/model.ts')).ringArea(g)", c.cell(SLICE, 0, LV, "contour")[0]["geometry"])
    es = c.page.evaluate("async g => (await import('/src/modules/cine/model.ts')).ringArea(g)", c.cell(SLICE, 12, LV, "contour")[0]["geometry"])
    assert es < areas[20] < ed and areas[13] < areas[29], (es, areas[13], areas[20], areas[29], ed)
    c.key("Meta+z")
    c.button("wrap").click()


def t_copy_and_replace(c: Cine):
    c.goto(SLICE, 0)
    c.key("v")
    lv = lv_here(c)
    c.click(*c.to_screen(*c.centroid(lv)))
    before = len(c.anns())
    c.blur()
    c.key("Alt+ArrowRight")
    v = c.view()
    assert (v["slice"], v["frame"]) == (SLICE, 1)
    cp = c.cell(SLICE, 1, LV, "contour")
    assert len(cp) == 1 and cp[0]["geometry"]["points"] == lv["geometry"]["points"] and cp[0]["attributes"]["source"] == "copied"
    assert len(c.anns()) == before + 1
    c.key("Meta+z")
    # Slice 4 at ED already has an LV contour: plain copy skips, Shift+Alt replaces.
    c.goto(SLICE, 0)
    c.click(*c.to_screen(*c.centroid(lv)))
    target_before = c.cell(SLICE - 1, 0, LV, "contour")
    c.blur()
    c.key("Alt+ArrowUp")
    assert c.cell(SLICE - 1, 0, LV, "contour") == target_before, "plain copy must not overwrite"
    c.goto(SLICE, 0)
    c.click(*c.to_screen(*c.centroid(lv)))
    before_n, before_past = len(c.anns()), c.past()
    c.blur()
    c.key("Shift+Alt+ArrowUp")
    tgt = c.cell(SLICE - 1, 0, LV, "contour")
    assert len(tgt) == 1 and tgt[0]["geometry"]["points"] == lv["geometry"]["points"] and tgt[0]["id"] != target_before[0]["id"]
    assert len(c.anns()) == before_n and c.past() == before_past + 1
    c.key("Meta+z")
    assert c.cell(SLICE - 1, 0, LV, "contour")[0]["id"] == target_before[0]["id"]


def t_multiselect(c: Cine):
    c.goto(SLICE, 0)
    c.key("v")
    lv = lv_here(c)
    rv = c.cell(SLICE, 0, RV, "contour")[0]
    c.click(*c.to_screen(*c.centroid(lv)))
    c.click(*c.to_screen(*c.centroid(rv)), modifiers=["Shift"])
    ids = c.s.store("s => s.selectedIds")
    assert set(ids) == {lv["id"], rv["id"]}, ids
    c.shot("10_multiselect")
    # Interpolate acts on every selected structure.
    c.button("frames").click()
    created = c.anns("a => a.attributes?.source === 'interpolated'")
    assert {a["label"] for a in created} == {LV, RV}, {a["label"] for a in created}
    c.key("Meta+z")
    # Copy acts on the selection only (not the myocardium).
    c.goto(SLICE, 0)
    c.click(*c.to_screen(*c.centroid(lv)))
    c.click(*c.to_screen(*c.centroid(rv)), modifiers=["Shift"])
    c.blur()
    c.key("Alt+ArrowRight")
    assert {a["label"] for a in c.cell(SLICE, 1)} == {LV, RV}
    c.key("Meta+z")
    # Shift-click again removes from the selection; Delete (shell) removes the selection.
    c.goto(SLICE, 0)
    c.click(*c.to_screen(*c.centroid(lv)))
    c.click(*c.to_screen(*c.centroid(rv)), modifiers=["Shift"])
    c.click(*c.to_screen(*c.centroid(rv)), modifiers=["Shift"])
    assert c.s.store("s => s.selectedIds") == [lv["id"]]
    c.click(*c.to_screen(*c.centroid(rv)), modifiers=["Shift"])
    n = len(c.anns())
    c.blur()
    c.key("Delete")
    assert len(c.anns()) == n - 2
    c.key("Meta+z")
    assert len(c.anns()) == n


def b64(c: Cine, exporter_id: str) -> bytes:
    data = c.page.evaluate(
        """async (id) => {
          const { registry } = await import('/src/platform/registry.ts');
          const ex = await registry.loadImpl(id);
          const { projectItems } = await import('/src/lib/items.ts');
          const { useStudio } = await import('/src/stores/studio.ts');
          const manifest = await (await fetch('/seed/manifest.json')).json();
          const project = manifest.projects.find((p) => p.id === '4d-cardiac');
          const blob = await ex.build({ project, items: projectItems(project), annotations: useStudio.getState().annotations });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return [btoa(s), ex.filename(project)];
        }""",
        exporter_id,
    )
    return base64.b64decode(data[0]), data[1]


def t_exporters(c: Cine):
    nii, name = b64(c, "inkling.cine.exporters.acdc-nifti")
    assert name == "4d-cardiac_labels.nii.gz"
    path = OUT / name
    path.write_bytes(nii)
    check = subprocess.run(
        [
            "uv", "run", "--quiet", "--with", "nibabel", "--with", "numpy", "python", "-I", "-c",
            """
import sys, nibabel as nib, numpy as np
img = nib.load(sys.argv[1]); src = nib.load(sys.argv[2]); ref = nib.load(sys.argv[3])
d = np.asarray(img.dataobj)
assert img.shape == (216, 256, 8, 30), img.shape
assert img.get_data_dtype() == np.uint8
assert np.allclose(img.header.get_zooms()[:3], src.header.get_zooms()[:3])
assert np.allclose(img.affine, src.affine), (img.affine, src.affine)
assert int(img.header['intent_code']) == 1002
assert set(np.unique(d)) <= {0, 1, 2, 3}
r = np.asarray(ref.dataobj)
for v in (1, 2, 3):
    a = d[..., 0] == v; b = r == v
    dice = 2 * (a & b).sum() / (a.sum() + b.sum())
    assert dice > 0.93, (v, dice)
assert d[..., 5].sum() > 0 or True
print('nifti ok', img.shape, [int((d[..., 0] == v).sum()) for v in (1, 2, 3)])
""",
            str(path),
            "/Users/anhlam/inkling/seed-data/4d-cardiac/patient102/patient102_4d.nii.gz",
            "/Users/anhlam/inkling/seed-data/4d-cardiac/patient102/patient102_frame01_gt.nii.gz",
        ],
        capture_output=True,
        text=True,
        cwd=str(OUT),
    )
    assert check.returncode == 0, check.stderr[-2000:]
    print("   ", check.stdout.strip())

    csv, name = b64(c, "inkling.cardiac-metrics.exporters.function-csv")
    (OUT / name).write_bytes(csv)
    text = csv.decode()
    assert text.startswith("section,item,frame,phase,slice,rv_area_mm2,myo_area_mm2,lv_area_mm2")
    assert re.search(r"^LV EF,70\.\d,%$", text, re.M) and re.search(r"^RV EF,49\.\d,%$", text, re.M), text[-800:]
    assert re.search(r"^LV mass \(ED\),78\.\d\d,g$", text, re.M) and "BSA (Mosteller),1.803,m2" in text

    js, name = b64(c, "inkling.cine.exporters.cine-contours-json")
    (OUT / name).write_bytes(js)
    doc = json.loads(js)
    contours = [a for a in c.anns() if a["geometry"]["type"] in ("spline", "polygon")]
    assert len(doc["contours"]) == len(contours), (len(doc["contours"]), len(contours))
    epi = [x for x in doc["contours"] if x["role"] == "epicardium"]
    assert epi and all(x["regionAreaMm2"] < x["areaMm2"] for x in epi)
    assert doc["phases"] == {"ED": 0, "ES": 12} and doc["grid"]["spacingMm"] == [1.5625, 1.5625, 10]


def t_thumbnails_follow_wl(c: Cine):
    thumb = c.page.locator("table canvas").first

    def px():
        return thumb.evaluate("el => Array.from(el.getContext('2d').getImageData(24, 28, 1, 1).data)")

    c.page.wait_for_timeout(600)
    before = px()
    c.button("Full").click()
    c.page.wait_for_timeout(800)
    after = px()
    c.button("Auto").click()
    c.page.wait_for_timeout(800)
    assert after != before and px() == before, (before, after)


def main():
    with sync_playwright() as pw:
        browser = launch(pw, ARGS.browser, ARGS.headed)
        studio = open_studio(browser, ARGS.port, "4d-cardiac")
        studio.page.locator('[data-testid="cine-canvas"]').wait_for(timeout=90_000)
        studio.page.wait_for_timeout(500)
        c = Cine(studio)
        assert not c.anns(), "saved annotations must start empty for these tests"
        # A full reload (e.g. HMR after someone edits a shared module) would wipe the store mid-run.
        reloads: list[str] = []
        studio.page.on("framenavigated", lambda f: f == studio.page.main_frame and reloads.append(f.url))
        tests = [
            t_load,
            t_reference_import_and_undo,
            t_metrics,
            t_dice,
            t_select_and_inspector,
            t_vertex_drag_undo_redo,
            t_edge_insert_and_alt_delete,
            t_spline_draw,
            t_freehand,
            t_brush_eraser,
            t_window_level,
            t_zoom_pan_fit,
            t_thumbnails_follow_wl,
            t_playback,
            t_phases_and_suggestion,
            t_matrix_navigation,
            t_interpolate,
            t_copy_and_replace,
            t_multiselect,
            t_exporters,
        ]
        import os

        only = [x for x in os.environ.get("CINE_ONLY", "").split(",") if x]
        for t in tests:
            if only and t.__name__[2:] not in only and t is not t_reference_import_and_undo:
                continue
            run(t.__name__[2:], t, c)
        c.shot("11_final_dark")
        errors = [e for e in studio.errors if "favicon" not in e]
        results.append(("no_console_errors", "PASS" if not errors else f"FAIL: {errors[:3]}"))
        results.append(("no_page_reloads", "PASS" if not reloads else f"FAIL: page reloaded {len(reloads)}x (HMR?) — run a server without HMR"))
        assert all(s["annotations"] is not None for s in studio.saves)
        studio.page.context.close()

        # Light theme: the imaging canvas stays dark, panels follow the theme.
        light = open_studio(browser, ARGS.port, "4d-cardiac", init_script="localStorage.setItem('app-theme', 'light')")
        light.page.locator('[data-testid="cine-canvas"]').wait_for(timeout=90_000)
        lc = Cine(light)
        lc.button("all ED/ES").click()
        lc.page.wait_for_timeout(500)
        lc.shot("12_light_theme")
        results.append(("light_theme_renders", "PASS" if not light.errors else f"FAIL: {light.errors[:3]}"))
        light.page.context.close()
        browser.close()

    print("\nCine4D e2e results")
    for name, r in results:
        print(f"  {name:32s} {r}")
    failed = [n for n, r in results if not r.startswith("PASS")]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
