# studio-plugin-sdk

What a Python plugin may use (docs/plugins.md §5.1, todo2 Phase 6). A plugin registers
tools; each call gets a `ToolContext` with scoped clients and nothing else: no database
handle, no kernel credentials beyond its job's session token, no direct secrets.

```python
from studio_plugin_sdk import ToolContext, Registry

def register(tools: Registry) -> None:
    @tools.tool("segment_objects")
    def segment(ctx: ToolContext, request: dict) -> dict:
        image = ctx.assets.read(request["asset_id"])
        ctx.jobs.progress(0.5, "segmenting")
        ...
        return {"instances": [...], "provider": "mock", "model": "mock-1"}
```

- `ctx.assets.read(id)` — the asset's bytes, through the kernel (needs `assets.read`).
- `ctx.jobs.progress(fraction, message)` — reported to the kernel by the worker.
- `ctx.secrets.use(name)` — an HTTP client whose calls go through the kernel's secrets
  broker, which injects the credential; the plugin never sees it.
- `ctx.config`, `ctx.provider` — the workspace's plugin config and the chosen provider.
- `studio_plugin_sdk.masks` — RLE encode/decode and PNG artifact helpers for `image.segment`.

The worker runs `python -m studio_plugin_sdk.runner` in the plugin's own locked `uv`
environment; the job arrives on stdin and the result leaves on stdout.
