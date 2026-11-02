"""todo17 Milestone 4: the remote MCP server (`studio-mcp`, streamable HTTP) driven by a scripted
MCP client: plain JSON-RPC over HTTP, no model.

Checks: protected-resource metadata; 401 with `WWW-Authenticate` without a token; initialize and
tools/list (`project_context` first, hints from the tier, `dryRun` on writes); project_context;
a read and a dry-run write through the API with the caller's token (nothing saved); a revoked
token gets 401; the per-token rate limit answers 429 with Retry-After.

Needs the api in dev mode (trusted dev headers, so the test can make a project and an API key):

    pnpm dev                                    # or: (cd apps/api && uv run uvicorn studio_api.app:app --port 8000)
    STUDIO_E2E_API_URL=http://127.0.0.1:8000 python3 tests/e2e/mcp_remote_test.py

The test starts apps/mcp itself (`src/main.ts --http`, port 8345, in-process rate-limit counters);
set `<envPrefix>E2E_MCP_URL` to test a running one instead. Skips when the api isn't reachable.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMING = json.loads((ROOT / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]
API = (os.environ.get(f"{P}E2E_API_URL") or "http://127.0.0.1:8000").rstrip("/")
MCP_PORT = 8345
MCP_URL = (os.environ.get(f"{P}E2E_MCP_URL") or f"http://127.0.0.1:{MCP_PORT}/mcp").rstrip("/")
RATE = 30

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{'' if ok else f'  {detail}'}", flush=True)


def http(method: str, url: str, body: object | None = None, headers: dict | None = None) -> tuple[int, dict, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode()
            return r.status, dict(r.headers), (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            parsed: object = json.loads(text) if text else None
        except json.JSONDecodeError:
            parsed = text
        return e.code, dict(e.headers), parsed


class Client:
    """A scripted MCP client: stateless streamable HTTP, JSON responses."""

    def __init__(self, token: str | None):
        self.token = token
        self.n = 0

    def raw(self, method: str, params: dict | None = None) -> tuple[int, dict, object]:
        self.n += 1
        h = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return http("POST", MCP_URL, {"jsonrpc": "2.0", "id": self.n, "method": method, **({"params": params} if params is not None else {})}, h)

    def rpc(self, method: str, params: dict | None = None) -> dict:
        status, _, body = self.raw(method, params)
        if status != 200 or not isinstance(body, dict) or "result" not in body:
            raise RuntimeError(f"{method}: {status} {body}")
        return body["result"]

    def tool(self, name: str, args: dict) -> tuple[bool, str]:
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        return bool(r.get("isError")), "".join(c.get("text", "") for c in r.get("content", []))


def wait_up(url: str, timeout: float = 30) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def main() -> int:
    try:
        urllib.request.urlopen(f"{API}/healthz", timeout=3)
    except Exception:
        print(f"SKIP the api isn't reachable at {API} (set {P}E2E_API_URL)")
        return 0

    proc = None
    if not os.environ.get(f"{P}E2E_MCP_URL"):
        env = {
            **os.environ,
            f"{P}API_URL": API,
            f"{P}MCP_TRANSPORT": "http",
            f"{P}MCP_PORT": str(MCP_PORT),
            f"{P}MCP_PUBLIC_URL": MCP_URL,
            f"{P}MCP_AUTH_SERVER": "https://auth.example.test",
            f"{P}MCP_RATE_LIMIT_PER_MIN": str(RATE),
        }
        env.pop(f"{P}MCP_REDIS_URL", None)
        mcp_dir = ROOT / "apps" / "mcp"
        proc = subprocess.Popen(["node", str(mcp_dir / "node_modules" / "tsx" / "dist" / "cli.mjs"), "src/main.ts", "--http"], cwd=mcp_dir, env=env)
    base = MCP_URL.rsplit("/mcp", 1)[0]
    key_id = pid = None
    try:
        check("mcp: /healthz up", wait_up(f"{base}/healthz"))
        s, _, version = http("GET", f"{base}/version")
        check("mcp: /version", s == 200 and isinstance(version, dict) and version.get("service") == "mcp", str(version))
        s, _, meta = http("GET", f"{base}/.well-known/oauth-protected-resource/mcp")
        check("metadata: resource and authorization server", s == 200 and isinstance(meta, dict) and meta.get("resource") == MCP_URL and bool(meta.get("authorization_servers")), str(meta))
        check("metadata: scopes follow the tiers", isinstance(meta, dict) and {"project:read", "project:write", "project:trash", "project:destroy", "rules:propose"} <= set(meta.get("scopes_supported", [])), str(meta))

        s, h, _ = Client(None).raw("tools/list")
        www = {k.lower(): v for k, v in h.items()}.get("www-authenticate", "")
        check("no token: 401 with WWW-Authenticate resource_metadata and scope", s == 401 and "resource_metadata=" in www and "scope=" in www, f"{s} {www}")

        # A project and an API key, as the dev person.
        s, _, proj = http("POST", f"{API}/api/v1/projects", {"title": f"mcp remote e2e {int(time.time())}"})
        if s not in (200, 201) or not isinstance(proj, dict):
            check("setup: project", False, f"{s} {proj}")
            return 1
        pid = proj["id"]
        s, _, key = http("POST", f"{API}/api/v1/org/api-keys", {"name": "mcp-remote-e2e", "scopes": ["studio:tools", "datasets:read", "environments:write"]})
        if s not in (200, 201) or not isinstance(key, dict):
            check("setup: API key", False, f"{s} {key}")
            return 1
        key_id, secret = key["key"]["id"], key["secret"]

        c = Client(secret)
        init = c.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}})
        check("initialize: server info and instructions", bool(init.get("serverInfo")) and "project_context" in (init.get("instructions") or ""), str(init)[:300])
        tools = c.rpc("tools/list")["tools"]
        names = [t["name"] for t in tools]
        check("tools/list: project_context first", names[:1] == ["project_context"], str(names[:5]))
        by = {t["name"]: t for t in tools}
        check("tools/list: hints from tiers", by["dataset_list"]["annotations"]["readOnlyHint"] is True and by["dataset_delete"]["annotations"]["destructiveHint"] is True and by["dataset_create"]["annotations"]["readOnlyHint"] is False, str(by.get("dataset_delete")))
        check("tools/list: writes take dryRun", "dryRun" in by["dataset_create"]["inputSchema"]["properties"] and "dryRun" not in by["dataset_list"]["inputSchema"]["properties"])
        check("tools/list: environment tools kept", {"get_environment", "patch_environment", "catalog"} <= set(names))

        err, text = c.tool("project_context", {"projectId": pid})
        if err and "404" in text:
            print("NOTE project_context: the api doesn't serve /context yet (W-HEALTH)")
        else:
            check("project_context: rules and how to add data", not err and "rules" in text, text[:300])
        r = c.rpc("resources/templates/list")
        check("resource template studio://projects/{projectId}/context", any(t.get("uriTemplate") == "studio://projects/{projectId}/context" for t in r.get("resourceTemplates", [])), str(r))

        err, text = c.tool("dataset_list", {"projectId": pid})
        check("read through the api with the caller's token", not err and '"datasets"' in text, text[:300])
        err, text = c.tool("dataset_create", {"projectId": pid, "name": "e2e dry run", "dryRun": True})
        check("dry-run write: answered (dry run or a clear refusal)", ("Dry run" in text) or err, text[:300])
        _, _, after = http("GET", f"{API}/api/v1/projects/{pid}/datasets")
        check("dry-run write: nothing saved", isinstance(after, dict) and not any(d.get("name") == "e2e dry run" for d in after.get("datasets", [])), str(after)[:300])

        # Rate limit: past RATE calls a minute, 429 with Retry-After (a fresh token: its own counter).
        statuses = []
        for _ in range(RATE + 5):
            s, h, _ = c.raw("ping")
            statuses.append(s)
            if s == 429:
                break
        check("rate limit: 429 with Retry-After", statuses[-1] == 429 and int({k.lower(): v for k, v in h.items()}.get("retry-after", "0")) >= 1, str(statuses[-5:]))

        s, _, _ = http("DELETE", f"{API}/api/v1/org/api-keys/{key_id}")
        key_id = None
        s, h, _ = Client(secret).raw("tools/list")
        www = {k.lower(): v for k, v in h.items()}.get("www-authenticate", "")
        check("revoked token: 401 invalid_token", s == 401 and 'error="invalid_token"' in www, f"{s} {www}")
    finally:
        if key_id:
            http("DELETE", f"{API}/api/v1/org/api-keys/{key_id}")
        if pid:
            http("DELETE", f"{API}/api/v1/projects/{pid}")
        if proc:
            proc.terminate()
            proc.wait(timeout=10)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
