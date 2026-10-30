"""Plugin process entry: `python -m studio_plugin_sdk.runner` (run by apps/worker).

stdin: one JSON job {entrypoint, tool, input, kernelUrl, sessionToken, secretUseTokens,
provider, config, workspaceId, jobId}. stdout: JSON lines — {"type": "progress", …} while
running, then exactly one {"type": "result", "result": …} or {"type": "error", "error": …,
"recoverable": bool}. Anything else a plugin prints goes to stderr, not the protocol.
"""

from __future__ import annotations

import contextlib
import importlib
import json
import sys
import traceback

import httpx

from .context import AssetsClient, JobsClient, SecretsClient, ToolContext
from .registry import Registry, ToolError


def main() -> int:
    job = json.loads(sys.stdin.read())
    out = sys.stdout
    emit = lambda msg: (out.write(json.dumps(msg) + "\n"), out.flush())  # noqa: E731
    # Plugin prints must not corrupt the protocol stream.
    sys.stdout = sys.stderr
    try:
        mod_name, fn_name = job["entrypoint"].split(":")
        registry = Registry()
        getattr(importlib.import_module(mod_name), fn_name)(registry)
        tool = registry.tools.get(job["tool"])
        if tool is None:
            raise ToolError(f"plugin has no tool {job['tool']!r}", recoverable=False)
        headers = {"Authorization": f"Bearer {job['sessionToken']}"}
        with httpx.Client(base_url=job["kernelUrl"], headers=headers, timeout=60) as http:
            ctx = ToolContext(
                workspace_id=job["workspaceId"],
                job_id=job["jobId"],
                assets=AssetsClient(http),
                jobs=JobsClient(emit),
                secrets=SecretsClient(http, job.get("secretUseTokens") or {}),
                provider=job.get("provider"),
                config=job.get("config") or {},
                http=http,
            )
            result = tool(ctx, job["input"])
        emit({"type": "result", "result": result, "costUsd": (result or {}).pop("_cost_usd", None) if isinstance(result, dict) else None})
        return 0
    except ToolError as e:
        emit({"type": "error", "error": str(e), "recoverable": e.recoverable})
    except PermissionError as e:
        emit({"type": "error", "error": f"permission denied: {e}", "recoverable": False})
    except Exception as e:  # noqa: BLE001 — a plugin crash fails its own job only
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": f"{type(e).__name__}: {e}", "recoverable": True})
    return 1


if __name__ == "__main__":
    with contextlib.suppress(BrokenPipeError):
        raise SystemExit(main())
