"""Python plugin SDK (docs/plugins.md §5.1). Plugins import only this package."""

from .context import AnnotationsClient, AssetsClient, JobsClient, SecretsClient, ToolContext
from .registry import Registry, ToolError

__all__ = ["AnnotationsClient", "AssetsClient", "JobsClient", "Registry", "SecretsClient", "ToolContext", "ToolError"]
