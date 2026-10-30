"""The provider abstraction: one capability (image.segment), many backends.

`segment(image, width, height, request)` returns raw instances as row-major 0/1 masks; the
plugin turns them into the provider-independent result (normalize.py). Providers differ in
features (text / point / box prompts); `supports` lets the tool refuse a prompt type a
provider doesn't handle instead of silently ignoring it (§12.3).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from studio_plugin_sdk import ToolContext


class ProviderError(Exception):
    def __init__(self, message: str, *, recoverable: bool = True):
        super().__init__(message)
        self.recoverable = recoverable


@dataclass
class RawInstance:
    bits: bytes  # row-major, 1 byte per pixel, nonzero = foreground
    label: str | None = None
    confidence: float | None = None


class Provider(Protocol):
    id: str
    model: str
    features: dict

    def segment(self, ctx: ToolContext, image: bytes, width: int, height: int, request: dict) -> list[RawInstance]: ...


def get_provider(provider_id: str, ctx: ToolContext) -> Provider:
    from .local_sam import LocalSam
    from .meta_sam import MetaSam
    from .mock import MockProvider

    impls = {"mock": MockProvider, "meta.sam": MetaSam, "local.sam": LocalSam}
    if provider_id not in impls:
        raise ProviderError(f"unknown provider {provider_id!r}", recoverable=False)
    return impls[provider_id](ctx)
