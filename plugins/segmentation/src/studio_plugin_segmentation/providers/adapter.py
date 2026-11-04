"""Shared plumbing for the generic provider adapters (todo25 W7): oip.py, replicate.py, hf.py.

A provider added by configuration is a plugin.yaml `providers` entry with an `adapter` block:

    adapter: {kind: oip | replicate | hf, endpoint: https://…, model?: …, secret?: NAME,
              image?: base64 | dataUrl, masks?: rle | png | polygons, fields?: {…}}

The endpoint's host must be one of the provider's `egress` hosts (what the install review shows),
and a workspace may point the provider at another endpoint with config
`endpoints: {<provider id>: url}` only within those hosts. Calls with a secret go through the
kernel's secrets broker (`ctx.secrets.use`), which injects the credential; the plugin never sees
a key. Calls without one (an in-project endpoint) go out through the worker's egress proxy.
"""

from __future__ import annotations

import base64
import json
import math
import struct
import zlib
from urllib.parse import urlsplit

import httpx

from ..masks_util import decode_provider_mask
from .base import ProviderError, RawInstance


class Adapter:
    """Base for the generic adapters: settings from the manifest entry, one HTTP door."""

    kind = ""
    default_masks = "rle"

    def __init__(self, ctx):
        decl = ctx.provider or {}
        cfg = decl.get("adapter") or {}
        if cfg.get("kind") != self.kind:
            raise ProviderError(f"provider {decl.get('id')!r} isn't configured for the {self.kind} adapter", recoverable=False)
        self.id = decl["id"]
        self.model = cfg.get("model") or self.id
        self.features = dict(decl.get("features") or {})
        self.egress = list(decl.get("egress") or [])
        self.secret = cfg.get("secret")
        if self.secret and self.secret not in (decl.get("secrets") or []):
            raise ProviderError(f"{self.id}: adapter secret {self.secret} isn't one of the provider's declared secrets", recoverable=False)
        self.image_as = cfg.get("image") or "base64"
        self.masks = cfg.get("masks") or self.default_masks
        self.fields = dict(cfg.get("fields") or {})
        override = ((ctx.config or {}).get("endpoints") or {}).get(self.id)
        self.endpoint = override or cfg.get("endpoint") or ""
        self.check_host(self.endpoint)

    # -- network -------------------------------------------------------------------------------
    def check_host(self, url: str) -> None:
        host = urlsplit(url).hostname
        if urlsplit(url).scheme != "https" or not host or host not in self.egress:
            raise ProviderError(f"{self.id}: {url or 'no endpoint'} isn't an https URL on a declared egress host ({', '.join(self.egress) or 'none'})", recoverable=False)

    def call(self, ctx, method: str, url: str, body=None, headers: dict | None = None) -> httpx.Response:
        self.check_host(url)
        if self.secret:
            client = ctx.secrets.use(self.secret)  # an ungranted secret fails first (PermissionError)
            r = client.request(method, url, json_body=body, headers=headers)
        else:
            try:
                # Egress is enforced by the worker's proxy: only granted hosts are reachable.
                r = httpx.request(method, url, json=body, headers=headers, timeout=120)
            except httpx.HTTPError as e:
                raise ProviderError(f"{self.id} unreachable: {e}") from e
        if r.status_code in (401, 403, 404):
            raise ProviderError(f"{self.id} refused the request ({r.status_code}); check the endpoint, the key and the egress grant", recoverable=False)
        if r.status_code == 429 or r.status_code >= 500:
            raise ProviderError(f"{self.id} returned {r.status_code}; retry later")
        if r.status_code >= 400:
            raise ProviderError(f"{self.id} returned {r.status_code}: {r.text[:300]}", recoverable=False)
        return r

    def field(self, name: str) -> str:
        return self.fields.get(name, name)

    def image_value(self, image: bytes) -> str:
        b64 = base64.b64encode(image).decode()
        return f"data:{_media_type(image)};base64,{b64}" if self.image_as == "dataUrl" else b64

    # -- masks ---------------------------------------------------------------------------------
    def decode_mask(self, value, width: int, height: int) -> bytes:
        return decode_mask(value, self.masks, width, height)

    def instances(self, items, width: int, height: int) -> list[RawInstance]:
        """A list of {mask, label?, score?} (field names per `fields`) → raw instances."""
        if not isinstance(items, list):
            raise ProviderError(f"{self.id}: expected a list of masks, got {type(items).__name__}", recoverable=False)
        out = []
        for it in items:
            if not isinstance(it, dict) or self.field("mask") not in it:
                raise ProviderError(f"{self.id}: a returned instance has no {self.field('mask')!r}", recoverable=False)
            score = it.get(self.field("score"))
            out.append(RawInstance(self.decode_mask(it[self.field("mask")], width, height), label=it.get(self.field("label")), confidence=float(score) if score is not None else None))
        return out


def prompts_of(request: dict) -> tuple[list[list[float]], list[list[float]], list[str]]:
    """(boxes [x1,y1,x2,y2], points [x,y,label 1|0], texts) from an image.segment request."""
    boxes, points, texts = [], [], []
    for p in request.get("prompts") or []:
        if p["type"] == "box":
            boxes.append([float(v) for v in p["box"]])
        elif p["type"] == "point":
            points.append([float(p["x"]), float(p["y"]), 1.0 if p.get("positive", True) else 0.0])
        elif p["type"] == "text":
            texts.append(p["text"])
    return boxes, points, texts


def _media_type(image: bytes) -> str:
    if image[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


# ---- mask formats → row-major 0/1 bytes ------------------------------------------------------


def decode_mask(value, fmt: str, width: int, height: int) -> bytes:
    if fmt == "rle":
        if isinstance(value, str):
            value = json.loads(value)
        return decode_provider_mask({"rle": value}, width, height)
    if fmt == "png":
        if not isinstance(value, str):
            raise ProviderError("expected a base64 PNG mask", recoverable=False)
        data = value.split(",", 1)[1] if value.startswith("data:") else value
        try:
            w, h, bits = decode_png(base64.b64decode(data))
        except (ValueError, zlib.error, struct.error) as e:
            raise ProviderError(f"invalid PNG mask: {e}", recoverable=False) from e
        if (w, h) != (width, height):
            raise ProviderError(f"PNG mask is {w}x{h}, image is {width}x{height}", recoverable=False)
        return bits
    if fmt == "polygons":
        if isinstance(value, str):
            value = json.loads(value)
        return rasterize(value, width, height)
    raise ProviderError(f"unknown mask format {fmt!r}", recoverable=False)


def _num(v) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def rasterize(polygons, width: int, height: int) -> bytes:
    """Polygons (one or many; each [[x,y],…] or flat [x1,y1,…]) → bits: pixels whose centre is
    inside a polygon (even-odd within a polygon, union across polygons)."""
    if not isinstance(polygons, list) or not polygons:
        raise ProviderError("expected a polygon list", recoverable=False)
    first = polygons[0]
    if _num(first) or (isinstance(first, list) and len(first) == 2 and all(_num(v) for v in first)):
        polygons = [polygons]  # a single polygon
    out = bytearray(width * height)
    for poly in polygons:
        pts = [tuple(p) for p in poly] if poly and isinstance(poly[0], list) else [tuple(poly[i : i + 2]) for i in range(0, len(poly) - 1, 2)]
        if len(pts) < 3:
            continue
        edges = list(zip(pts, pts[1:] + pts[:1], strict=True))
        for y in range(height):
            cy = y + 0.5
            xs = sorted(x0 + (cy - y0) * (x1 - x0) / (y1 - y0) for (x0, y0), (x1, y1) in edges if (y0 <= cy) != (y1 <= cy))
            for a, b in zip(xs[::2], xs[1::2], strict=False):
                for x in range(max(0, math.ceil(a - 0.5)), min(width, math.ceil(b - 0.5))):
                    out[y * width + x] = 1
    return bytes(out)


def decode_png(data: bytes) -> tuple[int, int, bytes]:
    """A non-interlaced 1/8-bit gray, gray+alpha, RGB, RGBA or palette PNG → (w, h, bits).
    A pixel is foreground when its first channel (or palette index) is nonzero."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    i, idat, ihdr = 8, b"", None
    while i < len(data):
        (n,) = struct.unpack(">I", data[i : i + 4])
        t, body = data[i + 4 : i + 8], data[i + 8 : i + 8 + n]
        if t == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif t == b"IDAT":
            idat += body
        elif t == b"IEND":
            break
        i += 12 + n
    if ihdr is None:
        raise ValueError("no IHDR")
    w, h, depth, color, _, _, interlace = ihdr
    if interlace or depth not in (1, 8):
        raise ValueError(f"unsupported PNG (bit depth {depth}, interlace {interlace})")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    bpp = max(1, channels * depth // 8)
    stride = (w * channels * depth + 7) // 8
    raw = zlib.decompress(idat)
    prev = bytearray(stride)
    out = bytearray(w * h)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 0xFF
            elif f == 2:
                line[x] = (line[x] + b) & 0xFF
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        for x in range(w):
            if depth == 1:
                v = (line[x >> 3] >> (7 - (x & 7))) & 1
            else:
                v = line[x * channels]
            out[y * w + x] = 1 if v else 0
        prev = line
    return w, h, bytes(out)
