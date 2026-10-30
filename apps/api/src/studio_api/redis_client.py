"""One Redis client per settings (job queue, event bus, readiness). Keys are namespaced
with the naming config's `resourcePrefix`: `<resourcePrefix>:jobs:ready`, …"""

from __future__ import annotations

from typing import Any

from .config import Settings, settings
from .naming import naming

_cache: tuple[Settings, Any] | None = None


def key(*parts: str) -> str:
    return ":".join((naming()["resourcePrefix"], *parts))


def client() -> Any:
    """A `redis.Redis` (str responses). Raises if REDIS_URL isn't configured."""
    global _cache
    s = settings()
    if _cache is None or _cache[0] is not s:
        if not s.redis_url:
            raise RuntimeError("REDIS_URL is not configured")
        import redis

        _cache = (s, redis.Redis.from_url(s.redis_url, decode_responses=True, socket_timeout=5, socket_connect_timeout=5, health_check_interval=30))
    return _cache[1]


def reset() -> None:
    global _cache
    _cache = None
