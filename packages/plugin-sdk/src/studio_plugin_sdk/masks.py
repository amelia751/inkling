"""Mask helpers for `image.segment` results (packages/contracts/src/capabilities/image.segment.ts).

Results use COCO-style uncompressed RLE: size [height, width], column-major runs starting
with background. The kernel normalises them into the Studio's canonical mask geometry.
"""

from __future__ import annotations

import struct
import zlib
from collections.abc import Sequence


def encode_rle(bits: Sequence[int] | bytes, height: int, width: int) -> dict:
    """Row-major 0/1 pixels → {"encoding": "rle", "size": [h, w], "counts": [...]} (column-major)."""
    counts, v, run = [], 0, 0
    for x in range(width):
        for y in range(height):
            b = 1 if bits[y * width + x] else 0
            if b != v:
                counts.append(run)
                run, v = 0, b
            run += 1
    counts.append(run)
    return {"encoding": "rle", "size": [height, width], "counts": counts}


def decode_rle(mask: dict) -> bytearray:
    """{"size": [h, w], "counts"} → row-major 0/1 bytes."""
    h, w = mask["size"]
    out = bytearray(h * w)
    i, v = 0, 0
    for run in mask["counts"]:
        if v:
            for k in range(i, i + run):
                out[(k % h) * w + k // h] = 1
        i += run
        v ^= 1
    if i != h * w:
        raise ValueError(f"RLE covers {i} pixels, expected {h * w}")
    return out


def bbox(bits: Sequence[int] | bytes, height: int, width: int) -> list[float] | None:
    """XYXY pixel box of the foreground, or None if empty."""
    xs, ys = [], []
    for y in range(height):
        row = bits[y * width : (y + 1) * width]
        for x, b in enumerate(row):
            if b:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return [float(min(xs)), float(min(ys)), float(max(xs) + 1), float(max(ys) + 1)]


def png_gray(bits: Sequence[int] | bytes, height: int, width: int) -> bytes:
    """A binary mask as an 8-bit grayscale PNG (for artifact-backed masks)."""
    raw = b"".join(b"\x00" + bytes(255 if bits[y * width + x] else 0 for x in range(width)) for y in range(height))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def image_size(data: bytes) -> tuple[int, int]:
    """(width, height) of a PNG or JPEG without decoding pixels."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return w, h
            i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
    raise ValueError("unsupported image (PNG or JPEG expected)")
