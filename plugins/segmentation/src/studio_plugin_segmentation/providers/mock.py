"""Deterministic provider for CI and demos: an ellipse per prompt (or one centred ellipse)."""

from __future__ import annotations

from .base import RawInstance


def ellipse(width: int, height: int, cx: float, cy: float, rx: float, ry: float) -> bytes:
    out = bytearray(width * height)
    for y in range(max(0, int(cy - ry)), min(height, int(cy + ry) + 1)):
        for x in range(max(0, int(cx - rx)), min(width, int(cx + rx) + 1)):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                out[y * width + x] = 1
    return bytes(out)


class MockProvider:
    id = "mock"
    model = "mock-ellipse-1"
    features = {"text": True, "points": True, "boxes": True}

    def __init__(self, ctx):
        self.ctx = ctx

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        prompts = request.get("prompts") or []
        out: list[RawInstance] = []
        for p in prompts:
            if p["type"] == "point" and p.get("positive", True):
                out.append(RawInstance(ellipse(width, height, p["x"], p["y"], max(4, width / 20), max(4, height / 20))))
            elif p["type"] == "box":
                x0, y0, x1, y1 = p["box"]
                out.append(RawInstance(ellipse(width, height, (x0 + x1) / 2, (y0 + y1) / 2, max(1, (x1 - x0) / 2), max(1, (y1 - y0) / 2))))
            elif p["type"] == "text":
                out.append(RawInstance(ellipse(width, height, width / 2, height / 2, width / 6, height / 8), label=p["text"]))
        if not prompts:
            out.append(RawInstance(ellipse(width, height, width / 2, height / 2, width / 6, height / 8)))
        return out
