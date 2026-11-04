"""Open Inference Protocol v2 (KServe v2 / Triton / Seldon MLServer) adapter (todo25 W7).

    POST {endpoint}/v2/models/{model}/infer
    {"inputs": [{"name": "image", "datatype": "BYTES", "shape": [1], "data": [<base64>]},
                {"name": "boxes", "datatype": "FP32", "shape": [n, 4], "data": [x1, y1, x2, y2, …]},
                {"name": "points", "datatype": "FP32", "shape": [n, 3], "data": [x, y, 1|0, …]},
                {"name": "text", "datatype": "BYTES", "shape": [1], "data": ["lung"]}]}
    → {"outputs": [{"name": "masks", "datatype": "UINT8" | "BOOL", "shape": [n, h, w], "data": [...]}
                   | {"name": "masks", "datatype": "BYTES", "shape": [n], "data": [<rle json | base64 png | polygons json>]},
                   {"name": "scores", "shape": [n], "data": [...]}?, {"name": "labels", "datatype": "BYTES", ...}?]}

Tensor names are the defaults above; `adapter.fields` renames them for a given model server.
"""

from __future__ import annotations

from .adapter import Adapter, prompts_of
from .base import ProviderError, RawInstance


def to_infer_request(adapter: "Oip", image: bytes, request: dict) -> dict:
    boxes, points, texts = prompts_of(request)
    inputs = [{"name": adapter.field("image"), "datatype": "BYTES", "shape": [1], "data": [adapter.image_value(image)]}]
    if boxes:
        inputs.append({"name": adapter.field("boxes"), "datatype": "FP32", "shape": [len(boxes), 4], "data": [v for b in boxes for v in b]})
    if points:
        inputs.append({"name": adapter.field("points"), "datatype": "FP32", "shape": [len(points), 3], "data": [v for p in points for v in p]})
    if texts:
        inputs.append({"name": adapter.field("text"), "datatype": "BYTES", "shape": [len(texts)], "data": texts})
    return {"inputs": inputs}


def from_infer_response(adapter: "Oip", body: dict, width: int, height: int) -> list[RawInstance]:
    outputs = {o.get("name"): o for o in body.get("outputs") or [] if isinstance(o, dict)}
    masks = outputs.get(adapter.field("masks"))
    if masks is None:
        raise ProviderError(f"{adapter.id}: the response has no {adapter.field('masks')!r} output", recoverable=False)
    data, shape = masks.get("data") or [], masks.get("shape") or []
    if masks.get("datatype") == "BYTES":
        bits = [adapter.decode_mask(v, width, height) for v in data]
    else:
        # A dense tensor [n, h, w] (or [n, 1, h, w]), row-major.
        if not shape or shape[-2:] != [height, width]:
            raise ProviderError(f"{adapter.id}: mask tensor shape {shape} doesn't match the image ({height}x{width})", recoverable=False)
        n, px = (shape[0] if len(shape) > 2 else 1), width * height
        if len(data) != n * px:
            raise ProviderError(f"{adapter.id}: mask tensor has {len(data)} values, shape says {n * px}", recoverable=False)
        bits = [bytes(1 if v else 0 for v in data[i * px : (i + 1) * px]) for i in range(n)]
    scores = (outputs.get(adapter.field("scores")) or {}).get("data") or []
    labels = (outputs.get(adapter.field("labels")) or {}).get("data") or []
    return [RawInstance(b, label=labels[i] if i < len(labels) else None, confidence=float(scores[i]) if i < len(scores) else None) for i, b in enumerate(bits)]


class Oip(Adapter):
    kind = "oip"
    default_masks = "rle"

    def infer_url(self) -> str:
        return f"{self.endpoint.rstrip('/')}/v2/models/{self.model}/infer"

    def segment(self, ctx, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]:
        r = self.call(ctx, "POST", self.infer_url(), to_infer_request(self, image, request))
        return from_infer_response(self, r.json(), width, height)
