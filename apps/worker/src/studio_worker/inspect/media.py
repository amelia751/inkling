"""Facts and thumbnails for images, volumes, videos and documents (todo6 Phase 5.1)."""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import tempfile
from typing import Any


def image_facts(data: bytes) -> tuple[dict, bytes | None]:
    """(width, height, mode, frames…), and a 256px PNG thumbnail."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            facts = {"width": img.width, "height": img.height, "mode": img.mode}
            frames = getattr(img, "n_frames", 1)
            if frames > 1:
                facts["frames"] = frames
            thumb = img.convert("RGB") if img.mode not in ("L", "RGB") else img.copy()
            thumb.thumbnail((256, 256))
            buf = io.BytesIO()
            thumb.save(buf, "PNG")
            return facts, buf.getvalue()
    except Exception:  # noqa: BLE001 — a damaged image is "detected, can't preview"
        return {"unreadable": True}, None


def volume_facts(data: bytes, name: str, kind: str) -> tuple[str, dict]:
    """(kind, facts) for NIfTI: shape, spacing, data type; a `mask` name hint is confirmed by
    integer voxels with few distinct values, and an integer volume with few values is a mask."""
    try:
        import nibabel as nib
        import numpy as np

        suffix = ".nii.gz" if data[:2] == b"\x1f\x8b" else ".nii"
        with tempfile.NamedTemporaryFile(suffix=suffix) as f:
            f.write(data)
            f.flush()
            img: Any = nib.load(f.name)  # a NIfTI image (nibabel types it as the base class)
            shape = [int(x) for x in img.shape]
            zooms = [round(float(z), 4) for z in img.header.get_zooms()]
            dtype = str(img.get_data_dtype())
            facts: dict = {"shape": shape, "spacing": zooms[:3], "dtype": dtype, "width": shape[0], "height": shape[1] if len(shape) > 1 else 1}
            if len(shape) >= 3:
                facts["slices"] = shape[2]
            if len(shape) >= 4:
                facts["frames"] = shape[3]
            integer = np.issubdtype(img.get_data_dtype(), np.integer)
            if integer and len(data) <= 64 * 1024 * 1024:
                values = np.unique(np.asanyarray(img.dataobj))
                if len(values) <= 64:
                    facts["labelValues"] = [int(v) for v in values[:64]]
                    return "mask", facts
            return ("volume" if kind == "mask" and not integer else kind), facts
    except Exception:  # noqa: BLE001
        return kind, {"unreadable": True}


def video_facts(path: str) -> dict:
    """ffprobe, when it's installed: duration, codec, size, fps, frames."""
    probe = shutil.which("ffprobe")
    if not probe:
        return {}
    try:
        r = subprocess.run([probe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], capture_output=True, text=True, timeout=30)
        info = json.loads(r.stdout or "{}")
    except (subprocess.SubprocessError, ValueError, OSError):
        return {}
    v = next((s for s in info.get("streams") or [] if s.get("codec_type") == "video"), None)
    if not v:
        return {}
    num, _, den = str(v.get("avg_frame_rate") or "0/1").partition("/")
    fps = round(float(num) / float(den), 3) if den and float(den) else None
    duration = float(v.get("duration") or (info.get("format") or {}).get("duration") or 0) or None
    video = {"codec": v.get("codec_name"), "width": v.get("width"), "height": v.get("height"), "fps": fps, "duration": duration, "frames": int(v["nb_frames"]) if str(v.get("nb_frames") or "").isdigit() else None}
    video = {k: x for k, x in video.items() if x is not None}
    out = {"video": video}
    for k in ("width", "height", "fps", "duration", "frames"):
        if k in video:
            out[k] = video[k]
    return out


def document_facts(data: bytes, fmt: str) -> dict:
    if fmt == "PDF":
        pages = len(re.findall(rb"/Type\s*/Page(?!s)", data))
        return {"pages": pages} if pages else {}
    if fmt in ("Text", "Markdown", "JSON", "XML"):
        text = data[: 1024 * 1024].decode("utf-8", errors="replace")
        return {"lines": text.count("\n") + (1 if text and not text.endswith("\n") else 0), "words": len(text.split())}
    return {}
