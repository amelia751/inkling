"""Replicate / Cog predictions adapter (todo25 W7).

    POST {endpoint}  (https://api.replicate.com/v1/predictions with `model` as the version, or
                      https://api.replicate.com/v1/models/{owner}/{name}/predictions)
    {"version"?: <model>, "input": {"image": <data URL>, "boxes"?: [[x1,y1,x2,y2]…], "points"?: […], "text"?: "…"}}
    Prefer: wait          → the prediction (often already finished)
    GET  urls.get         → poll until status is succeeded | failed | canceled

The prediction's `output` (or `output[fields.instances]`) is a list of {mask, label?, score?};
a mask is RLE, a base64/data-URL PNG, polygons, or an https URL of a PNG on a declared egress
host (fetched through the same broker). A self-hosted Cog container exposes the same `input` /
`output` shape at `POST /predictions`; point `endpoint` at it.
"""

from __future__ import annotations

import time

from .adapter import Adapter, prompts_of
from .base import ProviderError, RawInstance

DONE = {"succeeded", "failed", "canceled"}


class Replicate(Adapter):
    kind = "replicate"
    default_masks = "png"
    poll_seconds = 1.0
    max_polls = 120

    def __init__(self, ctx):
        super().__init__(ctx)
        self.sleep = time.sleep

    def to_input(self, image: bytes, request: dict) -> dict:
        boxes, points, texts = prompts_of(request)
        body: dict = {self.field("image"): self.image_value(image)}
        if boxes:
            body[self.field("boxes")] = boxes
        if points:
            body[self.field("points")] = points
        if texts:
            body[self.field("text")] = ", ".join(texts)
        return body

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        if self.image_as == "base64":
            self.image_as = "dataUrl"  # Cog file inputs take URLs or data URLs
        body: dict = {"input": self.to_input(image, request)}
        if self.endpoint.rstrip("/").endswith("/v1/predictions"):
            body["version"] = self.model
        pred = self.call(ctx, "POST", self.endpoint, body, headers={"Prefer": "wait"}).json()
        polls = 0
        while pred.get("status") not in DONE:
            if polls >= self.max_polls:
                raise ProviderError(f"{self.id}: prediction {pred.get('id')} didn't finish in time")
            url = (pred.get("urls") or {}).get("get")
            if not url:
                raise ProviderError(f"{self.id}: the prediction has no status URL", recoverable=False)
            self.sleep(self.poll_seconds)
            polls += 1
            pred = self.call(ctx, "GET", url).json()
        if pred["status"] != "succeeded":
            raise ProviderError(f"{self.id}: prediction {pred['status']}: {str(pred.get('error'))[:300]}", recoverable=False)
        output = pred.get("output")
        if isinstance(output, dict):
            output = output.get(self.field("instances"))
        items = [it if isinstance(it, dict) else {self.field("mask"): it} for it in output or []]
        for it in items:
            m = it.get(self.field("mask"))
            if isinstance(m, str) and m.startswith("https://"):
                it[self.field("mask")] = self.fetch_png(ctx, m)
        return self.instances(items, width, height)

    def fetch_png(self, ctx, url: str) -> str:
        """A mask file URL → base64 PNG, fetched only from a declared egress host."""
        import base64

        r = self.call(ctx, "GET", url)
        return base64.b64encode(r.content).decode()
