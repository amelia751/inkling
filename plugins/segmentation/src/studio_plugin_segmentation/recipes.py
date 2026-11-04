"""Prompt recipes (todo25 D2): a label → prompts for a kind of image, without looking at it.

A recipe is data in the plugin's config (`config.schema.json` has the schema and the
defaults): `{"<name>": {"appliesTo": "...", "boxesRel": [[x0, y0, x1, y1], ...], "names": [...]}}`.
`boxesRel` are fractions of the image's width and height; `names[i]` labels the mask that box
`i` produces. The worker sizes the boxes from the image header, so no pixels go anywhere but
the provider. Workspace config can add recipes or override a default one by name.

Why boxes: SAM's text (concept) prompts find nothing on radiographs (todo25 §0.3), while two
fixed boxes, one per side of the thorax, give clean lung masks on frontal chest X-rays.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from .providers.base import ProviderError

CONFIG_SCHEMA = Path(__file__).resolve().parent / "config.schema.json"


def default_recipes() -> dict[str, dict]:
    """The defaults shipped in config.schema.json (the single source for them)."""
    schema = json.loads(CONFIG_SCHEMA.read_text())
    return copy.deepcopy(schema["properties"]["recipes"]["default"])


def recipes(config: dict | None) -> dict[str, dict]:
    return {**default_recipes(), **((config or {}).get("recipes") or {})}


def find_recipe(config: dict | None, label: str) -> tuple[str, dict] | None:
    known = recipes(config)
    key = label.strip().lower()
    for name, recipe in known.items():
        if name.lower() == key:
            return name, recipe
    return None


def _check(name: str, recipe: dict) -> None:
    boxes, names = recipe.get("boxesRel"), recipe.get("names")
    if not isinstance(boxes, list) or not boxes or not isinstance(names, list) or len(names) != len(boxes):
        raise ProviderError(f"recipe {name!r} needs boxesRel and one name per box", recoverable=False)
    for b in boxes:
        if not (isinstance(b, list) and len(b) == 4 and all(isinstance(v, int | float) and 0 <= v <= 1 for v in b) and b[0] < b[2] and b[1] < b[3]):
            raise ProviderError(f"recipe {name!r} has an invalid relative box {b!r}", recoverable=False)


def recipe_prompts(name: str, recipe: dict, width: int, height: int) -> list[dict]:
    """The recipe's relative boxes → Studio box prompts (half-open XYXY pixels) for this image."""
    _check(name, recipe)
    return [{"type": "box", "box": [round(x0 * width), round(y0 * height), round(x1 * width), round(y1 * height)]} for x0, y0, x1, y1 in recipe["boxesRel"]]
