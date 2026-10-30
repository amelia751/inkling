"""Self-hosted SAM-compatible endpoint (§12.3). Contract of the endpoint (yours to run):

    POST {localEndpoint}   {"image": {"base64": …}, "prompts": [...]}
    → {"masks": [{"rle": {"size": [h, w], "counts": [...]}, "label"?: str, "score"?: float}]}

No text prompts unless the endpoint says so (`features` in plugin.yaml); a text prompt is
refused rather than silently ignored.
"""

from __future__ import annotations

import base64

import httpx

from .base import ProviderError, RawInstance
from ..masks_util import decode_provider_mask


class LocalSam:
    id = "local.sam"
    model = "sam-local"
    features = {"text": False, "points": True, "boxes": True}

    def __init__(self, ctx):
        cfg = ctx.config or {}
        self.endpoint = cfg.get("localEndpoint", "https://sam.internal/segment")

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        if any(p["type"] == "text" for p in request.get("prompts") or []):
            raise ProviderError("local.sam doesn't support text prompts; use points or boxes", recoverable=False)
        try:
            # Egress is enforced by the worker's proxy: only granted hosts are reachable.
            r = httpx.post(self.endpoint, json={"image": {"base64": base64.b64encode(image).decode()}, "prompts": request.get("prompts") or []}, timeout=120)
        except httpx.HTTPError as e:
            raise ProviderError(f"local.sam unreachable: {e}") from e
        if r.status_code >= 400:
            raise ProviderError(f"local.sam returned {r.status_code}")
        return [RawInstance(decode_provider_mask(m, width, height), label=m.get("label"), confidence=m.get("score")) for m in r.json().get("masks", [])]
