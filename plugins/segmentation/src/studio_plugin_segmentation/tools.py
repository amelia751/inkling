"""Tool entrypoints (plugin.yaml runtime.entrypoint = studio_plugin_segmentation.tools:register)."""

from __future__ import annotations

from studio_plugin_sdk import Registry, ToolContext, ToolError
from studio_plugin_sdk.masks import image_size

from .normalize import to_result
from .providers import ProviderError, get_provider
from .providers.base import RawInstance
from .recipes import find_recipe, recipe_prompts, recipes


def _name_masks(raw: list[RawInstance], names: list[str]) -> list[RawInstance]:
    """Label each mask with its recipe box's name (by prompt index, else by position)."""
    out = []
    for pos, inst in enumerate(raw):
        i = inst.prompt_index if inst.prompt_index is not None else pos
        out.append(RawInstance(inst.bits, label=names[i] if 0 <= i < len(names) else inst.label, confidence=inst.confidence, prompt_index=inst.prompt_index))
    return out


def segment_objects(ctx: ToolContext, request: dict) -> dict:
    provider_id = (ctx.provider or {}).get("id") or request.get("provider") or "mock"
    provider = get_provider(provider_id, ctx)
    recipe = None
    label = (request.get("label") or "").strip()
    if not request.get("prompts") and label:
        # A label with no prompts names a recipe (todo25 D2); an unknown one is a clear refusal,
        # not a guess (SAM's text prompts find nothing on radiographs, §0.3).
        recipe = find_recipe(ctx.config, label)
        if recipe is None:
            known = ", ".join(sorted(recipes(ctx.config))) or "none"
            raise ToolError(f"no prompts and no recipe named {label!r} (recipes: {known}); pass a recipe name as the label, or text, box or point prompts", recoverable=False)
    kinds = {"box"} if recipe else {p["type"] for p in request.get("prompts") or []}
    unsupported = [k for k in kinds if not provider.features.get({"point": "points", "box": "boxes"}.get(k, k), False)]
    if unsupported:
        raise ToolError(f"{provider.id} doesn't support {', '.join(sorted(unsupported))} prompts", recoverable=False)
    ctx.jobs.progress(0.1, "reading image")
    image = ctx.assets.read(request["asset_id"])
    width, height = image_size(image)  # from the header; the pixels go only to the provider
    try:
        if recipe:
            name, spec = recipe
            request = {**request, "prompts": recipe_prompts(name, spec, width, height)}
        ctx.jobs.progress(0.3, f"segmenting with {provider.id}" + (f" (recipe {recipe[0]})" if recipe else ""))
        raw = provider.segment(ctx, image, width, height, request)
    except ProviderError as e:
        raise ToolError(str(e), recoverable=e.recoverable) from e
    if recipe:
        raw = _name_masks(raw, recipe[1]["names"])
    ctx.jobs.progress(0.9, "normalising masks")
    return to_result(raw, width, height, provider=provider.id, model=provider.model)


def register(tools: Registry) -> None:
    tools.register("segment_objects", segment_objects)
