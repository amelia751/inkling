"""todo10 Phase 7 exit test: build outside, verify inside, with a canary.

Starts the real API, the real worker and the real agent service (scripted model, the `fake`
sandbox provider that records every file and command), on a project whose two "real" samples
carry a canary string in their header and their pixels: a DICOM file and an unknown binary
format (INKB). The scripted builder then does what a model would: fingerprints both samples,
creates a build sandbox, pulls synthetic fixtures into it, probes the unknown layout, writes a
converter, checks it, verifies it on the real sample and has our worker build it.

Asserts:
- the canary never appears in the sandbox's file system or command log, in the agent's model
  context (session transcripts, everything under its data dir) or in its logs;
- the INKB file is converted end to end from fixtures, probes and verify reports only;
- the registered (and installed) bundle's digest is our worker's build, not the sandbox's;
- the provider is a config value (AGENT_SANDBOX=fake here; daytona/local/gke otherwise).

Synthetic data only. Ports 8230-8239. Run from the repo root:

    uv run python tests/e2e/boundary_canary_test.py
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "worker" / "tests"))
from canary import CANARY, INKB_CONVERTER, write_canary_samples  # noqa: E402

NAMING = json.loads((ROOT / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]
API_PORT, AGENT_PORT = 8230, 8231
API = f"http://127.0.0.1:{API_PORT}"
AGENT = f"http://127.0.0.1:{AGENT_PORT}"
AGENT_TOKEN = "e2e-boundary-agent-token-0123456789"
WORKER_TOKEN = "e2e-boundary-worker-token"
PLUGIN_DIR = "/home/daytona/plugin"
WS = "bnd"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail and not ok else ''}", flush=True)


def http(method: str, url: str, body=None, headers=None, raw: bool = False):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = r.read()
            return r.status, (out if raw else json.loads(out or b"null"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def wait_http(url: str, timeout: float = 90) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:  # noqa: BLE001
            time.sleep(0.3)
    raise SystemExit(f"{url} didn't come up")


def free(port: int) -> None:
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(f"port {port} is in use")


def script() -> dict:
    inkb, dcm = f"{WS}/scan.inkb", f"{WS}/scan.dcm"
    probes = [
        {"op": "magic", "offset": 0, "hex": "494e4b42"},
        {"op": "read_int", "offset": 6, "width": 2, "signed": False, "endian": "little"},
        {"op": "read_int", "offset": 8, "width": 4, "signed": False, "endian": "little"},
        {"op": "read_int", "offset": 12, "width": 4, "signed": False, "endian": "little"},
        {"op": "read_text", "offset": 17, "length": 24},
        {"op": "field_names"},
    ]
    turns = [
        {"text": "Looking at the samples' structure.", "toolCalls": [{"name": "get_fingerprint", "arguments": {"sample": inkb}}]},
        {"toolCalls": [{"name": "get_fingerprint", "arguments": {"sample": dcm}}]},
        {"toolCalls": [{"name": "create_plugin_sandbox", "arguments": {"slug": "inkb", "name": "INKB converter"}}]},
        {"toolCalls": [{"name": "get_fixtures", "arguments": {"sample": inkb, "count": 3}}]},
        {"toolCalls": [{"name": "get_fixtures", "arguments": {"sample": dcm, "count": 2}}]},
        {"toolCalls": [{"name": "probe_sample", "arguments": {"sample": inkb, "probes": probes}}]},
        {"toolCalls": [{"name": "write", "arguments": {"path": f"{PLUGIN_DIR}/inkb_convert.py", "content": INKB_CONVERTER}}]},
        # Something the sandbox "built": must never become the shipped bundle.
        {"toolCalls": [{"name": "write", "arguments": {"path": f"{PLUGIN_DIR}/dist/inkb_convert-0.1.0-py3-none-any.whl", "content": "PK sandbox-built wheel"}}]},
        {"toolCalls": [{"name": "run_plugin_checks", "arguments": {}}]},
        {"toolCalls": [{"name": "verify_on_sample", "arguments": {"sample": inkb, "entrypoint": "inkb_convert:convert"}}]},
        {"toolCalls": [{"name": "build_plugin_artifact", "arguments": {}}]},
        {"text": "Built and verified the INKB converter (rung 2): it reads the header and returns a float32 image."},
    ]
    return {"scripts": [{"when": "INKB", "turns": turns}]}


def main() -> int:
    for p in (API_PORT, AGENT_PORT):
        free(p)
    tmp = Path(tempfile.mkdtemp(prefix="boundary-e2e-"))
    seed = tmp / "seed"
    names = write_canary_samples(seed / WS)
    # Control: the canary really is in the samples' bytes (header and pixels), so the checks below can see it.
    check("control: the canary is planted in both samples", all(CANARY.encode() in (seed / WS / n).read_bytes() for n in names))
    (seed / "manifest.json").write_text(json.dumps({"projects": [{"id": WS, "title": "Boundary", "assets": [{"path": f"{WS}/{n}"} for n in names]}]}))
    key = tmp / "platform-signing.key"
    fake_dir, agent_dir = tmp / "sandboxes", tmp / "agent"
    (tmp / "script.json").write_text(json.dumps(script()))
    base_env = {k: v for k, v in os.environ.items() if not k.startswith(P)}
    procs: list[subprocess.Popen] = []
    logs = {n: open(tmp / f"{n}.log", "wb") for n in ("api", "worker", "agent")}  # noqa: SIM115
    try:
        api_env = {**base_env, f"{P}ENV": "test", f"{P}API_DATABASE_URL": f"sqlite:///{tmp / 'api.db'}", f"{P}API_SEED_ROOT": str(seed), f"{P}API_DATA_DIR": str(tmp / "api-data"),
                   f"{P}API_SECRET_KEY": "e2e-boundary-secret-key-0123456789", f"{P}API_WORKER_TOKEN": WORKER_TOKEN, f"{P}API_SIGNER_KEY_FILE": str(key), f"{P}LOG_FORMAT": "text"}
        procs.append(subprocess.Popen(["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--port", str(API_PORT)], cwd=ROOT / "apps" / "api", env=api_env, stdout=logs["api"], stderr=subprocess.STDOUT))
        wait_http(f"{API}/api/v1/health")
        worker_env = {**base_env, f"{P}ENV": "test", f"{P}API_URL": API, f"{P}API_WORKER_TOKEN": WORKER_TOKEN, f"{P}WORKER_DATA_DIR": str(tmp / "worker"), f"{P}WORKER_HEALTH_PORT": "0",
                      f"{P}WORKER_SIGNING_KEY_FILE": str(key), f"{P}WORKER_POLL_S": "0.2", f"{P}LOG_FORMAT": "text"}
        procs.append(subprocess.Popen(["uv", "run", "--package", "studio-worker", "studio-worker"], cwd=ROOT, env=worker_env, stdout=logs["worker"], stderr=subprocess.STDOUT))
        agent_env = {**base_env, f"{P}ENV": "test", f"{P}AGENT_MODEL": "scripted", f"{P}AGENT_SCRIPT": str(tmp / "script.json"), f"{P}AGENT_SANDBOX": "fake", f"{P}AGENT_SANDBOX_FAKE_DIR": str(fake_dir),
                     f"{P}AGENT_DATA_DIR": str(agent_dir), f"{P}AGENT_TOKEN": AGENT_TOKEN, f"{P}AGENT_PORT": str(AGENT_PORT), f"{P}API_URL": API, f"{P}AGENT_EGRESS_PROBE": "off", f"{P}AGENT_SWEEPER_ENABLED": "false"}
        procs.append(subprocess.Popen(["pnpm", "exec", "tsx", "src/main.ts"], cwd=ROOT / "apps" / "agent", env=agent_env, stdout=logs["agent"], stderr=subprocess.STDOUT))
        wait_http(f"{AGENT}/health/live")

        # The Studio's part: mint the builder's kernel token as the user (apps/web kernel-token.ts).
        scopes = ["plugins.read", "plugins.manage", "plugins.author", "proposals.write", "samples.inspect", "samples.verify"]
        st, tok = http("POST", f"{API}/api/v1/sessions", {"agent": "builder", "profile": "builder", "scopes": scopes}, {"X-Workspace-Id": WS})
        check("builder token minted", st == 200, str(tok))
        kt = tok["token"]
        ah = {"Authorization": f"Bearer {AGENT_TOKEN}"}
        st, ses = http("POST", f"{AGENT}/v1/sessions", {"projectId": WS, "profile": "builder", "kernelToken": kt}, ah)
        check("builder session", st in (200, 201), str(ses))
        st, run = http("POST", f"{AGENT}/v1/sessions/{ses['sessionId']}/messages", {"text": "Build a plugin that opens our INKB files", "kernelToken": kt}, ah)
        check("message accepted", st in (200, 202), str(run))
        events = drive(run["runId"], ah)
        tools = [e for e in events if e.get("type") in ("tool_end", "tool.end", "tool_result") or e.get("type", "").startswith("tool")]
        done = [e for e in events if e.get("type") == "done"]
        check("run finished", bool(done) and done[-1].get("status") in ("completed", None), json.dumps(done[-1] if done else events[-3:])[:600])
        failed_tools = [e for e in tools if e.get("isError") or e.get("ok") is False]
        check("every scripted tool call succeeded", not failed_tools, json.dumps(failed_tools)[:1500])

        # ---- the canary never crossed the boundary ----
        sandboxes = list(fake_dir.glob("*")) if fake_dir.exists() else []
        check("a fake build sandbox was used", bool(sandboxes))
        sandbox_files = [p for p in fake_dir.rglob("*") if p.is_file()] if fake_dir.exists() else []
        hit = [str(p.relative_to(fake_dir)) for p in sandbox_files if CANARY.encode() in p.read_bytes()]
        check("canary absent from the sandbox file system and command log", not hit, str(hit))
        fixtures = [p for p in sandbox_files if "/fixtures/" in str(p)]
        check("synthetic fixtures reached the sandbox", len(fixtures) >= 5, str([p.name for p in fixtures]))
        log = "\n".join((s / "log.jsonl").read_text() for s in sandboxes if (s / "log.jsonl").exists())
        check("sandbox created with no network and no env from us", '"blockAll": true' in log.replace('"blockAll":true', '"blockAll": true') and "TOKEN" not in log, log[:300])
        model_ctx = [p for p in agent_dir.rglob("*") if p.is_file() and CANARY.encode() in p.read_bytes()]
        check("canary absent from the model's context (transcripts, session store)", not model_ctx, str(model_ctx))
        logs["agent"].flush()
        check("canary absent from the agent's logs", CANARY not in (tmp / "agent.log").read_text(errors="replace"))
        check("canary absent from every SSE event the Studio saw", CANARY not in json.dumps(events))

        # ---- converted end to end, and the installed bundle is ours ----
        transcript = "\n".join(p.read_text(errors="replace") for p in agent_dir.rglob("*.jsonl"))
        check("verify passed on the real sample with the INKB shape", '\\"pass\\":true' in transcript or '"pass":true' in transcript, "")
        st, plugins = http("GET", f"{API}/api/v1/plugins?q=inkb", headers={"X-Workspace-Id": WS})
        entry = next((p for p in (plugins.get("plugins") if isinstance(plugins, dict) else []) or [] if str(p.get("id", "")).endswith("generated.inkb")), None)
        check("the plugin is registered", entry is not None, str(plugins)[:400])
        st, audit = http("GET", f"{API}/api/v1/audit?action=boundary.build", headers={"X-Workspace-Id": WS})
        b = (audit.get("entries") or [{}])[0].get("after") or {} if isinstance(audit, dict) else {}
        ours = b.get("artifactDigest")
        check("our build's digest differs from the sandbox's package", b.get("matchesSandbox") is False and bool(ours), json.dumps(b))
        if entry is not None and ours:
            pid = entry["id"]
            st, plan = http("POST", f"{API}/api/v1/workspaces/{WS}/plugins/plan", {"pluginId": pid}, {"X-Workspace-Id": WS})
            st, staged = http("POST", f"{API}/api/v1/workspaces/{WS}/plugins/stage", {"requestId": plan["requestId"]}, {"X-Workspace-Id": WS})
            st, appr = http("POST", f"{API}/api/v1/workspaces/{WS}/plugins/approve", {"requestId": plan["requestId"]}, {"X-Workspace-Id": WS})
            st, state = http("GET", f"{API}/api/v1/workspaces/{WS}/state", headers={"X-Workspace-Id": WS})
            inst = next((p for p in state.get("plugins", []) if p.get("pluginId") == pid), {}) if isinstance(state, dict) else {}
            check("the installed bundle's digest is our build's", inst.get("artifactDigest") == ours, json.dumps({"staged": staged, "approved": appr, "installed": inst})[:800])
        # ---- the agent token can't reach bytes ----
        st, assets = http("GET", f"{API}/api/v1/assets", headers={"Authorization": f"Bearer {kt}", "X-Workspace-Id": WS})
        aid = (assets.get("assets") or [{}])[0].get("id") if isinstance(assets, dict) else None
        st, _ = http("GET", f"{API}/api/v1/assets/{aid}/content", headers={"Authorization": f"Bearer {kt}", "X-Workspace-Id": WS}, raw=True)
        check("an agent token gets 403 on sample bytes", st == 403, str(st))
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        for f in logs.values():
            f.close()
        failed = [r for r in results if not r[1]]
        if failed:
            print(f"logs kept in {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


def drive(run_id: str, headers: dict, timeout: float = 240) -> list[dict]:
    """Read the run's SSE stream; approve any approval; stop at `done`."""
    req = urllib.request.Request(f"{AGENT}/v1/runs/{run_id}/events?after=0", headers=headers)
    events: list[dict] = []
    deadline = time.time() + timeout
    with urllib.request.urlopen(req, timeout=timeout) as r:
        buf = ""
        while time.time() < deadline:
            line = r.readline().decode()
            if not line:
                break
            if line.startswith("data:"):
                buf += line[5:].strip()
            elif line.strip() == "" and buf:
                e = json.loads(buf)
                buf = ""
                events.append(e)
                if e.get("type") == "approval":
                    http("POST", f"{AGENT}/v1/approvals/{e['approvalId']}", {"decision": "approve"}, headers)
                if e.get("type") == "done":
                    break
    return events


if __name__ == "__main__":
    raise SystemExit(main())
