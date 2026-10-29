"""Helpers shared by the Cornerstone viewer tests (image2d_test.py, volume3d_test.py)."""

from __future__ import annotations

import base64
import json
import math
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).parent


class Results:
    def __init__(self, out: Path) -> None:
        self.out = out
        self.rows: list[tuple[str, bool, str, float]] = []

    def run(self, name: str, fn: Callable[[], str | None]) -> None:
        only = os.environ.get("INKLING_ONLY")
        if only and not any(o.strip().lower() in name.lower() for o in only.split(",")):
            return
        t0 = time.time()
        try:
            note = fn() or ""
            self.rows.append((name, True, note, time.time() - t0))
            print(f"PASS {name} ({time.time() - t0:.1f}s) {note}", flush=True)
        except Exception as e:  # noqa: BLE001 — report every failure and keep going
            msg = f"{type(e).__name__}: {e}"
            self.rows.append((name, False, msg, time.time() - t0))
            print(f"FAIL {name}: {msg}", flush=True)
            traceback.print_exc()

    def summary(self) -> int:
        ok = sum(1 for r in self.rows if r[1])
        print(f"\n{ok}/{len(self.rows)} passed")
        for name, passed, note, dt in self.rows:
            print(f"  {'PASS' if passed else 'FAIL'}  {name:<34} {dt:5.1f}s  {note[:160]}")
        (self.out / "results.json").write_text(json.dumps([{"name": n, "pass": p, "note": m, "seconds": round(d, 1)} for n, p, m, d in self.rows], indent=2))
        return 0 if ok == len(self.rows) else 1


def check(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def close(a: float, b: float, tol: float, what: str) -> None:
    check(abs(a - b) <= tol, f"{what}: {a} != {b} (±{tol})")


def wait_for(fn: Callable[[], Any], what: str, timeout: float = 60, every: float = 0.25) -> Any:
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001 — page may be mid-navigation
            last = e
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what} (last: {last})")


def drag(page, a: tuple[float, float], b: tuple[float, float], steps: int = 10, button: str = "left", hold: float = 0.0) -> None:
    page.mouse.move(*a)
    page.mouse.down(button=button)
    if hold:
        time.sleep(hold)
    page.mouse.move(*b, steps=steps)
    # Some tools update only on the next move after the last drag event; settle on the end point.
    page.mouse.move(b[0] + 1, b[1])
    page.mouse.move(*b)
    page.mouse.up(button=button)


def click(page, p: tuple[float, float], modifiers: list[str] | None = None) -> None:
    for m in modifiers or []:
        page.keyboard.down(m)
    page.mouse.click(*p)
    for m in modifiers or []:
        page.keyboard.up(m)


def dist(p: list[float], q: list[float]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(p, q)))


def angle_deg(a: list[float], b: list[float], c: list[float]) -> float:
    """Angle ABC in degrees."""
    v1 = [x - y for x, y in zip(a, b)]
    v2 = [x - y for x, y in zip(c, b)]
    dot = sum(x * y for x, y in zip(v1, v2))
    return math.degrees(math.acos(max(-1, min(1, dot / (math.hypot(*v1) * math.hypot(*v2))))))


def item_annotations(st, item_id: str) -> list[dict]:
    return st.store(f"s => s.annotations.filter(a => a.itemId === {json.dumps(item_id)})")


def new_annotations(st, item_id: str, before: list[dict]) -> list[dict]:
    ids = {a["id"] for a in before}
    return [a for a in item_annotations(st, item_id) if a["id"] not in ids]


def masks(st, item_id: str) -> dict[str, int]:
    return {a["label"]: a["geometry"].get("voxels", 0) for a in item_annotations(st, item_id) if a["geometry"]["type"] == "mask"}


def blob_from_exporter(st, module: str, exporter_index_expr: str) -> bytes:
    """Run an adapter exporter in the page (with the live store) and return the file bytes."""
    b64 = st.page.evaluate(
        f"""async () => {{
          const ad = await import({json.dumps(module)});
          const {{ projectItems }} = await import('/src/lib/items.ts');
          const api = await import('/src/lib/api.ts');
          const s = (await import('/src/stores/studio.ts')).useStudio.getState();
          const res = await fetch('/seed/manifest.json');
          const project = (await res.json()).projects.find(p => p.id === s.projectId);
          const exporter = {exporter_index_expr};
          const blob = await exporter.build({{ project, items: projectItems(project), annotations: s.annotations }});
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return btoa(bin);
        }}"""
    )
    return base64.b64decode(b64)


def validate_dicom(path: Path, kind: str) -> dict:
    """Parse a written DICOM SEG / SR with pydicom (in a uv-managed env) and return a summary."""
    out = subprocess.run(
        ["uv", "run", "-q", "--with", "pydicom", "--with", "numpy", "python", str(HERE / "validate_dicom.py"), kind, str(path)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if out.returncode != 0:
        raise AssertionError(f"pydicom validation failed: {out.stderr[-1500:]}")
    return json.loads(out.stdout)


def ensure_dicom_fixtures(dicom_dir: Path) -> dict:
    if not (dicom_dir / "manifest.json").exists():
        subprocess.run(
            ["uv", "run", "-q", "--with", "pydicom", "--with", "numpy", "--with", "pillow", "python", str(HERE / "dicom_fixtures.py"), str(dicom_dir)],
            check=True,
            timeout=600,
        )
    return json.loads((dicom_dir / "manifest.json").read_text())


def log(*a: Any) -> None:
    print(*a, file=sys.stderr, flush=True)


def button(page, text: str):
    """Sub-toolbar buttons carry a descriptive aria-label; match their visible text."""
    return page.locator("button", has_text=text).first


def open_with_fixtures(open_studio, browser, port: int, dataset: str, fixtures: dict[str, Path], extra_projects: list[dict]):
    """open_studio + fixture routes, then reload so every fixture request is served.

    Works around harness.open_studio's fixture handler, whose lambda receives the Playwright
    Request as its `body` default (Playwright passes (route, request)), so fixtures 500.
    """
    import mimetypes

    st = open_studio(browser, port, dataset, extra_projects=extra_projects)
    for seed_path, local in fixtures.items():
        data = Path(local).read_bytes()
        ctype = mimetypes.guess_type(str(local))[0] or "application/dicom"

        def handler(route, _request=None, data=data, ctype=ctype):
            route.fulfill(status=200, body=data, content_type=ctype)

        st.page.route(f"**/seed/{seed_path}", handler)
    st.page.reload()
    return st
