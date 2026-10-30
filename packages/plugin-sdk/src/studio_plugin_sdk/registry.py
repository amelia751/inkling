"""Tool registration: `register(tools)` is the plugin's entrypoint (plugin.yaml runtime.entrypoint)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

ToolFn = Callable[[Any, dict], dict]


class ToolError(Exception):
    """A tool failure the kernel reports as a job error. `recoverable`: a retry may succeed."""

    def __init__(self, message: str, *, recoverable: bool = True):
        super().__init__(message)
        self.recoverable = recoverable


class Registry:
    def __init__(self) -> None:
        self.tools: dict[str, ToolFn] = {}

    def tool(self, name: str) -> Callable[[ToolFn], ToolFn]:
        def deco(fn: ToolFn) -> ToolFn:
            if name in self.tools:
                raise ValueError(f"tool {name!r} registered twice")
            self.tools[name] = fn
            return fn

        return deco

    def register(self, name: str, fn: ToolFn) -> None:
        self.tool(name)(fn)
