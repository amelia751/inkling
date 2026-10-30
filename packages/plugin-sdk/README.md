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
- `ctx.annotations.write(annotations, key=...)` — commits extra canonical annotations
  through `POST /api/v1/annotations` (needs `annotations.write`). The kernel binds the
  write to this running job, shape-checks every annotation, requires its item to be an
  asset of the workspace, and stamps `author`, `provenance: ai-suggested`, `job_id` and
  the stored id itself, so a plugin can't pose as a human or overwrite annotations it
  didn't write. `key` makes a retry a no-op. A capability's *result* (e.g. `image.segment`
  masks) still goes back through the gateway, which validates it against the capability
  schema; `write` is for annotations no capability result describes.
  `ctx.annotations.list(item_id=..., label=...)` reads them (needs `annotations.read`).
- `ctx.jobs.progress(fraction, message)` — reported to the kernel by the worker.
- `ctx.secrets.use(name)` — an HTTP client whose calls go through the kernel's secrets
  broker, which injects the credential; the plugin never sees it.
- `ctx.config`, `ctx.provider` — the workspace's plugin config and the chosen provider.
- `studio_plugin_sdk.masks` — RLE encode/decode and PNG artifact helpers for `image.segment`.

`studio_plugin_sdk.naming` has the runtime names (`ns()`, `canonical_id()`, `env()`,
`plugin_schema_version()`) from `schemas/naming.json`, so plugin code never hardcodes the
product name. Inside a plugin's own `uv` environment the SDK can't see the repository, so
the worker sends the naming config with each job and the runner applies it before the
plugin is imported. Outside the worker, set `NAMING_FILE` to a `naming.json`, or
run from a checkout (it looks for `schemas/naming.json` above the working directory). With
none of these it raises instead of guessing a namespace.

The worker runs `python -m studio_plugin_sdk.runner` in the plugin's own locked `uv`
environment; the job arrives on stdin and the result leaves on stdout.
