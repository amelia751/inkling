"""The Phase 4 exit-criterion provider (todo2): a first-party `image.segment` that returns fixed
masks without any model, so the gateway → validation → normalisation → commit path is
exercised end to end. Enabled only with <envPrefix>API_BUILTIN_MOCK_SEGMENT=1; the real
reference plugin (plugins/segmentation) replaces it in Phase 6.
"""

from __future__ import annotations

import struct
import zlib

from ...models import Asset
from ...naming import plugin_schema_version
from ..assets import asset_file

CAPABILITY = "image.segment"

MANIFEST = {
    "schemaVersion": plugin_schema_version(),
    "id": "kernel.builtin",
    "name": "Built-in mock segmentation",
    "version": "1.0.0",
    "publisher": "kernel",
    "license": "Proprietary",
    "compatibility": {"studio": "*", "pluginApi": "^1"},
    "capabilities": [{"id": CAPABILITY, "tool": "segment_objects", "mediaTypes": ["image/png", "image/jpeg"]}],
    "runtime": {"kind": "none"},
    "providers": [{"id": "mock", "implements": [CAPABILITY], "hosting": "mock"}],
    "permissions": {"required": ["assets.read", "annotations.write"], "optional": []},
}


def image_size(path) -> tuple[int, int]:
    """(width, height) from a PNG or JPEG header, without decoding pixels."""
    data = path.read_bytes()[:65536]
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return w, h
            i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
    return 512, 512


def ellipse_rle(w: int, h: int, cx: float, cy: float, rx: float, ry: float) -> list[int]:
    """Column-major (COCO) RLE of a filled ellipse."""
    counts, v, run = [], 0, 0
    for x in range(w):
        for y in range(h):
            b = 1 if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 else 0
            if b != v:
                counts.append(run)
                run, v = 0, b
            run += 1
    counts.append(run)
    return counts


def run(payload: dict, asset: Asset) -> dict:
    """Fixed masks: one centred ellipse, plus one per point prompt. Deterministic."""
    w, h = image_size(asset_file(asset))
    shapes = [(w / 2, h / 2, w / 6, h / 8, "center")]
    for i, p in enumerate(payload.get("prompts") or []):
        if p.get("type") == "point" and p.get("positive", True):
            shapes.append((p["x"], p["y"], max(4, w / 20), max(4, h / 20), f"point-{i}"))
        elif p.get("type") == "box":
            x0, y0, x1, y1 = p["box"]
            shapes.append(((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, f"box-{i}"))
    instances = []
    for cx, cy, rx, ry, name in shapes:
        instances.append(
            {
                "instance_id": name,
                "mask": {"encoding": "rle", "size": [h, w], "counts": ellipse_rle(w, h, cx, cy, rx, ry)},
                "box_xyxy": [max(0, cx - rx), max(0, cy - ry), min(w, cx + rx), min(h, cy + ry)],
            }
        )
    return {"instances": instances, "provider": "mock", "model": "mock-ellipse-1", "status": "completed"}


def _png_gray(w: int, h: int, bits: bytes) -> bytes:  # used by tests for artifact masks
    raw = b"".join(b"\x00" + bits[y * w : (y + 1) * w] for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
