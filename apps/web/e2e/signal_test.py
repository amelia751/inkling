"""ECG / waveform viewer end-to-end tests (Playwright, real mouse and keyboard).

    pnpm exec vite --port 5185 --strictPort          # in apps/web
    python3 e2e/signal_test.py --port 5185 [--only paper,review]

Saves go through harness.open_studio, so seed-data is never modified. Oracles are computed
independently in Python from the raw record (R peaks, extrema) and from the paper-scale
definition (mm/s, mm/mV, px/mm); pixels are read back from the rendered canvas.
"""

from __future__ import annotations

import base64
import io
import json
import math
import re
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).parent))
from harness import RUNTIME, Studio, launch, open_studio, parse_args, pick, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
REC = json.loads((ROOT / "seed-data/ecg-waveform/HR00001.json").read_text())
FS = REC["fs"]
ITEM = "ecg-waveform/HR00001.json"
LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]
CSS_MM = 96 / 25.4
VIEWPORT = (1600, 1000)
GUTTER, RIGHT, TRACK = 64, 6, 22

# The three legacy intervals of HR00001 (saved data predating beats/waves), served as the annotations
# GET by the harness so results never depend on what else has been saved.
BASELINE = [
    {"id": f"legacy-{i}", "itemId": ITEM, "label": "P wave", "geometry": {"type": "interval", "lead": lead, "start": a, "end": b},
     "provenance": "human-created", "author": "local-expert", "createdAt": "2026-10-29T18:12:04.044Z"}
    for i, (lead, a, b) in enumerate([("III", 1.926, 4.212), ("II", 5.415, 7.691), ("II", 5.823, 7.01)])
]

RELOADS = [0]

DEFAULT_DISPLAY = {
    "layout": "12x1", "prevLayout": "12x1", "focus": "II", "scale": "fit", "speed": 25, "gain": 10, "leadGain": {},
    "hp": 0.05, "notch": 0, "lp": 150, "snap": True, "marchOut": False, "panel": True,
}

OUT = Path(__file__).parent / ".artifacts" / "signal"


# ----------------------------------------------------------------------------- oracles

def raw_extremum(lead: str, t: float, radius: float = 0.05) -> float:
    """Time of max |x - mean| within ±radius s of t on the raw lead (independent of the app's filters)."""
    x = REC["leads"][lead]
    a, b = max(0, round((t - radius) * FS)), min(len(x) - 1, round((t + radius) * FS))
    m = sum(x[a : b + 1]) / (b - a + 1)
    i = max(range(a, b + 1), key=lambda j: abs(x[j] - m))
    return i / FS


def raw_r_peaks(lead: str = "II") -> list[float]:
    """Crude independent R-peak list: local maxima above 60% of the record max, ≥ 300 ms apart."""
    x = REC["leads"][lead]
    thr = 0.6 * max(x)
    peaks: list[int] = []
    for i in range(1, len(x) - 1):
        if x[i] >= thr and x[i] >= x[i - 1] and x[i] >= x[i + 1]:
            if peaks and i - peaks[-1] < 0.3 * FS:
                if x[i] > x[peaks[-1]]:
                    peaks[-1] = i
            else:
                peaks.append(i)
    return [p / FS for p in peaks]


def decode_atr(b: bytes) -> list[dict[str, Any]]:
    """Independent MIT-format annotation decoder (WFDB annot(5))."""
    out: list[dict[str, Any]] = []
    p, t, chan = 0, 0, 0
    while p + 1 < len(b):
        (w,) = struct.unpack_from("<H", b, p)
        p += 2
        a, i = w >> 10, w & 0x3FF
        if a == 0 and i == 0:
            break
        if a == 59:  # SKIP: 32-bit interval, high word first
            hi, lo = struct.unpack_from("<HH", b, p)
            p += 4
            t += (hi << 16) | lo
        elif a == 61:
            v = i & 0xFF
            out[-1]["sub"] = v - 256 if v > 127 else v
        elif a == 62:
            chan = i
            out[-1]["chan"] = i
        elif a == 63:
            out[-1]["aux"] = b[p : p + i].decode()
            p += i + (i & 1)
        elif a == 60:
            pass
        else:
            t += i
            out.append({"sample": t, "code": a, "chan": chan})
    return out


# ----------------------------------------------------------------------------- page helpers

def boot(browser, port: int, *, dsf: float = 1, display: dict | None = None, device_px_per_mm: float | None = None, theme: str = "dark") -> Studio:
    disp = {**DEFAULT_DISPLAY, **(display or {})}
    init = (
        "try {"
        f"localStorage.setItem('studio.signal.display.v1', {json.dumps(json.dumps(disp))});"
        + (f"localStorage.setItem('studio.signal.devicePxPerMm.v1', '{device_px_per_mm}');" if device_px_per_mm else "localStorage.removeItem('studio.signal.devicePxPerMm.v1');")
        + f"localStorage.setItem('app-theme', '{theme}');"
        "} catch (e) {}"
    )
    st = open_studio(browser, port, "ecg-waveform", viewport=VIEWPORT, init_script=init, device_scale_factor=dsf, fixture_annotations=BASELINE)
    # Count main-frame navigations: a Vite full reload (another session editing a shared module)
    # wipes in-memory state mid-test; main() retries such a test once.
    navs = [0]

    def on_nav(f) -> None:
        if f == st.page.main_frame:
            navs[0] += 1
            if navs[0] > 1:
                RELOADS[0] += 1

    st.page.on("framenavigated", on_nav)
    st.page.wait_for_selector("[data-testid=signal-canvas]")
    wait_until(lambda: "Hz" in (st.store("s => s.viewerStatus") or ""), msg="viewer status")
    settle(st)
    return st


def settle(st: Studio, ms: int = 350) -> None:
    """Let the DSP worker finish and React repaint."""
    st.page.wait_for_timeout(ms)
    wait_until(lambda: not st.page.locator("text=/^Filtered|^Unfiltered/").first.locator("svg").count(), msg="filter spinner", timeout=10)


def wait_until(fn: Callable[[], Any], *, timeout: float = 10, msg: str = "") -> Any:
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {msg}: {last}")


def expect(fn: Callable[[], Any], msg: str) -> Any:
    """Poll a store/page condition after a real input event instead of sleeping a fixed time."""
    return wait_until(fn, timeout=4, msg=msg)


def anns(st: Studio, kind: str | None = None) -> list[dict]:
    """This item's annotations; `kind` is a strip-chart kind (stored as core span / instant with
    attributes.kind = interval | beat | wave | rhythm) or "class"."""
    flt = "" if not kind else " && a.geometry.type === 'class'" if kind == "class" else f" && (a.attributes || {{}}).kind === '{kind}'"
    return st.store(f"s => s.annotations.filter(a => a.itemId === '{ITEM}'{flt})")


def window(st: Studio) -> tuple[float, float]:
    m = re.search(r"([\d.]+)–([\d.]+) s of", st.store("s => s.viewerStatus"))
    assert m, st.store("s => s.viewerStatus")
    return float(m.group(1)), float(m.group(2))


class Geo:
    """Screen geometry of the 12×1 fit layout (re-derived here, independently of layout.ts)."""

    def __init__(self, st: Studio, rows: int = 12, cols: int = 1, gutter: float = GUTTER):
        b = st.page.locator("[data-testid=signal-canvas]").bounding_box()
        self.cx, self.cy, self.w, self.h = b["x"], b["y"], b["width"], b["height"]
        self.gutter = gutter
        self.pw = self.w - gutter - RIGHT
        self.ph = self.h - TRACK
        self.rows, self.cols = rows, cols
        self.rh = self.ph / rows
        self.t0, self.t1 = window(st)
        self.span = self.t1 - self.t0
        self.pps = self.pw / self.span

    def x(self, t: float, col: int = 0) -> float:
        colspan = self.span / self.cols
        return self.cx + self.gutter + col * self.pw / self.cols + (t - self.t0 - col * colspan) * self.pps

    def t(self, x: float) -> float:
        return self.t0 + (x - self.cx - self.gutter) / self.pps

    def y(self, row: int, frac: float = 0.5) -> float:
        return self.cy + self.rh * (row + frac)

    def track_y(self) -> float:
        return self.cy + self.ph + TRACK / 2


def drag(st: Studio, a: tuple[float, float], b: tuple[float, float], *, mods: list[str] | None = None, steps: int = 12) -> None:
    pg = st.page
    for m in mods or []:
        pg.keyboard.down(m)
    pg.mouse.move(*a)
    pg.mouse.down()
    pg.mouse.move(*b, steps=steps)
    pg.mouse.up()
    for m in reversed(mods or []):
        pg.keyboard.up(m)
    pg.wait_for_timeout(60)


def click(st: Studio, p: tuple[float, float], mods: list[str] | None = None) -> None:
    for m in mods or []:
        st.page.keyboard.down(m)
    st.page.mouse.click(*p)
    for m in reversed(mods or []):
        st.page.keyboard.up(m)
    st.page.wait_for_timeout(60)


def press(st: Studio, key: str) -> None:
    st.page.keyboard.press(key)
    st.page.wait_for_timeout(60)


def seg(st: Studio, group: str, name: str) -> None:
    st.page.get_by_role("group", name=group).get_by_role("button", name=name, exact=True).click()
    settle(st, 150)


def history(st: Studio) -> int:
    return st.store("s => s.past.length")


def readout(st: Studio) -> str:
    return st.page.get_by_test_id("caliper-readout").inner_text()


def canvas_hash(st: Studio, css_rect: tuple[float, float, float, float] | None = None) -> int:
    return st.page.evaluate(
        """(r) => { const c = document.querySelector('[data-testid=signal-canvas]'); const k = c.width / c.getBoundingClientRect().width;
        const [x, y, w, h] = r ? r.map(v => Math.round(v * k)) : [0, 0, c.width, c.height];
        const d = c.getContext('2d').getImageData(x, y, w, h).data; let s = 0;
        for (let i = 0; i < d.length; i += 3) s = (s * 31 + d[i]) | 0; return s; }""",
        list(css_rect) if css_rect else None,
    )


MEASURE_JS = """
(args) => {
  const c = document.querySelector('[data-testid=signal-canvas]');
  const dpr = c.width / c.getBoundingClientRect().width;
  const W = c.width, H = c.height;
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  const isMajor = ([r, g, b, a]) => a >= 60 && a <= 120 && r > g + 40;
  const isGray = ([r, g, b, a]) => a >= 25 && a <= 200 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 120;
  const runs = (flags, weights) => {   // centroids of consecutive true runs
    const out = []; let s = -1, acc = 0, wsum = 0;
    for (let i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) { if (s < 0) { s = i; acc = 0; wsum = 0; } const w = weights ? weights[i] : 1; acc += i * w; wsum += w; }
      else if (s >= 0) { out.push(acc / wsum); s = -1; }
    }
    return out;
  };
  const D = (v) => Math.round(v * dpr);
  const res = { dpr };
  if (args.grid) {
    const [x0, x1, y0, y1] = args.grid.map(D);
    const colFlags = [], rowFlags = [];
    for (let x = x0; x < x1; x++) { let n = 0; for (let y = y0; y < y1; y++) if (isMajor(px(x, y))) n++; colFlags.push(n > 0.5 * (y1 - y0)); }
    for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x++) if (isMajor(px(x, y))) n++; rowFlags.push(n > 0.5 * (x1 - x0)); }
    res.cols = runs(colFlags).map(v => (v + x0) / dpr);
    res.rows = runs(rowFlags).map(v => (v + y0) / dpr);
  }
  if (args.grayCol) {           // gray line centroids down one CSS column
    const [x, y0, y1] = args.grayCol; const xd = D(x); const f = [], w = [];
    for (let y = D(y0); y < D(y1); y++) { const p = px(xd, y); f.push(isGray(p)); w.push(p[3]); }
    res.grayRows = runs(f, w).map(v => (v + D(y0)) / dpr);
  }
  if (args.grayRow) {           // gray stroke centroids along one CSS row
    const [y, x0, x1] = args.grayRow; const yd = D(y); const f = [], w = [];
    for (let x = D(x0); x < D(x1); x++) { const p = px(x, yd); f.push(isGray(p)); w.push(p[3]); }
    res.grayCols = runs(f, w).map(v => (v + D(x0)) / dpr);
  }
  if (args.topProfile) {       // highest bright trace pixel per CSS column
    const [x0, x1, y0, y1] = args.topProfile; const out = [];
    for (let x = x0; x < x1; x++) { let top = null; const xd = D(x);
      for (let y = D(y0); y < D(y1); y++) { const [r, g, b, a] = px(xd, y); if (a > 150 && r > 200 && g > 200) { top = y / dpr; break; } }
      out.push(top); }
    res.top = out;
  }
  return res;
}
"""


def measure(st: Studio, **args) -> dict:
    return st.page.evaluate(MEASURE_JS, args)


def slope(xs: list[float]) -> float:
    """Least-squares spacing of evenly spaced positions; tolerant of missed lines (traces can hide a grid
    line): each position gets the integer index implied by the median gap."""
    gaps = sorted(b - a for a, b in zip(xs, xs[1:]))
    med = gaps[len(gaps) // 2]
    idx = [0]
    for g in (b - a for a, b in zip(xs, xs[1:])):  # step by whole gaps so rounding of each line can't accumulate
        idx.append(idx[-1] + max(1, round(g / med)))
    n = len(xs)
    mi, mx = sum(idx) / n, sum(xs) / n
    assert len(set(idx)) == n, "grid positions do not form a lattice"
    return sum((i - mi) * (x - mx) for i, x in zip(idx, xs)) / sum((i - mi) ** 2 for i in idx)


def near(a: float, b: float, tol: float, what: str) -> None:
    assert abs(a - b) <= tol, f"{what}: got {a:.4f}, expected {b:.4f} ± {tol}"


# ----------------------------------------------------------------------------- tests

def t_load_and_status(browser, port):
    st = boot(browser, port)
    status = st.store("s => s.viewerStatus")
    assert "500 Hz · 12 leads · 0.00–10.00 s of 10 s · fit · 10 mm/mV · 0.05–150 Hz" in status, status
    legacy = anns(st, "interval")
    assert len(legacy) == 3, "legacy intervals must load"
    # Stored v1 intervals migrate on load to core spans with the lead as channel.
    assert [(a["geometry"]["type"], a["geometry"]["channel"], a["geometry"]["start"]) for a in legacy] == [("span", "III", 1.926), ("span", "II", 5.415), ("span", "II", 5.823)], legacy
    st.shot("signal-12x1-dark", OUT)
    assert not st.errors, st.errors
    return st


def t_paper_scale(browser, port):
    """Grid, pulse and trace geometry at true paper scale, for dsf 1 and 2, two calibrations, two speeds, two layouts."""
    report = []
    for dsf in (1, 2):
        for k in (None, 4.2):
            for speed, layout in ((25, "12x1"), (50, "12x1"), (25, "3x4"), (100, "single")):
                st = boot(browser, port, dsf=dsf, display={"scale": "paper", "speed": speed, "gain": 10, "layout": layout, "hp": 0.5, "lp": 40}, device_px_per_mm=k * dsf if k else None)
                kk = k or CSS_MM
                gutter = max(GUTTER, math.ceil(0.2 * speed * kk) + 48)
                b = st.page.locator("[data-testid=signal-canvas]").bounding_box()
                plot_w, plot_h = b["width"] - gutter - RIGHT, b["height"] - TRACK
                # Grid: 5 mm major squares → 5k CSS px both ways (measured away from the top-right note box).
                m = measure(st, grid=[gutter + 2, gutter + plot_w * 0.8, 20, plot_h - 2])
                assert m["dpr"] == dsf, m["dpr"]
                assert len(m["cols"]) >= 8 and len(m["rows"]) >= 4, (len(m["cols"]), len(m["rows"]))
                sx, sy = slope(m["cols"]), slope(m["rows"])
                near(sx, 5 * kk, 0.02 * kk, f"dsf{dsf} k{kk:.3f} {speed}mm/s {layout}: major grid x spacing (5 mm)")
                near(sy, 5 * kk, 0.02 * kk, f"dsf{dsf} k{kk:.3f} {speed}mm/s {layout}: major grid y spacing (5 mm)")
                # Calibration pulse: 10 mm tall (1 mV at 10 mm/mV), 200 ms wide = 0.2·speed mm.
                rows = {"12x1": 12, "3x4": 4, "single": 1}[layout]
                rh = plot_h / rows
                row = 1 if rows > 1 else 0
                mid = rh * (row + 0.5)
                h, w = 10 * kk, 0.2 * speed * kk
                x0 = gutter - w - 8
                top, base = wait_until(
                    lambda: (lambda t, b_: (t, b_) if t and b_ else None)(
                        measure(st, grayCol=[x0 + w / 2, mid - rh / 2, mid + rh / 2])["grayRows"],
                        measure(st, grayCol=[x0 - 2, mid - rh / 2, mid + rh / 2])["grayRows"],
                    ),
                    timeout=3,
                    msg="calibration pulse drawn",
                )
                assert top and base, (top, base)
                height = base[0] - top[0]
                near(height, h, 0.6, f"dsf{dsf} {speed}mm/s {layout}: pulse height (10 mm)")
                edges = measure(st, grayRow=[top[0] + h / 2, x0 - 10, gutter])["grayCols"]
                assert len(edges) == 2, edges
                near(edges[1] - edges[0], w, 0.6, f"dsf{dsf} {speed}mm/s {layout}: pulse width (200 ms)")
                # Time axis: R peaks of lead II land at gutter + t·speed·k (single layout shows lead II only).
                if layout == "single":
                    t0, _ = window(st)
                    prof = measure(st, topProfile=[int(gutter), int(gutter + plot_w), 0, int(plot_h)])["top"]
                    pps = speed * kk
                    for tr in [t for t in raw_r_peaks() if t0 + 0.05 < t < t0 + plot_w / pps - 0.05][:3]:
                        xe = gutter + (tr - t0) * pps
                        lo, hi = int(xe - 0.04 * pps - gutter), int(xe + 0.04 * pps - gutter)
                        seg_ = [(v, i) for i, v in enumerate(prof[max(0, lo) : hi], start=max(0, lo)) if v is not None]
                        xf = gutter + min(seg_)[1]
                        near(xf, xe, 2.0, f"dsf{dsf} {speed}mm/s: R peak at t={tr:.3f}s x position")
                report.append(f"dsf{dsf} k={kk:.3f} {speed}mm/s {layout}: grid {sx:.3f}/{sy:.3f} px per 5 mm (exp {5*kk:.3f}), pulse {height:.2f}×{edges[1]-edges[0]:.2f} px (exp {h:.2f}×{w:.2f})")
                if dsf == 2 and k and speed == 25 and layout == "12x1":
                    st.shot("signal-paper-dsf2", OUT)
                if dsf == 1 and not k and layout == "3x4":
                    st.shot("signal-paper-3x4", OUT)
                assert not st.errors, st.errors
                st.page.context.close()
    # Browser zoom: a calibration made at devicePixelRatio 1 (4.2 device px/mm) viewed at ratio 2
    # (Chrome folds page zoom into the ratio) must give 2.1 CSS px/mm, i.e. the same physical mm.
    st = boot(browser, port, dsf=2, display={"scale": "paper", "speed": 25, "layout": "12x1"}, device_px_per_mm=4.2)
    gutter = max(GUTTER, math.ceil(0.2 * 25 * 2.1) + 48)
    b = st.page.locator("[data-testid=signal-canvas]").bounding_box()
    m = measure(st, grid=[gutter + 2, gutter + (b["width"] - gutter) * 0.8, 20, b["height"] - TRACK - 2])
    near(slope(m["cols"]), 5 * 2.1, 0.05, "zoom compensation: 5 mm at 2.1 CSS px/mm")
    report.append(f"zoom 200% (dpr 2, calibrated 4.2 device px/mm): grid {slope(m['cols']):.3f} CSS px per 5 mm (exp 10.5)")
    st.page.context.close()
    print("    " + "\n    ".join(report))


def t_calibration_ui(browser, port):
    for dsf in (1, 2):
        st = boot(browser, port, dsf=dsf, display={"scale": "paper", "speed": 25})
        st.page.get_by_role("button", name="Calibrate screen").click()
        dlg = st.page.get_by_role("dialog", name="Calibrate screen")
        handle = dlg.get_by_test_id("calib-handle")
        w0 = dlg.get_by_test_id("calib-bar").bounding_box()["width"]
        near(w0, round(CSS_MM * 85.6), 0.5, "initial bar = 85.6 mm at CSS 96 dpi")
        hb = handle.bounding_box()
        drag(st, (hb["x"] + hb["width"] / 2, hb["y"] + 20), (hb["x"] + hb["width"] / 2 + 37, hb["y"] + 20))
        handle.focus()
        for _ in range(3):
            st.page.keyboard.press("Shift+ArrowRight")
        st.page.keyboard.press("ArrowLeft")
        w1 = dlg.get_by_test_id("calib-bar").bounding_box()["width"]
        near(w1, w0 + 37 + 30 - 1, 0.5, "bar after drag +37 px and keys +30 −1")
        dlg.get_by_role("button", name="Save").click()
        settle(st)
        k = w1 / 85.6
        stored = float(st.page.evaluate("localStorage.getItem('studio.signal.devicePxPerMm.v1')"))
        near(stored, k * dsf, 1e-6, "stored device px/mm")
        gutter = max(GUTTER, math.ceil(0.2 * 25 * k) + 48)
        b = st.page.locator("[data-testid=signal-canvas]").bounding_box()
        m = measure(st, grid=[gutter + 2, gutter + (b["width"] - gutter) * 0.8, 20, b["height"] - TRACK - 2])
        near(slope(m["cols"]), 5 * k, 0.05, f"dsf{dsf}: grid after UI calibration")
        assert st.page.get_by_role("button", name="✓ Calibrated").count() == 1
        if dsf == 1:
            st.page.get_by_role("button", name="✓ Calibrated").click()
            st.shot("signal-calibrate-dialog", OUT)
            st.page.keyboard.press("Escape")
            assert st.page.get_by_role("dialog").count() == 0, "Esc closes the dialog"
        st.page.context.close()


def t_interval_tool(browser, port):
    st = boot(browser, port)
    seg(st, "Window", "2.5s")
    g = Geo(st)
    press(st, "i")
    press(st, "4")  # artifact
    drag(st, (g.x(0.5), g.y(2)), (g.x(1.0), g.y(2)))
    iv = [a for a in anns(st, "interval") if a["label"] == "artifact"]
    assert len(iv) == 1, iv
    geo = iv[0]["geometry"]
    assert geo["type"] == "span" and geo["channel"] == "III", geo
    near(geo["start"], 0.5, 0.004, "interval start")
    near(geo["end"], 1.0, 0.004, "interval end")
    drag(st, (g.x(1.5), g.y(5)), (g.x(2.0), g.y(5)), mods=["Shift"])
    iv = [a for a in anns(st, "interval") if a["label"] == "artifact"]
    assert len(iv) == 2 and iv[1]["geometry"]["channel"] == "all", iv
    assert st.store("s => s.selectedId") == iv[1]["id"], "new interval selected"
    # Undo / redo round trip.
    press(st, "Control+z")
    expect(lambda: len([a for a in anns(st, "interval") if a["label"] == "artifact"]) == 1, "undo removes the interval")
    press(st, "Control+Shift+z")
    expect(lambda: len([a for a in anns(st, "interval") if a["label"] == "artifact"]) == 2, "redo restores it")
    st.shot("signal-intervals", OUT)
    assert not st.errors, st.errors


def t_beat_tool_snap(browser, port):
    st = boot(browser, port)
    seg(st, "Window", "2.5s")
    g = Geo(st)
    press(st, "b")
    tr = raw_extremum("II", 1.15)
    click(st, (g.x(tr + 0.03), g.y(1)))
    beats = anns(st, "beat")
    assert len(beats) == 1, beats
    b0 = beats[0]["geometry"]
    assert b0["type"] == "instant" and b0["channel"] == "II" and beats[0]["attributes"]["code"] == "N", beats[0]
    near(b0["t"], raw_extremum("II", tr + 0.03), 0.004, "snapped beat at the raw ±50 ms extremum")
    assert beats[0]["label"] == "QRS complex", beats[0]["label"]
    # Shift-click: all leads; picker code V.
    st.page.get_by_role("group", name="Beat code").get_by_role("button", name="V", exact=True).click()
    tr2 = raw_extremum("II", 2.08)
    click(st, (g.x(tr2 - 0.02), g.y(4)), mods=["Shift"])
    b1a = anns(st, "beat")[-1]
    b1 = b1a["geometry"]
    assert b1["channel"] == "all" and b1a["attributes"]["code"] == "V", b1a
    # aVR's QRS is a broad negative deflection, so the 0.05–150 Hz display filter can move its extremum by a few ms.
    near(b1["t"], raw_extremum("aVR", tr2 - 0.02), 0.010, "snapped on the clicked lead (aVR)")
    # Snap off: the beat stays where clicked.
    st.page.get_by_role("button", name=re.compile("Snap to peak")).click()
    click(st, (g.x(0.70), g.y(0)))
    near(anns(st, "beat")[-1]["geometry"]["t"], 0.70, 0.004, "unsnapped beat")
    # Clicking an existing beat selects it instead of adding a duplicate.
    n = len(anns(st, "beat"))
    click(st, (g.x(b0["t"]), g.y(1)))
    assert len(anns(st, "beat")) == n and st.store("s => s.selectedId") == beats[0]["id"]
    st.shot("signal-beats", OUT)
    assert not st.errors, st.errors


def t_wave_tool(browser, port):
    st = boot(browser, port)
    seg(st, "Window", "2.5s")
    g = Geo(st)
    press(st, "q")
    press(st, "2")  # QRS complex
    tr = raw_extremum("II", 1.15)
    drag(st, (g.x(tr - 0.05), g.y(1)), (g.x(tr + 0.06), g.y(1)))
    w = anns(st, "wave")[-1]
    ge = w["geometry"]
    assert ge["type"] == "span" and w["attributes"]["wave"] == "QRS" and ge["channel"] == "II" and w["label"] == "QRS complex", w
    near(ge["start"], tr - 0.05, 0.004, "QRS onset")
    near(ge["end"], tr + 0.06, 0.004, "QRS offset")
    near(w["attributes"]["peak"], tr, 0.01, "QRS peak ≈ R")
    press(st, "1")  # P wave
    drag(st, (g.x(tr - 0.2), g.y(1)), (g.x(tr - 0.1), g.y(1)))
    assert anns(st, "wave")[-1]["attributes"]["wave"] == "P"
    press(st, "3")  # T wave, Shift = all leads
    drag(st, (g.x(tr + 0.15), g.y(3)), (g.x(tr + 0.4), g.y(3)), mods=["Shift"])
    t = anns(st, "wave")[-1]
    assert t["attributes"]["wave"] == "T" and t["geometry"]["channel"] == "all", t
    press(st, "4")  # artifact → falls back to QRS
    drag(st, (g.x(2.0), g.y(1)), (g.x(2.1), g.y(1)))
    a = anns(st, "wave")[-1]
    assert a["attributes"]["wave"] == "QRS" and a["label"] == "QRS complex", a
    # Measurements panel reflects the waves: PR = QRS onset − P onset.
    pr = st.page.locator("dt:has-text('PR') + dd").inner_text()
    exp_pr = round((ge["start"] - anns(st, "wave")[1]["geometry"]["start"]) * 1000)
    assert pr == f"{exp_pr} ms", (pr, exp_pr)
    st.shot("signal-waves", OUT)
    assert not st.errors, st.errors


def t_rhythm_tool(browser, port):
    st = boot(browser, port)
    g = Geo(st)
    press(st, "y")
    pick(st.page, "Rhythm", "(AFIB")
    drag(st, (g.x(1.0), g.track_y()), (g.x(4.0), g.track_y()))
    r = anns(st, "rhythm")
    assert len(r) == 1 and r[0]["attributes"]["rhythm"] == "(AFIB" and r[0]["geometry"]["channel"] == "rhythm" and r[0]["label"] == "(AFIB", r
    near(r[0]["geometry"]["start"], 1.0, 0.01, "rhythm start")
    near(r[0]["geometry"]["end"], 4.0, 0.01, "rhythm end")
    # Changing the picker while the episode is selected relabels it.
    pick(st.page, "Rhythm", "(AFL")
    assert anns(st, "rhythm")[0]["attributes"]["rhythm"] == "(AFL"
    assert st.page.get_by_role("button", name=re.compile(r"\(AFL")).count() >= 1, "listed in the side panel"
    assert not st.errors, st.errors


def t_caliper(browser, port):
    st = boot(browser, port)
    seg(st, "Window", "2.5s")
    g = Geo(st)
    press(st, "c")
    drag(st, (g.x(0.5), g.y(1) + 10), (g.x(1.0), g.y(1) - 10))
    txt = readout(st)
    m = re.match(r"Δt (\d+) ms · (\d+) bpm · ΔV \+?(-?[\d.]+) mV", txt)
    assert m, txt
    near(int(m.group(1)), 500, 2, "caliper Δt")
    near(int(m.group(2)), 120, 1, "caliper rate")
    px_per_mv = g.rh / 2 / 1.5
    near(float(m.group(3)), 20 / px_per_mv, 0.011, "caliper ΔV")
    # March-out: an extra line at t0 + 2Δt appears only when enabled.
    col = (g.x(1.5) - g.cx - 1, 40, 3, 60)
    before = canvas_hash(st, col)
    st.page.get_by_role("button", name=re.compile("March-out")).click()
    st.page.wait_for_timeout(100)
    assert canvas_hash(st, col) != before, "march-out line at t0+2Δt"
    st.shot("signal-caliper-marchout", OUT)
    press(st, "Escape")
    assert readout(st) == "", "Esc clears the caliper"
    # QT with RR from detected beats.
    st.page.get_by_role("button", name=re.compile("Detect beats")).click()
    wait_until(lambda: len(anns(st, "beat")) >= 10, msg="detection")
    times = sorted(a["geometry"]["t"] for a in anns(st, "beat"))
    tq = times[1] - 0.04
    drag(st, (g.x(tq), g.y(1)), (g.x(tq + 0.40), g.y(1)), mods=["Alt"])
    txt = readout(st)
    m = re.match(r"QT (\d+) ms · RR (\d+) ms \((\d+) bpm\) · QTc Bazett (\d+) ms · QTc Fridericia (\d+) ms", txt)
    assert m, txt
    qt, rr = int(m.group(1)) / 1000, int(m.group(2)) / 1000
    near(qt, 0.40, 0.003, "QT")
    near(rr, times[1] - times[0], 0.0011, "RR = preceding RR interval")
    near(int(m.group(4)) / 1000, qt / math.sqrt(rr), 0.0015, "QTc Bazett")
    near(int(m.group(5)) / 1000, qt / rr ** (1 / 3), 0.0015, "QTc Fridericia")
    st.shot("signal-caliper-qt", OUT)
    assert not st.errors, st.errors


def t_select_edits(browser, port):
    st = boot(browser, port)
    seg(st, "Window", "2.5s")
    g = Geo(st)
    press(st, "4")
    press(st, "i")
    drag(st, (g.x(0.5), g.y(0)), (g.x(1.0), g.y(0)))
    iv_id = st.store("s => s.selectedId")
    press(st, "q")
    press(st, "2")
    tr = raw_extremum("II", 1.15)
    drag(st, (g.x(tr - 0.05), g.y(1)), (g.x(tr + 0.06), g.y(1)))
    wv_id = st.store("s => s.selectedId")
    press(st, "b")
    click(st, (g.x(2.08), g.y(2)))
    bt_id = st.store("s => s.selectedId")
    press(st, "y")
    drag(st, (g.x(0.3), g.track_y()), (g.x(1.3), g.track_y()))
    rh_id = st.store("s => s.selectedId")
    press(st, "v")
    ann = lambda i: next(a for a in anns(st) if a["id"] == i)  # noqa: E731
    get = lambda i: ann(i)["geometry"]  # noqa: E731
    peak = lambda i: ann(i)["attributes"]["peak"]  # noqa: E731

    # Interval: end edge, then body move.
    drag(st, (g.x(1.0), g.y(0)), (g.x(1.2), g.y(0)))
    near(get(iv_id)["end"], 1.2, 0.004, "interval end dragged")
    drag(st, (g.x(0.8), g.y(0)), (g.x(0.9), g.y(0)))
    near(get(iv_id)["start"], 0.6, 0.004, "interval moved: start")
    near(get(iv_id)["end"], 1.3, 0.004, "interval moved: end")
    # Wave: onset, offset, peak (top handle of the selected wave), move.
    w = get(wv_id)
    drag(st, (g.x(w["start"]), g.y(1)), (g.x(w["start"] - 0.02), g.y(1)))
    near(get(wv_id)["start"], w["start"] - 0.02, 0.004, "wave onset dragged")
    drag(st, (g.x(w["end"]), g.y(1)), (g.x(w["end"] + 0.03), g.y(1)))
    near(get(wv_id)["end"], w["end"] + 0.03, 0.004, "wave offset dragged")
    w, wp = get(wv_id), peak(wv_id)
    drag(st, (g.x(wp), g.y(1, 0) + 5), (g.x(wp + 0.02), g.y(1, 0) + 5))
    near(peak(wv_id), wp + 0.02, 0.004, "wave peak dragged")
    w, wp = get(wv_id), peak(wv_id)
    mid = (w["start"] + wp) / 2
    drag(st, (g.x(mid), g.y(1, 0.8)), (g.x(mid + 0.05), g.y(1, 0.8)))
    near(get(wv_id)["start"], w["start"] + 0.05, 0.004, "wave moved: onset")
    near(peak(wv_id), wp + 0.05, 0.004, "wave moved: peak")
    # Beat: drag with snap to the next extremum.
    b = get(bt_id)
    drag(st, (g.x(b["t"]), g.y(2)), (g.x(b["t"] + 0.1), g.y(2)))
    near(get(bt_id)["t"], raw_extremum("III", b["t"] + 0.1), 0.006, "beat dragged and snapped")
    # Rhythm on the track: start, end, move.
    drag(st, (g.x(0.3), g.track_y()), (g.x(0.2), g.track_y()))
    near(get(rh_id)["start"], 0.2, 0.004, "rhythm start dragged")
    drag(st, (g.x(1.3), g.track_y()), (g.x(1.5), g.track_y()))
    near(get(rh_id)["end"], 1.5, 0.004, "rhythm end dragged")
    drag(st, (g.x(0.8), g.track_y()), (g.x(0.9), g.track_y()))
    near(get(rh_id)["start"], 0.3, 0.004, "rhythm moved")
    # Locked annotations do not move.
    st.act(f"s => s.update('{iv_id}', {{ locked: true }})")
    before = get(iv_id)
    drag(st, (g.x(1.3), g.y(0)), (g.x(1.5), g.y(0)))
    assert get(iv_id) == before, "locked interval must not move"
    # Hidden annotations are not hit.
    st.act(f"s => s.update('{bt_id}', {{ hidden: true }})")
    bt = get(bt_id)
    click(st, (g.x(bt["t"]), g.y(2)))
    assert st.store("s => s.selectedId") != bt_id, "hidden beat must not be selectable"
    st.shot("signal-select-edits", OUT)
    assert not st.errors, st.errors


def t_detect_review(browser, port):
    st = boot(browser, port)
    st.page.get_by_role("button", name=re.compile("Detect beats")).click()
    wait_until(lambda: len(anns(st, "beat")) >= 10, msg="detection")
    beats = sorted(anns(st, "beat"), key=lambda a: a["geometry"]["t"])
    assert len(beats) == 11, len(beats)
    assert all(a["provenance"] == "ai-suggested" and a["geometry"]["channel"] == "all" and a["attributes"]["code"] == "N" and a["attributes"]["source"] == "pan-tompkins" for a in beats)
    ref = raw_r_peaks()
    assert len(ref) == 11, ref
    for a, r in zip(beats, ref):
        near(a["geometry"]["t"], r, 0.012, "detected beat vs raw R peak")
    st.shot("signal-detected", OUT)
    sel = lambda: st.store("s => s.selectedId")  # noqa: E731
    get = lambda i: next((a for a in anns(st) if a["id"] == i), None)  # noqa: E731
    press(st, "Tab")
    assert sel() == beats[0]["id"]
    press(st, "Enter")
    assert get(beats[0]["id"])["provenance"] == "human-created"
    assert sel() == beats[1]["id"], "Enter advances"
    press(st, "Shift+V")
    b1 = get(beats[1]["id"])
    assert b1["attributes"]["code"] == "V" and b1["provenance"] == "human-corrected", b1
    press(st, "Tab")
    assert sel() == beats[2]["id"]
    press(st, "Delete")
    assert get(beats[2]["id"]) is None, "Delete rejects"
    assert sel() == beats[3]["id"], "Delete advances"
    press(st, "Shift+Tab")
    assert sel() == beats[10]["id"], "Shift+Tab: no unreviewed beat before → wraps to the last one"
    # Re-detect: replaces unreviewed detector beats, keeps reviewed ones, one undo step.
    h = history(st)
    st.page.get_by_role("button", name=re.compile("Detect beats")).click()
    wait_until(lambda: history(st) == h + 1, msg="re-detect commit")
    after = anns(st, "beat")
    assert len(after) == 11, len(after)
    assert sum(a["provenance"] == "ai-suggested" for a in after) == 9
    press(st, "Control+z")
    expect(lambda: len(anns(st, "beat")) == 10 and history(st) == h, "undo re-detect in one step")
    press(st, "Control+Shift+z")
    expect(lambda: len(anns(st, "beat")) == 11, "redo re-detect")
    assert not st.errors, st.errors


def t_layouts(browser, port):
    st = boot(browser, port)
    press(st, "b")
    seg(st, "Layout", "3×4")
    g = Geo(st, rows=4, cols=4)
    click(st, (g.cx + g.gutter + g.pw * 2.5 / 4, g.y(0)))
    b = anns(st, "beat")[-1]["geometry"]
    assert b["channel"] == "V1", b
    near(b["t"], 6.25, 0.06, "3×4 column 3 starts at 5 s (2.5 s columns)")
    click(st, (g.cx + g.gutter + g.pw * 0.5, g.y(3)))
    b = anns(st, "beat")[-1]["geometry"]
    assert b["channel"] == "II", b
    near(b["t"], 5.0, 0.06, "rhythm strip spans the whole 10 s")
    click(st, (g.cx + g.gutter + g.pw * 3.5 / 4, g.y(2)))
    assert anns(st, "beat")[-1]["geometry"]["channel"] == "V6"
    st.shot("signal-3x4", OUT)
    seg(st, "Layout", "6×2")
    g = Geo(st, rows=6, cols=2)
    click(st, (g.cx + g.gutter + g.pw * 0.75, g.y(0)))
    b = anns(st, "beat")[-1]["geometry"]
    assert b["channel"] == "V1", b
    near(b["t"], 7.5, 0.06, "6×2 chest column is the second 5 s")
    st.shot("signal-6x2", OUT)
    seg(st, "Layout", "1")
    g = Geo(st, rows=1)
    click(st, (g.x(3.3), g.y(0)))
    assert anns(st, "beat")[-1]["geometry"]["channel"] == "II"
    st.shot("signal-single", OUT)
    assert not st.errors, st.errors


def t_filters(browser, port):
    st = boot(browser, port, display={"hp": 0, "notch": 0, "lp": 0})
    badge = lambda: st.page.locator("text=/^(Filtered|Unfiltered)/").first.inner_text()  # noqa: E731
    assert badge() == "Unfiltered", badge()
    h0 = canvas_hash(st)
    pick(st.page, "High-pass (baseline wander)", "0.5 Hz")
    settle(st)
    assert badge() == "Filtered 0.5–∞ Hz", badge()
    h1 = canvas_hash(st)
    assert h1 != h0, "HP changes trace pixels"
    pick(st.page, "Mains notch", "50 Hz")
    settle(st)
    pick(st.page, "Low-pass (muscle noise)", "40 Hz")
    settle(st)
    assert badge() == "Filtered 0.5–40 Hz · 50 Hz notch", badge()
    assert canvas_hash(st) not in (h0, h1)
    assert "0.5–40 Hz · 50 Hz notch" in st.store("s => s.viewerStatus")
    st.shot("signal-filtered", OUT)
    for lbl in ("High-pass (baseline wander)", "Mains notch", "Low-pass (muscle noise)"):
        pick(st.page, lbl, "off")
    settle(st)
    expect(lambda: badge() == "Unfiltered" and canvas_hash(st) == h0, "filters off restores the raw trace")
    # Annotation times are unaffected by filtering (display only).
    assert len(anns(st)) == 3 and not st.saves, "filters never write annotations"
    assert not st.errors, st.errors


def t_navigation(browser, port):
    st = boot(browser, port)
    seg(st, "Window", "2.5s")
    ov = st.page.get_by_label("Record overview: click or drag to move the window")
    ob = ov.bounding_box()
    xo = lambda t: ob["x"] + GUTTER + t / 10 * (ob["width"] - GUTTER - 6)  # noqa: E731
    drag(st, (xo(1.25), ob["y"] + 20), (xo(6.0), ob["y"] + 20))
    t0, t1 = window(st)
    near(t0, 6.0 - 1.25, 0.03, "overview drag centres the window")
    press(st, "ArrowRight")
    near(window(st)[0], t0 + 0.25, 0.01, "→ scrolls 10%")
    press(st, "Shift+ArrowLeft")
    near(window(st)[0], t0 + 0.25 - 2.5, 0.01, "Shift+← scrolls a window")
    assert st.store("s => s.itemIndex") == 0, "arrows are claimed by the viewer, not item navigation"
    press(st, "=")
    near(window(st)[1] - window(st)[0], 2.0, 0.01, "+ zooms in")
    press(st, "-")
    near(window(st)[1] - window(st)[0], 2.5, 0.01, "− zooms out")
    # Drag-pan with the select tool on empty canvas.
    g = Geo(st)
    w0 = window(st)[0]
    drag(st, (g.x(w0 + 2.0), g.y(0)), (g.x(w0 + 1.0), g.y(0)))
    near(window(st)[0], w0 + 1.0, 0.02, "drag pans")
    press(st, "PageDown")
    assert st.store("s => s.itemIndex") == 1, "PageDown stays item navigation"
    assert not st.errors, st.errors


def t_lead_menu(browser, port):
    st = boot(browser, port)
    g = Geo(st)
    click(st, (g.cx + 14, g.y(6)))
    menu = st.page.get_by_role("menu", name="Lead V1")
    assert menu.count() == 1
    menu.get_by_role("menuitemradio", name="20").click()
    settle(st, 150)
    disp = json.loads(st.page.evaluate("localStorage.getItem('studio.signal.display.v1')"))
    assert disp["leadGain"] == {"V1": 20}, disp["leadGain"]
    # V1's calibration pulse is twice V2's (fit mode: 10 mm/mV ≙ row/3).
    x0 = GUTTER - min(0.2 * g.pps, GUTTER - 48) - 8
    hts = []
    for row in (6, 7):
        top = measure(st, grayCol=[x0 + 3, g.y(row, 0) - g.cy, g.y(row, 1) - g.cy])["grayRows"]
        base = measure(st, grayCol=[x0 - 2, g.y(row, 0) - g.cy, g.y(row, 1) - g.cy])["grayRows"]
        hts.append(base[0] - top[0])
    near(hts[0] / hts[1], 2.0, 0.08, "per-lead gain doubles the pulse")
    near(hts[1], g.rh / 2 / 1.5, 0.8, "fit pulse = 1 mV")
    click(st, (g.cx + 14, g.y(6)))
    st.page.get_by_role("menuitem", name="Focus this lead").click()
    settle(st, 150)
    disp = json.loads(st.page.evaluate("localStorage.getItem('studio.signal.display.v1')"))
    assert disp["layout"] == "single" and disp["focus"] == "V1", disp
    st.shot("signal-focus-v1", OUT)
    g = Geo(st, rows=1)
    click(st, (g.cx + 14, g.y(0)))
    st.page.get_by_role("menuitem", name="Show all leads").click()
    disp = json.loads(st.page.evaluate("localStorage.getItem('studio.signal.display.v1')"))
    assert disp["layout"] == "12x1", disp
    assert not st.errors, st.errors


def t_statements(browser, port):
    st = boot(browser, port)
    panel = st.page.get_by_role("complementary", name="ECG measurements")
    panel.get_by_role("button", name="AF", exact=True).click()
    panel.get_by_role("button", name="LQRSV", exact=True).first.click()
    cls = anns(st, "class")
    assert sorted(a["label"] for a in cls) == ["Atrial fibrillation", "Low QRS voltages"], cls
    assert {a["attributes"]["snomed"] for a in cls} == {"164889003", "251146004"}
    assert next(a for a in cls if a["label"] == "Low QRS voltages")["attributes"]["source"] == "dataset-dx"
    # The sidebar's single-class control (setClass) must not wipe SNOMED statements.
    st.act(f"s => s.setClass('{ITEM}', 'P wave', 'local-expert')")
    labels = sorted(a["label"] for a in anns(st, "class"))
    assert labels == ["Atrial fibrillation", "Low QRS voltages", "P wave"], labels
    panel.get_by_role("button", name="AF", exact=True).click()
    assert "Atrial fibrillation" not in [a["label"] for a in anns(st, "class")], "chip toggles off"
    st.shot("signal-statements", OUT)
    assert not st.errors, st.errors


def t_multiselect(browser, port):
    st = boot(browser, port)
    st.page.get_by_role("button", name=re.compile("Detect beats")).click()
    wait_until(lambda: len(anns(st, "beat")) == 11, msg="detection")
    beats = sorted(anns(st, "beat"), key=lambda a: a["geometry"]["t"])
    g = Geo(st)
    press(st, "v")
    click(st, (g.x(beats[0]["geometry"]["t"]), g.y(4)))
    click(st, (g.x(beats[8]["geometry"]["t"]), g.y(4)), mods=["Shift"])
    got = st.store("s => s.selectedIds")
    assert sorted(got) == sorted([beats[0]["id"], beats[8]["id"]]), (got, beats[0]["id"], beats[8]["id"], [a["geometry"]["t"] for a in beats])
    click(st, (g.x(beats[8]["geometry"]["t"]), g.y(4)), mods=["Shift"])
    assert st.store("s => s.selectedIds") == [beats[0]["id"]], "Shift-click toggles off"
    # Rubber band over 2.5–5.0 s on leads I–II (shift-drag on empty plot) adds beats 3, 4, 5.
    drag(st, (g.x(2.5), g.y(0, 0.7)), (g.x(5.0), g.y(1, 0.3)), mods=["Shift"])
    in_band = [a["id"] for a in beats if 2.5 <= a["geometry"]["t"] <= 5.0]
    assert len(in_band) == 3, in_band
    chosen = st.store("s => s.selectedIds")
    assert sorted(chosen) == sorted([beats[0]["id"], *in_band]), (chosen, in_band)
    st.shot("signal-multiselect", OUT)
    # Band over lead II 5.3–7.8 s also selects the legacy intervals there.
    drag(st, (g.x(5.3), g.y(1, 0.9)), (g.x(5.9), g.y(1, 0.95)), mods=["Shift"])
    ivs = [a["id"] for a in anns(st, "interval") if a["geometry"]["channel"] == "II"]
    assert set(ivs) <= set(st.store("s => s.selectedIds")), "band selects overlapping intervals on its leads"
    st.act("s => s.selectMany(%s)" % json.dumps([beats[0]["id"], *in_band]))
    # Bulk accept: one undo step.
    h = history(st)
    press(st, "Enter")
    assert history(st) == h + 1
    got = {a["id"]: a for a in anns(st, "beat")}
    assert all(got[i]["provenance"] == "human-created" for i in [beats[0]["id"], *in_band])
    assert sum(a["provenance"] == "ai-suggested" for a in got.values()) == 7
    # Bulk code change: one undo step; undo restores all.
    st.act("s => s.selectMany(%s)" % json.dumps([beats[0]["id"], *in_band]))
    h = history(st)
    press(st, "Shift+A")
    assert history(st) == h + 1
    assert all(a["attributes"]["code"] == "A" for a in anns(st, "beat") if a["id"] in [beats[0]["id"], *in_band])
    press(st, "Control+z")
    expect(lambda: all(a["attributes"]["code"] == "N" for a in anns(st, "beat")), "undo bulk code change")
    # Bulk delete (shell): every selected annotation.
    press(st, "Delete")
    expect(lambda: len(anns(st, "beat")) == 7, "bulk delete removes 4")
    assert st.store("s => s.selectedIds") == []
    press(st, "Control+z")
    expect(lambda: len(anns(st, "beat")) == 11, "undo bulk delete")
    assert not st.errors, st.errors


def t_exporters(browser, port):
    st = boot(browser, port)
    st.page.get_by_role("button", name=re.compile("Detect beats")).click()
    wait_until(lambda: len(anns(st, "beat")) == 11, msg="detection")
    seg(st, "Window", "2.5s")
    g = Geo(st)
    press(st, "y")
    pick(st.page, "Rhythm", "(AFIB")
    drag(st, (g.x(0.5), g.track_y()), (g.x(2.0), g.track_y()))
    press(st, "q")
    press(st, "2")
    tr = raw_extremum("II", 1.15)
    drag(st, (g.x(tr - 0.05), g.y(1)), (g.x(tr + 0.06), g.y(1)))
    press(st, "i")
    press(st, "4")
    drag(st, (g.x(1.6), g.y(3)), (g.x(2.2), g.y(3)), mods=["Shift"])
    b64 = st.page.evaluate(
        """async () => {
        const { registry } = await import('/src/extension-host/registry.ts'); const items = await import('/src/studio/lib/items.ts');
        const st = await import('/src/studio/stores/studio.ts'); const api = await import('/src/studio/lib/api.ts');
        const project = (await api.fetchProjects()).find(p => p.id === 'ecg-waveform');
        const ctx = { project, items: items.projectItems(project), annotations: st.useStudio.getState().annotations };
        const out = {};
        for (const id of ['wfdb-atr', 'ecg-json', 'ecg-intervals-csv']) {
          const e = await registry.loadImpl('studio.timeseries.exporters.' + id);
          const u = new Uint8Array(await (await e.build(ctx)).arrayBuffer()); let s = '';
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          out[id] = { name: e.filename(project), data: btoa(s) };
        }
        return out; }"""
    )
    exp = OUT / "exports"
    exp.mkdir(parents=True, exist_ok=True)
    tar_bytes = base64.b64decode(b64["wfdb-atr"]["data"])
    (exp / b64["wfdb-atr"]["name"]).write_bytes(tar_bytes)
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
        names = tf.getnames()
        files = {n: tf.extractfile(n).read() for n in names}
    assert {"HR00001.atr", "HR00001.ii", "HR00001.hea", "RECORDS", "ANNOTATORS"} <= set(names), names
    assert files["RECORDS"].decode().split() == ["HR00001"]
    atr = decode_atr(files["HR00001.atr"])
    beats = sorted(a["geometry"]["t"] for a in anns(st, "beat"))
    got_beats = [a["sample"] for a in atr if a["code"] == 1]
    assert got_beats == [round(t * FS) for t in beats], (got_beats, beats)
    rh = [a for a in atr if a["code"] == 28]
    assert len(rh) == 1 and rh[0]["aux"] == "(AFIB", rh
    noise = [a for a in atr if a["code"] == 14]
    art = next(a["geometry"] for a in anns(st, "interval") if a["label"] == "artifact")
    near(art["start"], 1.6, 0.004, "artifact start")
    assert [(n["sample"], n.get("sub", 0)) for n in noise] == [(round(art["start"] * FS), -1), (round(art["end"] * FS), 0)], noise
    wv = decode_atr(files["HR00001.ii"])
    assert [a["code"] for a in wv] == [39, 1, 40], wv
    # Cross-check with the reference implementation (wfdb-python rdann).
    rd = None
    with tempfile.TemporaryDirectory() as d:
        for n, data in files.items():
            Path(d, n).write_bytes(data)
        script = (
            "import wfdb, json, sys; a = wfdb.rdann(sys.argv[1] + '/HR00001', 'atr');"
            "w = wfdb.rdann(sys.argv[1] + '/HR00001', 'ii');"
            "print(json.dumps({'s': [int(x) for x in a.sample], 'sym': a.symbol, 'aux': a.aux_note, 'sub': [int(x) for x in a.subtype], 'chan': [int(x) for x in a.chan], 'fs': a.fs, 'ws': [int(x) for x in w.sample], 'wsym': w.symbol}))"
        )
        try:
            out = subprocess.run(["uv", "run", "--quiet", "--with", "wfdb", "python", "-c", script, d], capture_output=True, text=True, timeout=180)
            rd = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 else None
            if rd is None:
                print("    rdann unavailable:", out.stderr[-400:])
        except Exception as e:  # noqa: BLE001
            print("    rdann unavailable:", e)
    if rd:
        assert [s for s, y in zip(rd["s"], rd["sym"]) if y == "N"] == got_beats, rd
        i = rd["sym"].index("+")
        assert rd["aux"][i] == "(AFIB", rd["aux"]
        assert [rd["sub"][k] for k, y in enumerate(rd["sym"]) if y == "~"] == [-1, 0], rd
        assert rd["wsym"] == ["(", "N", ")"], rd
        print(f"    rdann OK: {len(rd['s'])} annotations, fs={rd['fs']}, symbols {''.join(rd['sym'])}")
    # JSON and CSV.
    js = json.loads(base64.b64decode(b64["ecg-json"]["data"]))
    rec = js["records"][0]
    assert rec["fs"] == 500 and len(rec["beats"]) == 11 and len(rec["waves"]) == 1 and len(rec["rhythms"]) == 1
    assert rec["waves"][0]["onset_sample"] == round(rec["waves"][0]["onset"] * 500)
    csv_ = base64.b64decode(b64["ecg-intervals-csv"]["data"]).decode().splitlines()
    assert csv_[0].startswith("record,kind,lead,label,start_s") and any(f",interval,all,artifact,{art['start']}," in l for l in csv_), csv_
    for k, v in b64.items():
        (exp / v["name"]).write_bytes(base64.b64decode(v["data"]))
    assert not st.errors, st.errors


def t_light_theme_and_inspect(browser, port):
    st = boot(browser, port, theme="light")
    assert st.page.evaluate("document.documentElement.classList.contains('light')")
    st.page.get_by_role("button", name=re.compile("Detect beats")).click()
    wait_until(lambda: len(anns(st, "beat")) == 11, msg="detection")
    press(st, "Tab")
    sid = st.store("s => s.selectedId")
    rows = st.page.evaluate(
        f"""async () => {{ const {{ registry }} = await import('/src/extension-host/registry.ts'); const st = await import('/src/studio/stores/studio.ts');
        const {{ runtimeFor }} = await import('{RUNTIME}'); const inspect = await registry.loadImpl('studio.timeseries.inspectors.main');
        const s = st.useStudio.getState(); const a = s.annotations.find(x => x.id === '{sid}');
        return inspect(a, {{ env: s.env, project: null, item: {{ id: '{ITEM}' }}, runtime: runtimeFor('{ITEM}') }}); }}"""
    )
    d = dict(rows)
    assert d["Code"].startswith("N —") and d["Lead"] == "All leads" and "#" in d["Time"] and d["Provenance"].startswith("AI"), d
    st.shot("signal-light-theme", OUT)
    assert not st.errors, st.errors


TESTS = [
    t_load_and_status, t_paper_scale, t_calibration_ui, t_interval_tool, t_beat_tool_snap, t_wave_tool, t_rhythm_tool,
    t_caliper, t_select_edits, t_detect_review, t_layouts, t_filters, t_navigation, t_lead_menu, t_statements,
    t_multiselect, t_exporters, t_light_theme_and_inspect,
]


def main() -> int:
    global OUT
    only = None
    if "--only" in sys.argv:
        i = sys.argv.index("--only")
        only = set(sys.argv[i + 1].split(","))
        del sys.argv[i : i + 2]
    args = parse_args()
    OUT = Path(args.out) / "signal"
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        for t in TESTS:
            name = t.__name__[2:]
            if only and name not in only:
                continue
            t0 = time.time()
            try:
                for attempt in (1, 2):
                    RELOADS[0] = 0
                    try:
                        st = t(browser, args.port)
                        if st is not None:
                            st.page.context.close()
                        break
                    except Exception:
                        # A second main-frame navigation on any page means Vite reloaded it mid-test.
                        reloaded = RELOADS[0] > 0
                        for ctx in browser.contexts:
                            ctx.close()
                        if attempt == 2 or not reloaded:
                            raise
                        print(f"      {name}: dev server reloaded the page mid-test; retrying once")
                results.append((name, True, ""))
                print(f"PASS  {name}  ({time.time() - t0:.1f}s)")
            except Exception as e:  # noqa: BLE001
                results.append((name, False, str(e)))
                print(f"FAIL  {name}: {e}")
                traceback.print_exc(limit=3)
                for ctx in browser.contexts:
                    for p in ctx.pages:
                        try:
                            p.screenshot(path=str(OUT / f"FAIL-{name}.png"))
                        except Exception:  # noqa: BLE001
                            pass
                    ctx.close()
            for ctx in browser.contexts:
                ctx.close()
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
