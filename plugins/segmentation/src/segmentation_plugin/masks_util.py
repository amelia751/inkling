"""Decoding provider masks into row-major bits (shared by the HTTP providers)."""

from __future__ import annotations

from studio_plugin_sdk.masks import decode_rle

from .providers.base import ProviderError


def decode_provider_mask(m: dict, width: int, height: int) -> bytes:
    rle = m.get("rle")
    if not isinstance(rle, dict) or list(rle.get("size", [])) != [height, width]:
        raise ProviderError("provider returned a mask that isn't an RLE of the image's size")
    try:
        return bytes(decode_rle(rle))
    except ValueError as e:
        raise ProviderError(f"invalid provider mask: {e}") from e
