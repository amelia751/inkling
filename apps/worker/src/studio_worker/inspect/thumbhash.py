"""ThumbHash encoder (Evan Wallace's format, https://evanw.github.io/thumbhash/, MIT): a ~25-byte
placeholder that the Studio decodes into a blurred image with the right aspect ratio while the
thumbnail loads. Same bit layout as the reference `rgbaToThumbHash`; numpy for the DCT."""

from __future__ import annotations

import base64
import math

import numpy as np


def encode(w: int, h: int, rgba: bytes) -> bytes:
    """`rgba`: w×h×4 bytes, w and h at most 100."""
    if w > 100 or h > 100:
        raise ValueError(f"{w}x{h} doesn't fit in 100x100")
    px = np.frombuffer(rgba, dtype=np.uint8).reshape(h, w, 4).astype(np.float64)
    alpha = px[..., 3] / 255
    total_a = float(alpha.sum())
    avg = [float((alpha / 255 * px[..., c]).sum()) for c in range(3)]
    if total_a:
        avg = [v / total_a for v in avg]
    has_alpha = total_a < w * h
    l_limit = 5 if has_alpha else 7
    lx = max(1, round(l_limit * w / max(w, h)))
    ly = max(1, round(l_limit * h / max(w, h)))
    r, g, b = (avg[c] * (1 - alpha) + alpha / 255 * px[..., c] for c in range(3))
    lum = (r + g + b) / 3
    p = (r + g) / 2 - b
    q = r - g

    def channel(ch: np.ndarray, nx: int, ny: int) -> tuple[float, list[float], float]:
        dc, ac, scale = 0.0, [], 0.0
        xs = (np.arange(w) + 0.5) * math.pi / w
        ys = (np.arange(h) + 0.5) * math.pi / h
        for cy in range(ny):
            cx = 0
            while cx * ny < nx * (ny - cy):
                f = float((ch * np.outer(np.cos(ys * cy), np.cos(xs * cx))).sum()) / (w * h)
                if cx or cy:
                    ac.append(f)
                    scale = max(scale, abs(f))
                else:
                    dc = f
                cx += 1
        if scale:
            ac = [0.5 + 0.5 / scale * v for v in ac]
        return dc, ac, scale

    l_dc, l_ac, l_scale = channel(lum, max(3, lx), max(3, ly))
    p_dc, p_ac, p_scale = channel(p, 3, 3)
    q_dc, q_ac, q_scale = channel(q, 3, 3)
    a_dc, a_ac, a_scale = channel(alpha, 5, 5) if has_alpha else (0.0, [], 0.0)
    landscape = w > h
    header24 = round(63 * l_dc) | (round(31.5 + 31.5 * p_dc) << 6) | (round(31.5 + 31.5 * q_dc) << 12) | (round(31 * l_scale) << 18) | (int(has_alpha) << 23)
    header16 = (ly if landscape else lx) | (round(63 * p_scale) << 3) | (round(63 * q_scale) << 9) | (int(landscape) << 15)
    out = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8]
    if has_alpha:
        out.append(round(15 * a_dc) | (round(15 * a_scale) << 4))
    start = len(out)
    i = 0
    for ac in [l_ac, p_ac, q_ac, a_ac] if has_alpha else [l_ac, p_ac, q_ac]:
        for f in ac:
            k = start + (i >> 1)
            while len(out) <= k:
                out.append(0)
            out[k] |= round(15 * f) << ((i & 1) << 2)
            i += 1
    return bytes(out)


def of_image(img) -> str:
    """Base64 ThumbHash of a PIL image (scaled to fit 64×64 first)."""
    small = img.convert("RGBA")
    small.thumbnail((64, 64))
    return base64.b64encode(encode(small.width, small.height, small.tobytes())).decode()
