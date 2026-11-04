"""Hugging Face Inference Endpoints adapter (todo25 W7).

    POST {endpoint}   (https://<name>.<region>.<vendor>.endpoints.huggingface.cloud)
    {"inputs": <base64 image>, "parameters": {"boxes"?: [[x1,y1,x2,y2]…], "points"?: […], "text"?: "…"}}
    → [{"mask": <base64 PNG>, "label"?: str, "score"?: float}, …]

That's the `image-segmentation` pipeline's response shape; a custom handler may return RLE or
polygons instead (`adapter.masks`) or wrap the list (`fields.instances`).
"""

from __future__ import annotations

from .adapter import Adapter, prompts_of
from .base import RawInstance


class HuggingFace(Adapter):
    kind = "hf"
    default_masks = "png"

    def to_request(self, image: bytes, request: dict) -> dict:
        boxes, points, texts = prompts_of(request)
        params: dict = {}
        if boxes:
            params[self.field("boxes")] = boxes
        if points:
            params[self.field("points")] = points
        if texts:
            params[self.field("text")] = ", ".join(texts)
        return {self.field("inputs"): self.image_value(image), **({"parameters": params} if params else {})}

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        body = self.call(ctx, "POST", self.endpoint, self.to_request(image, request), headers={"Accept": "application/json"}).json()
        if isinstance(body, dict):
            body = body.get(self.field("instances"))
        return self.instances(body, width, height)
