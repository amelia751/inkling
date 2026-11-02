"""Derivatives for formats the browser can't show (todo18 D4, P0-2, P0-3).

* video (AVI/MOV/MKV/…) → H.264 MP4 at `derived/<sha>.mp4` (ffmpeg);
* slide (SVS/NDPI/MRXS/TIFF) → DZI pyramid `derived/<sha>.dzi` + `derived/<sha>_files/…`, a
  thumbnail and `mpp` from the header (OpenSlide).

Derivatives are keyed by the source's content hash, so the same bytes convert once. Each
step reports progress (0–100) through a callback; the kernel shows the item as `processing`
("Converting video" / "Preparing slide (n %)") until the job lands. Failures raise
`DeriveError` with a reason a person can read (the codec ffmpeg couldn't decode, a missing
binary), never a stack trace. Binaries are found at run time and injectable for tests.
"""

from __future__ import annotations

import importlib
import json
import posixpath
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import DeriveLimits

BROWSER_VIDEO = {".mp4", ".webm", ".m4v"}
VIDEO_EXTS = {".avi", ".mov", ".mkv", ".mpg", ".mpeg", ".wmv", ".flv", ".3gp", ".ogv", ".ts"}
SLIDE_EXTS = {".svs", ".ndpi", ".mrxs", ".scn", ".vms", ".bif", ".tif", ".tiff"}
TILE = 254
OVERLAP = 1

Progress = Callable[[int], None]


class DeriveError(RuntimeError):
    """A derivative that can't be made; `reason` is shown on the item."""

    def __init__(self, reason: str, *, retry: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.retry = retry


@dataclass
class Derived:
    kind: str  # "video-mp4" | "slide-dzi"
    key: str  # blob key of the main file, e.g. derived/<sha>.mp4
    files: dict[str, Path] = field(default_factory=dict)  # blob key → local file
    meta: dict[str, Any] = field(default_factory=dict)


def derivative_kind(name: str, kind: str | None = None, *, tiled: bool = False) -> str | None:
    """Which derivative a source needs, if any. A `.tif` is a slide only when it's tiled (a
    pyramidal TIFF); plain TIFF images stay images."""
    ext = posixpath.splitext(name.lower())[1]
    if ext in VIDEO_EXTS or (kind == "video" and ext not in BROWSER_VIDEO):
        return "video-mp4"
    if ext in SLIDE_EXTS and (ext not in (".tif", ".tiff") or tiled or kind == "slide"):
        return "slide-dzi"
    return None


def should_retry(attempts: int, limits: DeriveLimits, err: DeriveError) -> bool:
    """Retry transient failures until `WORKER_DERIVE_MAX_ATTEMPTS`; then dead-letter."""
    return err.retry and attempts < limits.max_attempts


# ---- Video ------------------------------------------------------------------------------------


def _probe(src: Path, run: Callable[..., Any], ffprobe: str) -> dict:
    try:
        r = run([ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(src)], capture_output=True, text=True, timeout=60)
        return json.loads(r.stdout or "{}")
    except (subprocess.SubprocessError, ValueError, OSError):
        return {}


def transcode_video(
    src: Path,
    out_dir: Path,
    sha: str,
    *,
    limits: DeriveLimits = DeriveLimits(),
    progress: Progress = lambda _p: None,
    run: Callable[..., Any] = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
) -> Derived:
    ffmpeg, ffprobe = which("ffmpeg"), which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise DeriveError("Video conversion isn't available: ffmpeg isn't installed on the worker")
    size = src.stat().st_size
    if size > limits.transcode_max_bytes:
        raise DeriveError(f"Video is too large to convert ({size} bytes; the limit is {limits.transcode_max_bytes})")
    info = _probe(src, run, ffprobe)
    v = next((s for s in info.get("streams") or [] if s.get("codec_type") == "video"), None)
    codec = (v or {}).get("codec_name") or "unknown"
    if not v:
        raise DeriveError("No video stream ffmpeg can read in this file")
    duration = float(v.get("duration") or (info.get("format") or {}).get("duration") or 0) or None
    out = out_dir / f"{sha}.mp4"
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-v", "error", "-progress", "pipe:1", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
           "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
           "-c:a", "aac", "-movflags", "+faststart", str(out)]
    progress(0)
    try:
        r = run(cmd, capture_output=True, text=True, timeout=6 * 3600)
    except subprocess.TimeoutExpired as e:
        raise DeriveError(f"Converting {codec} video timed out", retry=True) from e
    except OSError as e:
        raise DeriveError(f"ffmpeg couldn't start: {e}", retry=True) from e
    for m in re.finditer(r"out_time_us=(\d+)", r.stdout or ""):
        if duration:
            progress(min(99, int(int(m.group(1)) / 1e6 / duration * 100)))
    if r.returncode != 0 or not out.is_file():
        tail = (r.stderr or "").strip().splitlines()[-1:] or [""]
        raise DeriveError(f"ffmpeg can't decode {codec} video" + (f": {tail[0][:200]}" if tail[0] else ""))
    progress(100)
    key = f"derived/{sha}.mp4"
    return Derived("video-mp4", key, {key: out}, {"sourceCodec": codec, "codec": "h264", "container": "mp4"})


# ---- Slides -----------------------------------------------------------------------------------


def _load_openslide() -> Any:
    try:
        import openslide  # type: ignore[import-not-found]
    except (ImportError, OSError) as e:  # OSError: the Python package without libopenslide
        raise DeriveError("Slide tiling isn't available: OpenSlide isn't installed on the worker") from e
    return openslide


def tile_slide(
    src: Path,
    out_dir: Path,
    sha: str,
    *,
    progress: Progress = lambda _p: None,
    openslide: Any = None,
) -> Derived:
    """DZI pyramid (JPEG tiles), a 256 px thumbnail and µm/px from the slide header."""
    osl = openslide or _load_openslide()
    try:
        slide = osl.OpenSlide(str(src))
    except Exception as e:  # noqa: BLE001 — OpenSlideUnsupportedFormatError, OpenSlideError
        raise DeriveError(f"OpenSlide can't open this slide: {str(e)[:200]}") from e
    try:
        gen = getattr(osl, "DeepZoomGenerator", None) or importlib.import_module("openslide.deepzoom").DeepZoomGenerator
        dz = gen(slide, tile_size=TILE, overlap=OVERLAP, limit_bounds=True)
        out_dir.mkdir(parents=True, exist_ok=True)
        files: dict[str, Path] = {}
        total = sum(c * r for c, r in dz.level_tiles) or 1
        done = 0
        progress(0)
        for level in range(dz.level_count):
            cols, rows = dz.level_tiles[level]
            for col in range(cols):
                for row in range(rows):
                    rel = f"{sha}_files/{level}/{col}_{row}.jpeg"
                    p = out_dir / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    dz.get_tile(level, (col, row)).convert("RGB").save(p, "JPEG", quality=85)
                    files[f"derived/{rel}"] = p
                    done += 1
                progress(min(99, done * 100 // total))
        dzi = out_dir / f"{sha}.dzi"
        dzi.write_text(dz.get_dzi("jpeg"))
        files[f"derived/{sha}.dzi"] = dzi
        thumb = out_dir / f"{sha}_thumb.png"
        slide.get_thumbnail((256, 256)).save(thumb, "PNG")
        files[f"derived/{sha}_thumb.png"] = thumb
        props = getattr(slide, "properties", {}) or {}
        meta: dict[str, Any] = {"width": slide.dimensions[0], "height": slide.dimensions[1], "levels": dz.level_count}
        for axis, k in (("mppX", "openslide.mpp-x"), ("mppY", "openslide.mpp-y")):
            try:
                meta[axis] = float(props[k])
            except (KeyError, TypeError, ValueError):
                pass
        if "mppX" in meta:
            meta["mpp"] = meta["mppX"]
        progress(100)
        return Derived("slide-dzi", f"derived/{sha}.dzi", files, meta)
    finally:
        slide.close()


# ---- The worker loop: claim → read source → convert → upload → complete ------------------------


class DeriveWorker:
    """Claims derivative rows from the kernel (`/api/v1/worker/derivatives/*`), converts them and
    uploads the files. `convert` is injectable for tests."""

    def __init__(self, http: Any, scratch: Path, limits: DeriveLimits = DeriveLimits(), convert: Callable[..., Derived] | None = None):
        self.http, self.scratch, self.limits = http, scratch, limits
        self.convert = convert or self._convert

    def _convert(self, kind: str, src: Path, out: Path, sha: str, progress: Progress) -> Derived:
        if kind == "video-mp4":
            return transcode_video(src, out, sha, limits=self.limits, progress=progress)
        return tile_slide(src, out, sha, progress=progress)

    def tick(self) -> int:
        r = self.http.post("/api/v1/worker/derivatives/claim", json={"limit": 1, "maxAttempts": self.limits.max_attempts})
        r.raise_for_status()
        rows = r.json().get("derivatives") or []
        for row in rows:
            self.handle(row)
        return len(rows)

    def handle(self, row: dict) -> str:
        import hashlib
        import tempfile

        did = row["id"]
        with tempfile.TemporaryDirectory(dir=self.scratch) as tmp:
            src = Path(tmp) / "source"
            h = hashlib.sha256()
            with self.http.stream("GET", f"/api/v1/worker/inspect/nodes/{row['nodeId']}/content") as resp:
                resp.raise_for_status()
                with src.open("wb") as f:
                    for chunk in resp.iter_bytes():
                        h.update(chunk)
                        f.write(chunk)
            sha = h.hexdigest()

            def progress(pct: int) -> None:
                self.http.post(f"/api/v1/worker/derivatives/{did}/progress", json={"progress": pct})

            try:
                d = self.convert(row["kind"], src, Path(tmp) / "out", sha, progress)
            except DeriveError as e:
                self.http.post(f"/api/v1/worker/derivatives/{did}/fail", json={"reason": e.reason, "retry": e.retry, "maxAttempts": self.limits.max_attempts})
                return "failed"
            keys = []
            main = ""
            for rel, path in d.files.items():
                ctype = "video/mp4" if rel.endswith(".mp4") else "image/jpeg" if rel.endswith(".jpeg") else "image/png" if rel.endswith(".png") else "application/xml"
                up = self.http.put(f"/api/v1/worker/derivatives/{did}/files/{rel}", content=path.read_bytes(), headers={"Content-Type": ctype})
                up.raise_for_status()
                keys.append(up.json()["key"])
                if rel == d.key:
                    main = keys[-1]
            self.http.post(f"/api/v1/worker/derivatives/{did}/complete", json={"sha": sha, "key": main, "keys": keys, "meta": d.meta}).raise_for_status()
            return "ready"
