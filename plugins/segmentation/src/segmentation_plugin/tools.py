"""Tool entrypoints (plugin.yaml runtime.entrypoint = segmentation_plugin.tools:register)."""

from __future__ import annotations

from studio_plugin_sdk import Registry, ToolContext, ToolError
from studio_plugin_sdk.masks import image_size

from .normalize import to_result
from .providers import ProviderError, get_provider


def segment_objects(ctx: ToolContext, request: dict) -> dict:
    provider_id = (ctx.provider or {}).get("id") or request.get("provider") or "mock"
    provider = get_provider(provider_id, ctx)
    kinds = {p["type"] for p in request.get("prompts") or []}
    unsupported = [k for k in kinds if not provider.features.get({"point": "points", "box": "boxes"}.get(k, k), False)]
    if unsupported:
        raise ToolError(f"{provider.id} doesn't support {', '.join(sorted(unsupported))} prompts", recoverable=False)
    ctx.jobs.progress(0.1, "reading image")
    image = ctx.assets.read(request["asset_id"])
    width, height = image_size(image)
    ctx.jobs.progress(0.3, f"segmenting with {provider.id}")
    try:
        raw = provider.segment(ctx, image, width, height, request)
    except ProviderError as e:
        raise ToolError(str(e), recoverable=e.recoverable) from e
    ctx.jobs.progress(0.9, "normalising masks")
    return to_result(raw, width, height, provider=provider.id, model=provider.model)


def register(tools: Registry) -> None:
    tools.register("segment_objects", segment_objects)
