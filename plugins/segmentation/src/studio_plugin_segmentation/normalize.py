"""Raw provider instances → the provider-independent image.segment result (§6.1)."""

from __future__ import annotations

from studio_plugin_sdk.masks import bbox, encode_rle

from .providers.base import RawInstance


def to_result(instances: list[RawInstance], width: int, height: int, *, provider: str, model: str) -> dict:
    out = []
    for i, inst in enumerate(instances):
        if len(inst.bits) != width * height:
            raise ValueError(f"instance {i}: mask has {len(inst.bits)} pixels, image has {width * height}")
        box = bbox(inst.bits, height, width)
        if box is None:
            continue  # empty masks aren't annotations
        item = {"instance_id": f"i{i}", "mask": encode_rle(inst.bits, height, width), "box_xyxy": box}
        if inst.label:
            item["label"] = inst.label
        if inst.confidence is not None:  # never invent a score (§6.1)
            item["confidence"] = float(inst.confidence)
        out.append(item)
    return {"instances": out, "provider": provider, "model": model, "status": "completed"}
