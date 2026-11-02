"""What this worker can convert (todo19 D10).

`detect()` → `{ffmpeg: "7.1", ffprobe: "7.1", openslide: "4.0.1", pyvips: "8.18.0", dciodvfy: "…"}`
(only what's present). The worker reports it to the kernel at start and while it runs
(`POST /api/v1/workers/capabilities`), claims only the derivative kinds it can serve, and
`/readyz` lists it. `missing()` is the line `pnpm dev` / `pnpm doctor` print for each gap.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Callable
from typing import Any

# derivative kind → any one of these serves it (mirrors studio_api.kernel.derivatives.NEEDS)
NEEDS = {"video-mp4": ("ffmpeg",), "slide-dzi": ("openslide",)}
FIX = {
    "ffmpeg": "videos will wait for a converter: install ffmpeg (brew install ffmpeg / apt-get install ffmpeg)",
    "OpenSlide": "slides will wait for a converter: install OpenSlide with `uv sync` (openslide-bin, pyvips-binary)",
}


def _tool_version(name: str, which: Callable[[str], str | None], run: Callable[..., Any]) -> str | None:
    path = which(name)
    if not path:
        return None
    flag = "-version" if name in ("ffmpeg", "ffprobe") else "-help"
    try:
        r = run([path, flag], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"version\s+([\w.\-]+)", (r.stdout or "") + (r.stderr or ""))
    return m.group(1) if m else "present"


def detect(*, which: Callable[[str], str | None] = shutil.which, run: Callable[..., Any] = subprocess.run) -> dict[str, str]:
    caps: dict[str, str] = {}
    for tool in ("ffmpeg", "ffprobe", "dciodvfy"):
        v = _tool_version(tool, which, run)
        if v:
            caps[tool] = v
    if "ffprobe" not in caps:
        caps.pop("ffmpeg", None)  # the transcode needs both
    try:
        import openslide  # type: ignore[import-not-found]

        caps["openslide"] = str(getattr(openslide, "__library_version__", None) or openslide.__version__)
    except (ImportError, OSError, AttributeError):
        pass
    try:
        import pyvips  # type: ignore[import-not-found]

        caps["pyvips"] = f"{pyvips.version(0)}.{pyvips.version(1)}.{pyvips.version(2)}"
    except (ImportError, OSError, AttributeError, Exception):  # noqa: BLE001 — cffi errors when libvips is absent
        pass
    return caps


def kinds_for(caps: dict) -> list[str]:
    return [k for k, needs in NEEDS.items() if any(caps.get(n) for n in needs)]


def missing(caps: dict) -> list[str]:
    out = []
    if not caps.get("ffmpeg"):
        out.append(FIX["ffmpeg"])
    if not caps.get("openslide"):
        out.append(FIX["OpenSlide"])
    return out
