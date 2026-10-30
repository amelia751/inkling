"""Meta SAM (hosted) adapter.

NOT VERIFIED against a live API. docs/plugins.md §12.1: this adapter must follow Meta's
*current* API documentation at integration time; `SegmentRequest` is the Studio's internal
abstraction, not Meta's signature. The request/response mapping is isolated in
`to_provider_request` and `from_provider_response` so integrating means changing those two
functions (and the endpoint in the workspace config), nothing else.

Config (workspace plugin config): {"metaEndpoint": "https://…", "metaModel": "…"}.
Credentials go through the kernel's secrets broker (`secrets.use:META_MODEL_API_KEY`); egress
to the endpoint's host must be granted. Pricing must be added to plugin.yaml before the
gateway will run billable calls.
"""

from __future__ import annotations

import base64
from urllib.parse import urlsplit

from .base import ProviderError, RawInstance
from ..masks_util import decode_provider_mask


def to_provider_request(image: bytes, request: dict, model: str) -> dict:
    """Studio request → provider payload. Placeholder shape; verify against Meta's docs."""
    return {
        "model": model,
        "image": {"base64": base64.b64encode(image).decode()},
        "prompts": request.get("prompts") or [],
    }


def from_provider_response(body: dict, width: int, height: int) -> list[RawInstance]:
    """Provider payload → raw instances. Placeholder shape; verify against Meta's docs."""
    out = []
    for m in body.get("masks", []):
        bits = decode_provider_mask(m, width, height)
        out.append(RawInstance(bits, label=m.get("label"), confidence=m.get("score")))
    return out


class MetaSam:
    id = "meta.sam"
    features = {"text": True, "points": True, "boxes": True}

    def __init__(self, ctx):
        cfg = ctx.config or {}
        self.endpoint = cfg.get("metaEndpoint")
        self.model = cfg.get("metaModel", "sam")

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        if not self.endpoint:
            raise ProviderError("meta.sam needs `metaEndpoint` in the plugin config (from Meta's current API docs)", recoverable=False)
        host = urlsplit(self.endpoint).hostname
        client = ctx.secrets.use("META_MODEL_API_KEY")
        r = client.post(self.endpoint, json_body=to_provider_request(image, request, self.model))
        if r.status_code == 403 and host:
            raise ProviderError(f"egress to {host} isn't granted, or the key was refused", recoverable=False)
        if r.status_code >= 400:
            raise ProviderError(f"meta.sam returned {r.status_code}: {r.text[:300]}")
        return from_provider_response(r.json(), width, height)
