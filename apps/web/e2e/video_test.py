"""End-to-end tests for the video (endoscopy) viewer.

Run a dev server first (`pnpm exec vite --port 5183 --strictPort` in apps/web), then:

    python3 e2e/video_test.py --port 5183 --browser chromium   # uses installed Google Chrome (H.264)
    python3 e2e/video_test.py --port 5183 --browser webkit
    python3 e2e/video_test.py --port 5183 --browser firefox
    python3 e2e/video_test.py --port 5183 --browser chromium --force-fallback   # deletes window.VideoDecoder

Every page goes through harness.open_studio, so annotation saves are intercepted and
seed-data/.annotations is never written. Reference frames come from ffmpeg.
"""

from __future__ import annotations

import base64
import io
import json
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from harness import Studio, open_studio, parse_args, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
SEED = ROOT / "seed-data"
VIDEO_A = "video-endoscopy/16e7e461-a9a7-4b04-8d2c-155de3eb1c90.mp4"  # 199 frames, I/P only
VIDEO_B = "video-endoscopy/44c8c58b-e226-4f10-adf4-b8f91b71c476.mp4"  # 96 frames, B-frames
FFMPEG = "/opt/homebrew/bin/ffmpeg"
NO_WEBCODECS = "delete window.VideoDecoder; delete window.VideoEncoder;"


class V:
    """Driver for one Studio page showing the video viewer."""

    def __init__(self, studio: Studio, out: Path, tag: str):
        self.s = studio
        self.p = studio.page
        self.out = out
        self.tag = tag
        self.p.wait_for_selector("[data-testid=video-stage]", timeout=30000)
        self.install()
        self.wait_ready()

    def install(self):
        self.p.evaluate(
            """async () => {
                window.__s = (await import('/src/stores/studio.ts')).useStudio;
                window.__tracks = await import('/src/modules/video/tracks.ts');
            }"""
        )

    # ---- state ----
    def wait_ready(self):
        self.p.wait_for_function(
            """() => {
                const st = document.querySelector('[data-testid=video-stage]');
                const m = st?.dataset.decodeMode;
                const v = document.querySelector('[data-testid=video-element]');
                return (m === 'exact' || m === 'video') && st.dataset.clock === 'ready' && v && v.readyState >= 2;
            }""",
            timeout=30000,
        )
        self.p.wait_for_timeout(300)

    def mode(self) -> str:
        return self.p.eval_on_selector("[data-testid=video-stage]", "e => e.dataset.decodeMode")

    def status(self) -> str:
        return self.p.evaluate("() => window.__s.getState().viewerStatus")

    def item_id(self) -> str:
        return self.p.eval_on_selector("[data-testid=video-element]", "v => decodeURIComponent(new URL(v.src).pathname.replace(/^\\/seed\\//, ''))")

    def frames(self) -> int:
        return int(self.status().split("·")[0].split("/")[1])

    def frame(self) -> int:
        return int(self.p.eval_on_selector("[data-testid=video-stage]", "e => e.dataset.frame"))

    def state(self, expr: str):
        return self.p.evaluate(f"() => ({expr})(window.__s.getState())")

    def mine(self) -> list[dict]:
        item = self.item_id()
        return [a for a in self.state("s => s.annotations") if a["itemId"] == item]

    def new_since(self, before: list[dict]) -> list[dict]:
        ids = {a["id"] for a in before}
        return [a for a in self.mine() if a["id"] not in ids]

    def get(self, id_: str) -> dict | None:
        return next((a for a in self.mine() if a["id"] == id_), None)

    def shape_at(self, geometry: dict, frame: int):
        return self.p.evaluate("([g, f]) => window.__tracks.shapeAt(g, f)", [geometry, frame])

    # ---- navigation ----
    def wait_frame(self, n: int, timeout=10000):
        try:
            self.p.wait_for_function(
                f"() => document.querySelector('[data-testid=video-stage]')?.dataset.frame === '{n}' && window.__s.getState().viewerStatus.startsWith('Frame {n + 1}/')",
                timeout=timeout,
            )
        except Exception as e:
            raise AssertionError(f"frame {n} never presented: shown={self.frame()} status='{self.status()[:16]}'") from e

    def jump(self, n: int):
        box = self.p.get_by_label("Jump to frame")
        box.click()
        box.fill(str(n + 1))
        box.press("Enter")
        self.wait_frame(n)
        self.p.wait_for_timeout(80)

    def key(self, k: str, wait=60):
        self.p.keyboard.press(k)
        self.p.wait_for_timeout(wait)

    def tool(self, letter: str):
        self.blur()
        self.key(letter)

    def blur(self):
        self.p.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")

    def next_item(self):
        self.blur()
        self.key("PageDown", 200)
        self.wait_ready()

    # ---- geometry ----
    def cam(self) -> dict:
        return self.p.evaluate(
            """() => {
                const el = document.querySelector('[data-testid=video-stage]');
                const st = el.getBoundingClientRect();
                const [s, tx, ty] = el.dataset.camera.split(' ').map(Number);
                return { left: st.left, top: st.top, width: st.width, height: st.height, tx, ty, s };
            }"""
        )

    def scr(self, x: float, y: float) -> tuple[float, float]:
        c = self.cam()
        return c["left"] + c["tx"] + x * c["s"], c["top"] + c["ty"] + y * c["s"]

    def click_s(self, x, y, modifiers: list[str] | None = None):
        for k in modifiers or []:
            self.p.keyboard.down(k)
        self.p.mouse.click(x, y)
        for k in reversed(modifiers or []):
            self.p.keyboard.up(k)
        self.p.wait_for_timeout(60)

    def click_v(self, x, y, modifiers: list[str] | None = None):
        self.click_s(*self.scr(x, y), modifiers=modifiers)

    def drag_s(self, a, b, steps=8, hold: list[str] | None = None, button="left"):
        for k in hold or []:
            self.p.keyboard.down(k)
        self.p.mouse.move(*a)
        self.p.mouse.down(button=button)
        for i in range(1, steps + 1):
            self.p.mouse.move(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)
            self.p.wait_for_timeout(16)
        self.p.mouse.up(button=button)
        for k in reversed(hold or []):
            self.p.keyboard.up(k)
        self.p.wait_for_timeout(80)

    def drag_v(self, a, b, **kw):
        self.drag_s(self.scr(*a), self.scr(*b), **kw)

    def lane(self, row: str) -> dict:
        return self.p.locator(f"[data-row='{row}'] [data-lane]").first.bounding_box()

    def lane_x(self, row: str, frame: float) -> tuple[float, float]:
        b = self.lane(row)
        ppf = b["width"] / self.frames()
        return b["x"] + (frame + 0.5) * ppf, b["y"] + b["height"] / 2

    def overlay_alpha(self, x: float, y: float) -> int:
        """Max overlay alpha in a 5x5 screen-pixel window around video point (x, y)."""
        sx, sy = self.scr(x, y)
        return self.p.evaluate(
            """([x, y]) => {
                const c = document.querySelector('[data-testid=video-overlay]');
                const r = c.getBoundingClientRect(); const k = c.width / r.width;
                const d = c.getContext('2d').getImageData(Math.round((x - r.left) * k) - 2, Math.round((y - r.top) * k) - 2, 5, 5).data;
                let m = 0; for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]); return m;
            }""",
            [sx, sy],
        )

    def displayed_pixels(self) -> np.ndarray:
        """The frame on screen at video resolution: the exact-decode canvas read back, or in
        fallback mode the <video> element drawn to a canvas (WebKit: a screenshot of it, since
        its drawImage(video) readback is too soft to tell neighbouring frames apart)."""
        if self.mode() == "exact":
            url = self.p.eval_on_selector("[data-testid=video-frame]", "c => c.toDataURL('image/png')")
            return np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")).astype(np.int16)
        if self.p.context.browser.browser_type.name != "webkit":
            url = self.p.evaluate(
                """() => {
                    const v = document.querySelector('[data-testid=video-element]');
                    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
                    c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png');
                }"""
            )
            return np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(",")[1]))).convert("RGB")).astype(np.int16)
        c = self.cam()
        clip = {"x": c["left"] + c["tx"], "y": c["top"] + c["ty"], "width": 720 * c["s"], "height": 576 * c["s"]}
        im = Image.open(io.BytesIO(self.p.screenshot(clip=clip, animations="disabled"))).convert("RGB").resize((720, 576), Image.BILINEAR)
        return np.asarray(im).astype(np.int16)

    def shot(self, name: str) -> Path:
        return self.s.shot(f"video-{self.tag}-{name}", self.out)


# ------------------------------------------------------------------ references
def reference(video: str, n: int, out: Path) -> np.ndarray:
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{Path(video).stem[:8]}_{n}.png"
    if not path.exists():
        subprocess.run(
            [FFMPEG, "-v", "error", "-y", "-i", str(SEED / video), "-vf", f"select=eq(n\\,{n})", "-fps_mode", "passthrough", "-frames:v", "1", str(path)],
            check=True,
        )
    return np.asarray(Image.open(path).convert("RGB")).astype(np.int16)


def _small(a: np.ndarray) -> np.ndarray:
    # Luma at 1/8 scale: insensitive to each engine's chroma upsampling and scaler, still
    # sharply different between neighbouring frames of a moving endoscope.
    im = Image.fromarray(a.clip(0, 255).astype(np.uint8)).convert("L").resize((90, 72), Image.BOX)
    return np.asarray(im).astype(np.float32)


def mad(a: np.ndarray, b: np.ndarray) -> float:
    d = np.abs(_small(a) - _small(b))
    return float(d[12:60, 12:78].mean())  # centre only: badges and view buttons sit in the corners


# ------------------------------------------------------------------ helpers that create things
def draw_box_track(v: V, frame: int, box=(300, 200, 400, 280)) -> dict:
    v.jump(frame)
    v.tool("r")
    before = v.mine()
    v.drag_v(box[:2], box[2:])
    new = v.new_since(before)
    assert len(new) == 1, f"expected one new annotation, got {len(new)}"
    return new[0]


# ------------------------------------------------------------------ tests
def t_decode_mode(v: V, ctx):
    m, st = v.mode(), v.status()
    ctx["notes"].append(f"decode mode={m}; status='{st}'")
    if ctx["forced"]:
        assert m == "video", m
        assert "video seek" in st and "WebCodecs" in st, st
    elif ctx["browser"] == "chromium":
        assert m == "exact", f"Chrome should decode exactly, got {m}: {st}"
        assert "exact frames" in st
    else:
        assert m in ("exact", "video"), m
        assert ("exact frames" in st) if m == "exact" else ("video seek" in st)
    assert st.startswith("Frame 1/199"), st
    v.shot("loaded")


def pict_types(video: str) -> list[str]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "frame=pict_type", "-of", "csv=p=0", str(SEED / video)],
        check=True, capture_output=True, text=True,
    ).stdout
    return [line.strip().strip(",") for line in out.splitlines() if line.strip()]


def t_frame_exact(v: V, ctx):
    v.next_item()
    assert VIDEO_B in v.item_id(), v.item_id()
    refdir = ctx["out"] / "refs"
    types = pict_types(VIDEO_B)
    fallback = v.mode() == "video"
    report, misses, tolerated = [], [], []

    def check(n: int, how: str):
        v.p.wait_for_timeout(250)
        img = v.displayed_pixels()
        diffs = {k: mad(img, reference(VIDEO_B, k, refdir)) for k in (n - 1, n, n + 1) if 0 <= k < 96}
        best = min(diffs, key=diffs.get)
        others = [d for k, d in diffs.items() if k != n]
        # WebKit's fallback is judged from a resampled screenshot, so its absolute level is higher.
        cap = 25 if (fallback and ctx["browser"] == "webkit") else 12
        ok = best == n and diffs[n] < cap and diffs[n] < 0.85 * min(others)
        report.append(f"{how}{n}{types[n]}:{ {k: round(d, 1) for k, d in diffs.items()} }")
        if ok:
            return
        # Paused <video> seeks in WebKit sometimes composite the neighbouring picture even though
        # requestVideoFrameCallback reports the right frame (seen near the GOP start and on the
        # last frame): an engine limitation, and the reason exact (WebCodecs) mode exists. Real
        # WebKit has WebCodecs, so this path only runs when it is forcibly removed. Tolerated there.
        if fallback and ctx["browser"] == "webkit" and abs(best - n) <= 1:
            tolerated.append(f"{n}{types[n]}->{best}")
        else:
            misses.append(f"{how} frame {n}{types[n]}: best match {best} {diffs}")

    for n in [1, 2, 3, 37, 95]:
        v.jump(n)
        check(n, "jump")
    # Step with the keyboard from 37.
    v.jump(37)
    v.blur()
    for k, n in [(".", 38), ("ArrowRight", 39), ("ArrowLeft", 38), (",", 37), ("Shift+ArrowRight", 47), ("Shift+ArrowLeft", 37)]:
        v.key(k)
        v.wait_frame(n)
        check(n, k)
    ctx["notes"].append(" ".join(report))
    if tolerated:
        ctx["notes"].append(f"tolerated WebKit fallback off-by-one frames: {tolerated}")
    v.shot("frame-exact")
    assert not misses, f"{misses} | all: {report}"
    assert len(tolerated) <= len(report) // 3, f"too many off-by-one frames: {tolerated}"


def t_perframe_overlay(v: V, ctx):
    v.jump(10)
    v.p.get_by_role("radio", name="Per-frame").click()
    v.tool("r")
    before = v.mine()
    v.drag_v((250, 150), (350, 250))
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"]["type"] == "box" and new[0]["geometry"]["frame"] == 10, new
    assert v.frame() == 10
    assert v.overlay_alpha(250, 200) > 100, "box not drawn on its frame"
    v.blur()
    v.key(".")
    v.wait_frame(11)
    assert v.overlay_alpha(250, 200) == 0, "per-frame box leaked onto frame 11"
    v.key(",")
    v.wait_frame(10)
    assert v.overlay_alpha(250, 200) > 100, "box missing after stepping back"
    # Alt+B copies the selected per-frame shape to the next frame and moves there.
    before = v.mine()
    v.key("Alt+b", 150)
    v.wait_frame(11)
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"]["frame"] == 11, new
    v.shot("perframe")


def t_track_box(v: V, ctx):
    a = draw_box_track(v, 5)
    g = a["geometry"]
    assert g["type"] == "track" and g["shape"] == "box" and [k["frame"] for k in g["keyframes"]] == [5], g
    assert a["attributes"]["trackId"] >= 1
    assert v.state("s => s.selectedId") == a["id"]
    v.blur()
    v.key("Shift+ArrowRight")
    v.key("Shift+ArrowRight")
    v.wait_frame(25)
    v.tool("v")
    v.drag_v((350, 240), (410, 280))  # body: +60, +40
    g = v.get(a["id"])["geometry"]
    assert [k["frame"] for k in g["keyframes"]] == [5, 25], g
    k25 = g["keyframes"][1]["box"]
    assert abs(k25[0] - 360) < 2 and abs(k25[1] - 240) < 2, k25
    mid = v.shape_at(g, 15)["box"]
    assert abs(mid[0] - 330) < 2 and abs(mid[1] - 220) < 2, mid
    # Resize from the SE handle.
    past = v.state("s => s.past.length")
    v.drag_v((460, 320), (490, 340))
    k25b = v.get(a["id"])["geometry"]["keyframes"][1]["box"]
    assert abs(k25b[2] - 130) < 2 and abs(k25b[3] - 100) < 2, k25b
    assert v.state("s => s.past.length") == past + 1
    # Undo / redo through the shell.
    v.key("Control+z")
    assert abs(v.get(a["id"])["geometry"]["keyframes"][1]["box"][2] - 100) < 2
    v.key("Control+Shift+z")
    assert abs(v.get(a["id"])["geometry"]["keyframes"][1]["box"][2] - 130) < 2
    v.jump(15)
    assert v.overlay_alpha(330, 260) > 100, "interpolated box not drawn at frame 15"
    v.shot("track-interpolated-15")


def t_polygon(v: V, ctx):
    v.jump(8)
    v.tool("p")
    before = v.mine()
    pts = [(300, 200), (420, 210), (430, 320), (290, 310)]
    for p in pts:
        v.click_v(*p)
    v.click_v(*pts[0])  # close on the first vertex
    new = v.new_since(before)
    assert len(new) == 1, new
    a = new[0]
    g = a["geometry"]
    assert g["type"] == "track" and g["shape"] == "polygon" and len(g["keyframes"][0]["points"]) == 4, g
    v.tool("v")
    v.click_v(360, 260)
    assert v.state("s => s.selectedId") == a["id"]
    # Drag vertex 1.
    v.drag_v((420, 210), (440, 210))
    p1 = v.get(a["id"])["geometry"]["keyframes"][0]["points"][1]
    assert abs(p1[0] - 440) < 2, p1
    # Click an edge midpoint to insert a vertex.
    v.click_v(370, 205)
    pts5 = v.get(a["id"])["geometry"]["keyframes"][0]["points"]
    assert len(pts5) == 5, pts5
    # Alt-click deletes a vertex.
    v.click_v(*pts5[3], modifiers=["Alt"])
    assert len(v.get(a["id"])["geometry"]["keyframes"][0]["points"]) == 4
    v.shot("polygon-edited")
    # Per-frame polygon closed with Enter; another closed by double-click.
    v.p.get_by_role("radio", name="Per-frame").click()
    v.tool("p")
    before = v.mine()
    for p in [(100, 100), (180, 100), (150, 170)]:
        v.click_v(*p)
    v.blur()
    v.key("Enter")
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"]["type"] == "polygon" and new[0]["geometry"]["frame"] == 8 and len(new[0]["geometry"]["points"]) == 3, new
    before = v.mine()
    for p in [(500, 100), (600, 100), (620, 180)]:
        v.click_v(*p)
    sx, sy = v.scr(520, 190)
    v.p.mouse.dblclick(sx, sy)
    v.p.wait_for_timeout(100)
    new = v.new_since(before)
    assert len(new) == 1 and len(new[0]["geometry"]["points"]) == 4, new
    # Escape cancels a polygon in progress without deleting anything.
    before = v.mine()
    v.click_v(100, 400)
    v.click_v(150, 400)
    v.key("Escape")
    v.click_v(200, 450)
    v.key("Escape")
    assert len(v.mine()) == len(before)


def t_keypoint(v: V, ctx):
    v.jump(12)
    v.tool("k")
    before = v.mine()
    v.click_v(360, 300)
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"]["shape"] == "keypoint", new
    a = new[0]
    v.tool("v")
    v.drag_v((360, 300), (380, 320))
    p = v.get(a["id"])["geometry"]["keyframes"][0]["points"][0]
    assert abs(p[0] - 380) < 2 and abs(p[1] - 320) < 2, p
    v.p.get_by_role("radio", name="Per-frame").click()
    v.tool("k")
    before = v.mine()
    v.click_v(200, 300)
    new = v.new_since(before)
    assert len(new) == 1, new
    g = new[0]["geometry"]
    assert g["type"] == "keypoint" and g["frame"] == 12 and abs(g["x"] - 200) < 1 and abs(g["y"] - 300) < 1, g


def t_segment(v: V, ctx):
    fps = 25
    v.tool("s")
    before = v.mine()
    v.drag_s(v.lane_x("seg-polyp", 20), v.lane_x("seg-polyp", 60))
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"]["type"] == "span" and new[0]["label"] == "polyp", new
    a = new[0]
    g = a["geometry"]
    assert abs(g["start"] * fps - 20) <= 1 and abs(g["end"] * fps - 60) <= 1, g
    # Select it, then drag its right edge 10 frames to the right.
    bar = v.p.locator(f"[data-seg='{a['id']}']").bounding_box()
    v.p.mouse.click(bar["x"] + bar["width"] / 2, bar["y"] + bar["height"] / 2)
    assert v.state("s => s.selectedId") == a["id"]
    ppf = v.lane("seg-polyp")["width"] / v.frames()
    edge = (bar["x"] + bar["width"] - 2, bar["y"] + bar["height"] / 2)
    v.drag_s(edge, (edge[0] + 10 * ppf, edge[1]))
    g2 = v.get(a["id"])["geometry"]
    assert abs((g2["end"] - g["end"]) * fps - 10) <= 1 and g2["start"] == g["start"], (g, g2)
    # Drag the body: moves both ends.
    bar = v.p.locator(f"[data-seg='{a['id']}']").bounding_box()
    mid = (bar["x"] + bar["width"] / 2, bar["y"] + bar["height"] / 2)
    v.drag_s(mid, (mid[0] + 5 * ppf, mid[1]))
    g3 = v.get(a["id"])["geometry"]
    assert abs((g3["start"] - g2["start"]) * fps - 5) <= 1 and abs((g3["end"] - g3["start"]) - (g2["end"] - g2["start"])) < 1e-3, (g2, g3)
    v.shot("segment")
    # Delete via the shell, undo brings it back.
    v.blur()
    v.key("Delete")
    assert v.get(a["id"]) is None
    v.key("Control+z")
    assert v.get(a["id"]) is not None
    # A second segment in another lane; Shift-click both and delete them together.
    before = v.mine()
    v.drag_s(v.lane_x("seg-bleeding", 100), v.lane_x("seg-bleeding", 130))
    b = v.new_since(before)[0]
    for id_, mods in [(a["id"], []), (b["id"], ["Shift"])]:
        bb = v.p.locator(f"[data-seg='{id_}']").bounding_box()
        v.click_s(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2, modifiers=mods)
    assert sorted(v.state("s => s.selectedIds")) == sorted([a["id"], b["id"]])
    past = v.state("s => s.past.length")
    v.blur()
    v.key("Delete")
    assert v.get(a["id"]) is None and v.get(b["id"]) is None
    assert v.state("s => s.past.length") == past + 1
    v.key("Control+z")
    assert v.get(a["id"]) and v.get(b["id"])


def t_event(v: V, ctx):
    v.jump(30)
    v.tool("t")
    before = v.mine()
    v.click_v(600, 500)
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"] == {"type": "instant", "frame": 30}, new
    e30 = new[0]
    v.blur()
    v.key("Shift+ArrowRight")
    v.wait_frame(40)
    before = v.mine()
    v.key("Enter")
    new = v.new_since(before)
    assert len(new) == 1 and new[0]["geometry"]["frame"] == 40, new
    # Click in the events lane adds one there.
    before = v.mine()
    v.p.mouse.click(*v.lane_x("events", 70))
    v.p.wait_for_timeout(80)
    new = v.new_since(before)
    assert len(new) == 1 and abs(new[0]["geometry"]["frame"] - 70) <= 1, new
    # Drag the frame-30 pin to ~50.
    pin = v.p.locator(f"[data-event='{e30['id']}']").bounding_box()
    start = (pin["x"] + pin["width"] / 2, pin["y"] + pin["height"] / 2)
    v.drag_s(start, (v.lane_x("events", 50)[0], start[1]))
    f = v.get(e30["id"])["geometry"]["frame"]
    assert abs(f - 50) <= 1, f
    v.shot("events")


def t_keyframe_drag(v: V, ctx):
    a = draw_box_track(v, 5)
    v.jump(20)
    v.tool("v")
    v.drag_v((350, 240), (370, 240))
    assert [k["frame"] for k in v.get(a["id"])["geometry"]["keyframes"]] == [5, 20]
    d = v.p.locator(f"[data-kf='{a['id']}:20']").bounding_box()
    start = (d["x"] + d["width"] / 2, d["y"] + d["height"] / 2)
    v.drag_s(start, (v.lane_x(f"track-{a['id']}", 35)[0], start[1]))
    frames = [k["frame"] for k in v.get(a["id"])["geometry"]["keyframes"]]
    assert frames[0] == 5 and abs(frames[1] - 35) <= 1 and len(frames) == 2, frames
    # Clicking a diamond seeks to it.
    d = v.p.locator(f"[data-kf='{a['id']}:5']").bounding_box()
    v.p.mouse.click(d["x"] + d["width"] / 2, d["y"] + d["height"] / 2)
    v.wait_frame(5)
    v.shot("keyframe-drag")


def t_outside_occluded(v: V, ctx):
    a = draw_box_track(v, 5)
    v.jump(15)
    v.blur()
    v.key("o")
    g = v.get(a["id"])["geometry"]
    kf = {k["frame"]: k for k in g["keyframes"]}
    assert kf[15].get("outside") is True, g
    assert v.shape_at(g, 16) is None and v.shape_at(g, 14) is not None
    assert v.overlay_alpha(300, 240) == 0, "outside track still drawn"
    v.jump(20)
    v.blur()
    v.key("o")  # bring back
    g = v.get(a["id"])["geometry"]
    assert v.shape_at(g, 20) is not None and v.shape_at(g, 17) is None
    v.jump(8)
    v.blur()
    v.key("Shift+o")
    g = v.get(a["id"])["geometry"]
    assert v.shape_at(g, 10)["occluded"] is True and v.shape_at(g, 6)["occluded"] is False, g
    v.shot("occluded")
    # Shift+K toggles a keyframe; Alt+. / Alt+, jump between keyframes.
    v.jump(12)
    v.blur()
    v.key("Shift+k")
    assert 12 in [k["frame"] for k in v.get(a["id"])["geometry"]["keyframes"]]
    assert v.state("s => s.tool") != "keypoint", "Shift+K leaked to the keypoint tool"
    v.key("Shift+k")
    assert 12 not in [k["frame"] for k in v.get(a["id"])["geometry"]["keyframes"]]
    v.key("Alt+Period", 150)
    v.wait_frame(15)
    v.key("Alt+Comma", 150)
    v.wait_frame(8)


def t_adjustments(v: V, ctx):
    v.jump(40)
    c = v.cam()
    clip = {"x": c["left"] + c["tx"] + 200 * c["s"], "y": c["top"] + c["ty"] + 150 * c["s"], "width": 300 * c["s"], "height": 250 * c["s"]}

    def brightness() -> float:
        return float(np.asarray(Image.open(io.BytesIO(v.p.screenshot(clip=clip))).convert("L")).mean())

    base = brightness()
    v.p.get_by_label("Image adjustments").click()
    slider = v.p.locator("input[type=range]").first
    slider.focus()
    v.p.keyboard.press("End")  # brightness 300%
    v.p.wait_for_timeout(150)
    v.shot("adjust-bright")
    v.p.keyboard.press("Escape")
    v.p.wait_for_timeout(150)
    bright = brightness()
    assert bright > base * 1.3, (base, bright)
    v.p.get_by_label("Image adjustments").click()
    v.p.get_by_role("button", name="Reset").click()
    v.p.keyboard.press("Escape")
    v.p.wait_for_timeout(150)
    reset = brightness()
    assert abs(reset - base) < 3, (base, reset)
    ctx["notes"].append(f"brightness base={base:.1f} 300%={bright:.1f} reset={reset:.1f}")


def t_loop_ab(v: V, ctx):
    a, b = 20, 40
    v.drag_s(ruler_x(v, a), ruler_x(v, b), hold=["Shift"])
    v.blur()
    v.key("l")
    v.jump(25)
    v.blur()
    v.p.keyboard.press("Space")
    samples = []
    t0 = time.time()
    while time.time() - t0 < 2.6:
        samples.append(v.frame())
        v.p.wait_for_timeout(40)
    v.shot("loop-ab-playing")
    v.p.keyboard.press("Space")
    v.p.wait_for_timeout(400)
    lo, hi = min(samples), max(samples)
    ctx["notes"].append(f"A-B {a}-{b}: played frames {lo}..{hi} ({len(set(samples))} distinct)")
    assert lo >= a - 1 and hi <= b + 1, (lo, hi, samples)
    assert len(set(samples)) > 10, f"playback did not advance: {samples}"
    wrapped = any(samples[i + 1] < samples[i] - 5 for i in range(len(samples) - 1))
    assert wrapped, f"never looped back to A: {samples}"
    f = v.frame()
    assert a - 1 <= f <= b + 1, f
    assert not v.p.evaluate("() => !document.querySelector('[data-testid=video-element]').paused")


def ruler_x(v: V, frame: float) -> tuple[float, float]:
    r = v.p.locator("[data-ruler]").bounding_box()
    ppf = r["width"] / v.frames()
    return r["x"] + (frame + 0.5) * ppf, r["y"] + r["height"] / 2


def t_zoom_pan(v: V, ctx):
    c0 = v.cam()
    sx, sy = v.scr(360, 288)
    v.p.mouse.move(sx, sy)
    v.p.mouse.wheel(0, -400)
    v.p.wait_for_timeout(150)
    c1 = v.cam()
    assert c1["s"] > c0["s"] * 1.3, (c0, c1)
    # The point under the cursor stays put.
    ax, ay = v.scr(360, 288)
    assert abs(ax - sx) < 2 and abs(ay - sy) < 2, ((sx, sy), (ax, ay))
    v.tool("h")
    v.drag_s((sx, sy), (sx + 80, sy + 40))
    c2 = v.cam()
    assert abs(c2["tx"] - c1["tx"] - 80) < 2 and abs(c2["ty"] - c1["ty"] - 40) < 2, (c1, c2)
    # Space-drag pans with any tool and does not toggle playback.
    v.tool("r")
    before = v.mine()
    v.drag_s((sx, sy), (sx - 50, sy), hold=["Space"])
    c3 = v.cam()
    assert abs(c3["tx"] - c2["tx"] + 50) < 2, (c2, c3)
    assert v.p.evaluate("() => document.querySelector('[data-testid=video-element]').paused")
    assert len(v.mine()) == len(before), "space-drag drew a box"
    # Middle-drag pans too.
    v.drag_s((sx, sy), (sx, sy + 30), button="middle")
    assert abs(v.cam()["ty"] - c3["ty"] - 30) < 2
    v.shot("zoomed")
    v.p.get_by_label("Actual size (1:1)").click()
    v.p.wait_for_timeout(100)
    assert abs(v.cam()["s"] - 1) < 1e-6
    v.p.get_by_label("Fit", exact=True).click()
    v.p.wait_for_timeout(100)
    assert abs(v.cam()["s"] - c0["s"]) < 1e-3


def t_multiselect(v: V, ctx):
    a = draw_box_track(v, 5, (100, 100, 180, 170))
    b = draw_box_track(v, 5, (400, 300, 500, 380))
    v.tool("v")
    v.click_v(140, 135)
    v.click_v(450, 340, modifiers=["Shift"])
    assert sorted(v.state("s => s.selectedIds")) == sorted([a["id"], b["id"]]), v.state("s => s.selectedIds")
    assert v.state("s => s.selectedId") == b["id"]
    v.shot("multiselect")
    # Shift-click on a timeline lane toggles too.
    v.click_s(*v.lane_x(f"track-{a['id']}", 150), modifiers=["Shift"])
    assert v.state("s => s.selectedIds") == [b["id"]]
    v.click_s(*v.lane_x(f"track-{a['id']}", 150), modifiers=["Shift"])
    assert len(v.state("s => s.selectedIds")) == 2
    # O on two tracks: one undo step.
    v.jump(10)
    past = v.state("s => s.past.length")
    v.blur()
    v.key("o")
    assert v.state("s => s.past.length") == past + 1
    for x in (a, b):
        assert v.shape_at(v.get(x["id"])["geometry"], 11) is None
    v.key("Control+z")
    for x in (a, b):
        assert v.shape_at(v.get(x["id"])["geometry"], 11) is not None
    # Alt+B on both: keyframes on the next frame, one step.
    past = v.state("s => s.past.length")
    v.key("Alt+b", 150)
    v.wait_frame(11)
    assert v.state("s => s.past.length") == past + 1
    for x in (a, b):
        assert 11 in [k["frame"] for k in v.get(x["id"])["geometry"]["keyframes"]]
    # Delete removes both; undo restores both.
    v.key("Delete")
    assert v.get(a["id"]) is None and v.get(b["id"]) is None
    v.key("Control+z")
    assert v.get(a["id"]) and v.get(b["id"])
    v.key("Control+Shift+z")
    assert v.get(a["id"]) is None


def t_exporters(v: V, ctx):
    a = draw_box_track(v, 5)
    v.jump(25)
    v.tool("v")
    v.drag_v((350, 240), (410, 240))
    v.jump(30)
    v.blur()
    v.key("o")
    v.p.get_by_role("radio", name="Per-frame").click()
    v.jump(40)
    v.tool("r")
    v.drag_v((100, 100), (160, 150))
    v.tool("s")
    v.drag_s(v.lane_x("seg-landmark", 50), v.lane_x("seg-landmark", 75))
    v.jump(60)
    v.tool("t")
    v.blur()
    v.key("Enter")
    item = v.item_id()
    blobs = v.p.evaluate(
        """async () => {
            const { registry } = await import('/src/platform/registry.ts');
            const items = (await import('/src/lib/items.ts')).projectItems;
            const manifest = await (await fetch('/seed/manifest.json')).json();
            const project = manifest.projects.find((p) => p.id === 'video-endoscopy');
            const ctx = { project, items: items(project), annotations: window.__s.getState().annotations };
            const out = {};
            for (const id of ['cvat-video', 'mot', 'temporal-json']) {
                const e = await registry.loadImpl(`inkling.video.exporters.${id}`);
                const buf = new Uint8Array(await (await e.build(ctx)).arrayBuffer());
                let s = ''; for (const b of buf) s += String.fromCharCode(b);
                out[id] = btoa(s);
            }
            return out;
        }"""
    )
    stem = Path(item).stem
    tid = v.get(a["id"])["attributes"]["trackId"]
    # CVAT XML
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(blobs["cvat-video"])))
    assert z.testzip() is None
    root = ET.fromstring(z.read(f"{stem}/annotations.xml"))
    assert root.findtext("version") == "1.1" and root.find("meta/task/size").text == "199"
    tracks = root.findall("track")
    boxes = [t for t in tracks if t.find("box") is not None]
    rows = None
    for t in boxes:
        fr = [int(b.get("frame")) for b in t.findall("box")]
        if fr[0] == 5 and len(fr) > 2:
            rows = t.findall("box")
    assert rows is not None, "box track missing from CVAT XML"
    frames = [int(r.get("frame")) for r in rows]
    assert frames == list(range(5, 31)), frames
    keyed = [int(r.get("frame")) for r in rows if r.get("keyframe") == "1"]
    assert keyed == [5, 25, 30], keyed
    assert rows[-1].get("outside") == "1" and all(r.get("outside") == "0" for r in rows[:-1])
    r15 = next(r for r in rows if r.get("frame") == "15")
    assert abs(float(r15.get("xtl")) - 330) < 1, r15.attrib
    single = [t for t in boxes if [b.get("frame") for b in t.findall("box")] == ["40", "41"]]
    assert single and single[0].findall("box")[1].get("outside") == "1"
    # MOT
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(blobs["mot"])))
    gt = [line.split(",") for line in z.read(f"{stem}/gt/gt.txt").decode().strip().splitlines()]
    mine = [r for r in gt if int(r[1]) == tid]
    assert [int(r[0]) for r in mine] == list(range(6, 31)), [r[0] for r in mine]
    assert all(len(r) == 9 for r in gt)
    assert "seqLength=199" in z.read(f"{stem}/seqinfo.ini").decode()
    # Temporal JSON
    doc = json.loads(base64.b64decode(blobs["temporal-json"]))
    vid = next(x for x in doc["videos"] if x["item"] == item)
    seg = next(s for s in vid["segments"] if s["label"] == "landmark")
    assert abs(seg["startFrame"] - 50) <= 1 and abs(seg["endFrame"] - 74) <= 1, seg
    assert any(e["frame"] == 60 and abs(e["time"] - 2.4) < 1e-6 for e in vid["events"]), vid["events"]
    (ctx["out"] / f"video-{v.tag}-export-cvat.xml").write_bytes(zipfile.ZipFile(io.BytesIO(base64.b64decode(blobs["cvat-video"]))).read(f"{stem}/annotations.xml"))


def t_saves_intercepted(v: V, ctx):
    draw_box_track(v, 5)
    v.p.wait_for_timeout(2500)
    ctx["notes"].append(f"intercepted saves: {len(v.s.saves)}")


TESTS = [
    t_decode_mode,
    t_frame_exact,
    t_perframe_overlay,
    t_track_box,
    t_polygon,
    t_keypoint,
    t_segment,
    t_event,
    t_keyframe_drag,
    t_outside_occluded,
    t_adjustments,
    t_loop_ab,
    t_zoom_pan,
    t_multiselect,
    t_exporters,
    t_saves_intercepted,
]

IGNORED_ERRORS = ("Failed to load resource", "favicon", "[vite]", "Download the React DevTools")


def main() -> int:
    import argparse

    extra = argparse.ArgumentParser(add_help=False)
    extra.add_argument("--force-fallback", action="store_true")
    extra.add_argument("--only", default="")
    known, rest = extra.parse_known_args()
    sys.argv = [sys.argv[0], *rest]
    args = parse_args()
    out = Path(args.out)
    tag = args.browser + ("-fallback" if known.force_fallback else "")
    results: list[tuple[str, bool, str]] = []
    with sync_playwright() as pw:
        if args.browser == "chromium":
            try:
                browser = pw.chromium.launch(channel="chrome", headless=not args.headed)
            except Exception:  # noqa: BLE001 — Chrome missing: Playwright's Chromium lacks H.264
                browser = pw.chromium.launch(headless=not args.headed)
        else:
            browser = getattr(pw, args.browser).launch(headless=not args.headed)
        print(f"[{tag}] {browser.browser_type.name} {browser.version}")
        for test in TESTS:
            if known.only and known.only not in test.__name__:
                continue
            ctx = {"browser": args.browser, "forced": known.force_fallback, "out": out, "notes": []}
            studio = open_studio(browser, args.port, "video-endoscopy", init_script=NO_WEBCODECS if known.force_fallback else None, viewport=(1440, 900))
            ok, msg = True, ""
            try:
                v = V(studio, out, tag)
                test(v, ctx)
                errs = [e for e in studio.errors if not any(s in e for s in IGNORED_ERRORS)]
                assert not errs, f"page errors: {errs[:3]}"
                for p in studio.saves:
                    assert isinstance(p.get("annotations"), list)
            except Exception as e:  # noqa: BLE001
                ok = False
                msg = f"{type(e).__name__}: {e}"
                try:
                    studio.shot(f"video-{tag}-FAIL-{test.__name__}", out)
                except Exception:  # noqa: BLE001
                    pass
                traceback.print_exc(limit=3)
            finally:
                studio.page.context.close()
            note = "; ".join(ctx["notes"])
            results.append((test.__name__, ok, msg or note))
            print(f"[{tag}] {'PASS' if ok else 'FAIL'} {test.__name__} {msg or note}", flush=True)
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"[{tag}] {len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
