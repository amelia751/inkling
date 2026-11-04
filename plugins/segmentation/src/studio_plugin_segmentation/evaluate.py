"""Try before keep (todo25 D7): score a provider against fixtures with reference masks.

A provider added by configuration runs first over a small fixture set; its Dice agreement with
the reference masks decides whether it's kept, and the mean is what the install review shows
(plugin.yaml `providers[].quality`). Masks are row-major 0/1 bytes (what providers return).

Fixtures on disk: `<name>.png` (the image), `<name>_mask.png` (the reference, nonzero =
foreground) and an optional `<name>.json` (the image.segment request: prompts or a label).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from studio_plugin_sdk.masks import image_size

from .providers.adapter import decode_png
from .providers.base import Provider, RawInstance


def _bitset(bits: bytes) -> int:
    return int.from_bytes(bytes(1 if b else 0 for b in bits), "big")


def dice(predicted: bytes, reference: bytes) -> float:
    """2|A∩B| / (|A| + |B|); 1.0 when both are empty (agreeing there's nothing to find)."""
    if len(predicted) != len(reference):
        raise ValueError(f"mask sizes differ: {len(predicted)} vs {len(reference)}")
    a, b = _bitset(predicted), _bitset(reference)
    na, nb = a.bit_count(), b.bit_count()
    if na + nb == 0:
        return 1.0
    return 2 * (a & b).bit_count() / (na + nb)


def union(instances: list[RawInstance], size: int) -> bytes:
    acc = 0
    for inst in instances:
        acc |= _bitset(inst.bits)
    return acc.to_bytes(size, "big") if size else b""


@dataclass
class Fixture:
    id: str
    image: bytes
    reference: bytes  # row-major 0/1
    request: dict = field(default_factory=dict)


def load_fixtures(folder: Path) -> list[Fixture]:
    out = []
    for ref in sorted(folder.glob("*_mask.png")):
        name = ref.name[: -len("_mask.png")]
        image = (folder / f"{name}.png").read_bytes()
        _, _, bits = decode_png(ref.read_bytes())
        req_path = folder / f"{name}.json"
        out.append(Fixture(name, image, bits, json.loads(req_path.read_text()) if req_path.exists() else {}))
    return out


def evaluate_provider(ctx, provider: Provider, fixtures: list[Fixture], *, bar: float = 0.8, fixtures_name: str = "") -> dict:
    """Run `provider` over each fixture; per-image Dice (union of returned instances vs the
    reference), the mean, and whether it clears `bar`. A provider error scores that image 0."""
    per_image = []
    for fx in fixtures:
        width, height = image_size(fx.image)
        if len(fx.reference) != width * height:
            raise ValueError(f"{fx.id}: reference mask doesn't match the image size")
        try:
            instances = provider.segment(ctx, fx.image, width, height, {"asset_id": fx.id, **fx.request})
            score, error = dice(union(instances, width * height), fx.reference), None
        except Exception as e:  # noqa: BLE001 - a failing image is a 0, recorded with its reason
            score, error = 0.0, str(e)[:300]
        per_image.append({"id": fx.id, "dice": round(score, 4), **({"error": error} if error else {})})
    mean = sum(p["dice"] for p in per_image) / len(per_image) if per_image else 0.0
    return {
        "provider": provider.id,
        "model": provider.model,
        "perImage": per_image,
        # The shape of plugin.yaml `providers[].quality` (shown in the install review).
        "quality": {"metric": "dice", "mean": round(mean, 4), "images": len(per_image), "fixtures": fixtures_name, "evaluatedAt": date.today().isoformat()},
        "passed": bool(per_image) and mean >= bar,
        "bar": bar,
    }
