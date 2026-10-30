"""Meta SAM 3.1 through Meta's hosted Model API.

Checked against Meta's public docs on 2026-10-30 (docs/plugins.md §12.1: `SegmentRequest` is
the Studio's abstraction, not Meta's signature; everything Meta-specific is in this file):

- https://dev.meta.ai/docs/sam/overview, https://dev.meta.ai/docs/sam/segmenting,
  https://dev.meta.ai/docs/sam/reading-segmentation, https://dev.meta.ai/docs/media-segmentation,
  https://dev.meta.ai/docs/sam/client-libraries, https://dev.meta.ai/docs/pricing-rate-limits
- Meta's official parser, `meta-sam-parser` 0.1.0 (Meta Platforms, Inc., SAM License,
  https://pypi.org/project/meta-sam-parser/), read for the token grammar and mask bounds.

What the docs say, and how this adapter maps it:

- **Endpoint and auth.** `POST https://api.meta.ai/v1/responses` (an OpenAI-style Responses
  API), `Authorization: Bearer <key>`, `"model": "sam-3.1"`. The key never reaches this
  process: `ctx.secrets.use("META_MODEL_API_KEY")` returns a client whose calls go through
  the kernel's secrets broker, which injects the header.
- **Request.** One user message whose content is an `input_text` part plus an
  `input_image` part (`image_url`: a public URL or a base64 data URL; we send a data URL).
  The text is *either* a short noun phrase (one concept per request) *or* object prompts
  in Meta's token grammar (`<0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>` with inclusive
  `x2/y2`; points `<|point;x=..;y=..;w=..;h=..|>`, `-` prefix for negative), never both.
  `metadata.include_confidence: "true"` asks for scores. So: a `text` prompt → the noun
  phrase; each `box` prompt → one object; `point` prompts → added to the first object (or
  one object of their own). Text mixed with boxes/points, or more than one text prompt, is
  refused (non-recoverable): Meta bills per request (per image), and the gateway's
  estimate is one billable image per `image.segment` call (§14 #10).
- **Response.** Special-token text in the `output_text` part, one line per frame
  (`<0f>` for an image), comma-separated objects:
  `id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=..]|><|mask;x=0;y=0[;c=..];data=H,W,<enc>payload|>`.
  Boxes are XYXY source pixels with inclusive x2/y2; the mask is a box-local H×W binary
  raster placed on the box's half-open bounds; `c` is a confidence in [0, 1]; empty text
  means no match. This file parses that grammar itself.
- **Mask payloads** are base85 range-coded rasters (`~` lossless, `!` one_bit). Meta
  documents no decoder other than its parser library, so `decode_payload` uses
  `meta_sam_parser.decode_mask_to_raster` when it is installed in the plugin's environment.
  It is *not* in `uv.lock` yet: adding a third-party dependency needs a reviewed lock
  change (todo2 Phase 6). Until then the provider refuses, non-recoverably, *before* the
  billable call rather than guessing masks; tests inject a decoder (`MetaSam.decode`).
- **Limits and price** (same date): 3,000 requests/min per team; images $2.50 per 1,000
  (`pricing` in plugin.yaml, with `effectiveAt` and `sourceUrl`). No image-size limit is
  documented; video isn't used here.

Config (workspace plugin config, optional): `{"metaEndpoint": "…", "metaModel": "sam-3.1"}`
to point at another Responses-compatible deployment. Egress to the endpoint's host must be
granted (`network.egress:api.meta.ai`).
"""

from __future__ import annotations

import base64
import importlib.util
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from .base import ProviderError, RawInstance

ENDPOINT = "https://api.meta.ai/v1/responses"
MODEL = "sam-3.1"

# (encoding marker + payload, raster width, raster height) → row-major 0/1 bytes.
Decoder = Callable[[str, int, int], bytes]


def decode_payload(payload: str, width: int, height: int) -> bytes:
    """Meta's mask codec, through its official parser when installed (see the module docstring)."""
    try:
        from meta_sam_parser import SegmentationMask, decode_mask_to_raster  # type: ignore[import-not-found]
    except ImportError as e:
        raise ProviderError("decoding Meta SAM masks needs Meta's `meta-sam-parser` in this plugin's environment, which isn't locked yet", recoverable=False) from e
    enc = "lossless" if payload.startswith("~") else "one_bit"
    try:
        return bytes(decode_mask_to_raster(SegmentationMask(encoding=enc, payload=payload, width=width, height=height)))
    except Exception as e:  # noqa: BLE001 — the parser's InvalidSegmentationMaskError
        raise ProviderError(f"invalid Meta SAM mask: {e}") from e


# ---- Request -------------------------------------------------------------------------------


def _media_type(image: bytes) -> str:
    return "image/png" if image[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg" if image[:2] == b"\xff\xd8" else "image/webp"


def prompt_text(request: dict, width: int, height: int) -> str:
    """Studio prompts → the `input_text` Meta expects (a noun phrase, or object-prompt tokens)."""
    prompts = request.get("prompts") or []
    texts = [p["text"] for p in prompts if p["type"] == "text"]
    boxes = [p["box"] for p in prompts if p["type"] == "box"]
    points = [p for p in prompts if p["type"] == "point"]
    if texts and (boxes or points):
        raise ProviderError("Meta SAM takes a text prompt or box/point prompts in one request, not both", recoverable=False)
    if len(texts) > 1:
        raise ProviderError("Meta SAM segments one concept per request; send one text prompt per call", recoverable=False)
    if texts:
        return texts[0]
    if not boxes and not points:
        raise ProviderError("Meta SAM needs a text, box or point prompt", recoverable=False)
    view = f"w={width};h={height}"

    def box_token(b: list[float]) -> str:
        # Studio boxes are half-open XYXY pixels; Meta's x2/y2 are inclusive.
        x1, y1 = max(0, math.floor(b[0])), max(0, math.floor(b[1]))
        x2, y2 = min(width, math.ceil(b[2])) - 1, min(height, math.ceil(b[3])) - 1
        if not (x1 <= x2 and y1 <= y2):
            raise ProviderError(f"box {b} lies outside the {width}×{height} image", recoverable=False)
        return f"<|box;x1={x1};y1={y1};x2={x2};y2={y2};{view}|>"

    def point_token(p: dict) -> str:
        x, y = int(p["x"]), int(p["y"])
        if not (0 <= x < width and 0 <= y < height):
            raise ProviderError(f"point ({p['x']}, {p['y']}) lies outside the {width}×{height} image", recoverable=False)
        return ("" if p.get("positive", True) else "-") + f"<|point;x={x};y={y};{view}|>"

    pts = "".join(point_token(p) for p in points)
    objects = [f"{i}{box_token(b)}{pts if i == 0 else ''}" for i, b in enumerate(boxes)] or [f"0{pts}"]
    return "<0f>" + ",".join(objects)


def to_provider_request(image: bytes, request: dict, model: str, width: int, height: int) -> dict:
    data_url = f"data:{_media_type(image)};base64,{base64.b64encode(image).decode()}"
    return {
        "model": model,
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt_text(request, width, height)}, {"type": "input_image", "image_url": data_url}]}],
        "metadata": {"include_confidence": "true"},
    }


# ---- Response ------------------------------------------------------------------------------


def output_text(body: dict) -> str:
    """The `output_text` of a non-streamed Responses API reply."""
    if isinstance(body.get("output_text"), str):
        return body["output_text"]
    parts = [c.get("text", "") for item in body.get("output") or [] if isinstance(item, dict) for c in item.get("content") or [] if isinstance(c, dict) and c.get("type") == "output_text"]
    if not parts and body.get("status") not in (None, "completed"):
        raise ProviderError(f"Meta SAM response is {body.get('status')}: {body.get('error') or body.get('incomplete_details')}")
    return "".join(parts)


@dataclass
class MetaMatch:
    object_id: str
    box: tuple[int, int, int, int]  # half-open XYXY source pixels
    mask_w: int
    mask_h: int
    payload: str
    confidence: float | None


# Payloads use an 85-character alphabet that excludes quote, backslash, `,`, `;`, `<`, `>` and
# `|` (meta-sam-parser `_mask_codec`), so `|` safely ends a token.
_OBJECT = re.compile(r"(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>")


def _fields(s: str) -> dict[str, str]:
    out = {}
    for part in s.split(";"):
        k, sep, v = part.partition("=")
        if sep:
            out[k.strip()] = v.strip()
    return out


def parse_output(text: str, width: int, height: int) -> list[MetaMatch]:
    """Meta's image output grammar → matches. Anything that doesn't parse is a provider error."""
    matches: dict[str, MetaMatch] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if not re.match(r"<0f(;[^>]*)?>", line):
            raise ProviderError(f"unexpected Meta SAM output line: {line[:80]!r}")
        for m in _OBJECT.finditer(line):
            box, mask = _fields(m.group(2)), _fields(m.group(3))
            try:
                x1, y1, x2, y2 = (int(box[k]) for k in ("x1", "y1", "x2", "y2"))
                h, w, payload = mask["data"].split(",", 2)
                conf = mask.get("c") or box.get("c")
                c = float(conf) if conf is not None else None
            except (KeyError, ValueError) as e:
                raise ProviderError(f"malformed Meta SAM match {m.group(0)[:80]!r}") from e
            if (box.get("w"), box.get("h")) not in ((str(width), str(height)), (None, None)):
                raise ProviderError(f"Meta SAM answered for a {box.get('w')}×{box.get('h')} image, expected {width}×{height}")
            if not (0 <= x1 <= x2 < width and 0 <= y1 <= y2 < height) or (c is not None and not 0 <= c <= 1):
                raise ProviderError(f"Meta SAM box or confidence out of range: {m.group(0)[:80]!r}")
            matches[m.group(1)] = MetaMatch(m.group(1), (x1, y1, x2 + 1, y2 + 1), int(w), int(h), payload, c)
    return list(matches.values())


def paste(local: bytes, mw: int, mh: int, box: tuple[int, int, int, int], width: int, height: int) -> bytes:
    """A box-local raster → a full-size row-major mask (nearest-neighbour if not box-sized)."""
    if mw <= 0 or mh <= 0 or len(local) != mw * mh:
        raise ProviderError("Meta SAM mask raster doesn't match its declared size")
    left, top, right, bottom = box
    bw, bh = right - left, bottom - top
    bits = bytearray(width * height)
    for y in range(bh):
        sy = y * mh // bh
        row = (top + y) * width
        for x in range(bw):
            if local[sy * mw + x * mw // bw]:
                bits[row + left + x] = 1
    return bytes(bits)


def from_provider_response(body: dict, width: int, height: int, decode: Decoder = decode_payload) -> list[RawInstance]:
    out = []
    for m in parse_output(output_text(body), width, height):
        local = decode(m.payload, m.mask_w, m.mask_h)
        out.append(RawInstance(paste(local, m.mask_w, m.mask_h, m.box, width, height), label=None, confidence=m.confidence))
    return out


class MetaSam:
    id = "meta.sam"
    # One request is one concept or one set of object prompts; text and boxes/points can't be mixed.
    features = {"text": True, "points": True, "boxes": True}

    def __init__(self, ctx):
        cfg = ctx.config or {}
        self.endpoint = cfg.get("metaEndpoint") or ENDPOINT
        self.model = cfg.get("metaModel") or MODEL
        self.decode: Decoder = decode_payload

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        client = ctx.secrets.use("META_MODEL_API_KEY")  # an ungranted secret fails first
        if self.decode is decode_payload and importlib.util.find_spec("meta_sam_parser") is None:
            # Refuse before the billable call, not after it.
            raise ProviderError("decoding Meta SAM masks needs Meta's `meta-sam-parser` in this plugin's environment, which isn't locked yet", recoverable=False)
        body = to_provider_request(image, request, self.model, width, height)
        host = urlsplit(self.endpoint).hostname
        r = client.post(self.endpoint, json_body=body)
        if r.status_code == 403 and host:
            raise ProviderError(f"egress to {host} isn't granted, or the key was refused", recoverable=False)
        if r.status_code in (401, 404):
            # 404 model_not_found: the team has no access to the model.
            raise ProviderError(f"Meta SAM refused the request ({r.status_code}): {r.text[:300]}", recoverable=False)
        if r.status_code == 429 or r.status_code >= 500:
            raise ProviderError(f"Meta SAM returned {r.status_code}; retry later")
        if r.status_code >= 400:
            raise ProviderError(f"Meta SAM returned {r.status_code}: {r.text[:300]}", recoverable=False)
        return from_provider_response(r.json(), width, height, self.decode)
