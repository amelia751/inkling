"""Plugin job worker (docs/plugins.md §5.1, §10; todo2 Phase 6).

    uv run studio-worker --kernel http://127.0.0.1:8000 [--once] [--plugins <id> …]

Loop: run the built-in review checks (`deid.py`: the de-identification check for dataset
reviews) → claim a job from the kernel → make sure the plugin's locked `uv` environment exists →
run `python -m studio_plugin_sdk.runner` in it as a separate process (own session, CPU
and memory limits, a timeout, a minimal environment and an egress allowlist proxy) →
forward progress → report the result or the error to the kernel, which validates and
commits it. A plugin crash, hang or bad output fails only its own job (§14 #6).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .deid import DeidSubscriber
from .egress import EgressProxy

NAMING = json.loads((Path(__file__).resolve().parents[4] / "schemas" / "naming.json").read_text())


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(f"{NAMING['envPrefix']}{name}", default)


class Worker:
    def __init__(self, kernel: str, token: str, data_dir: Path, worker_id: str, plugins: list[str] | None = None, uv: str = "uv"):
        self.kernel = kernel.rstrip("/")
        self.http = httpx.Client(base_url=self.kernel, headers={"X-Worker-Token": token}, timeout=30)
        self.data_dir = data_dir
        self.worker_id = worker_id
        self.plugins = plugins
        self.uv = uv
        # Built-in subscriber: the de-identification check for dataset reviews (todo4 Phase 6).
        self.deid = DeidSubscriber(self.http)

    # ---- Environments --------------------------------------------------------------------

    def ensure_env(self, plugin_path: Path, plugin_id: str, version: str, digest: str) -> Path:
        """One locked environment per plugin version + artifact digest (never shared, never re-resolved)."""
        key = hashlib.sha256(f"{plugin_id}@{version}:{digest}".encode()).hexdigest()[:16]
        venv = self.data_dir / "envs" / f"{plugin_id}@{version}-{key}"
        python = venv / "bin" / "python"
        if python.exists():
            return python
        if not (plugin_path / "uv.lock").is_file():
            raise RuntimeError(f"{plugin_id} has no uv.lock; refusing to resolve dependencies at run time")
        venv.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([self.uv, "sync", "--locked", "--no-dev", "--project", str(plugin_path), "--quiet"], env={**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)}, check=True, timeout=600)
        return python

    # ---- One job -------------------------------------------------------------------------

    def run_job(self, claim: dict) -> None:
        job, plugin = claim["job"], claim["plugin"]
        job_id = job["jobId"]
        try:
            python = self.ensure_env(Path(plugin["path"]), plugin["id"], plugin["version"], job.get("artifactDigest") or plugin.get("path", ""))
        except Exception as e:  # noqa: BLE001
            return self.fail(job_id, f"environment: {e}", recoverable=True)
        allowed = set(plugin.get("egress") or []) | {urlsplit(self.kernel).hostname or "127.0.0.1"}
        timeout = int(job.get("timeoutSeconds") or 180)
        payload = {
            "entrypoint": plugin["entrypoint"],
            "tool": job["tool"],
            "input": job["input"],
            "kernelUrl": self.kernel,
            "sessionToken": claim["sessionToken"],
            "secretUseTokens": claim.get("secretUseTokens") or {},
            "provider": claim.get("provider"),
            "config": claim.get("config") or {},
            "workspaceId": job["workspaceId"],
            "jobId": job_id,
        }
        mem = plugin.get("memoryMb")
        with EgressProxy(allowed) as proxy:
            child_env = {
                "PATH": "/usr/bin:/bin",
                "HOME": str(self.data_dir / "home"),
                "HTTP_PROXY": proxy.url,
                "HTTPS_PROXY": proxy.url,
                "http_proxy": proxy.url,
                "https_proxy": proxy.url,
                "NO_PROXY": "",
                "no_proxy": "",
                "PYTHONDONTWRITEBYTECODE": "1",
            }

            def limits() -> None:
                os.setsid()
                resource.setrlimit(resource.RLIMIT_CPU, (timeout + 5, timeout + 10))
                if mem:
                    for lim in ("RLIMIT_AS", "RLIMIT_DATA"):
                        try:
                            resource.setrlimit(getattr(resource, lim), (mem * 1024 * 1024, mem * 1024 * 1024))
                        except (ValueError, OSError, AttributeError):
                            pass  # not enforceable on this OS (macOS); production uses cgroups

            proc = subprocess.Popen([str(python), "-m", "studio_plugin_sdk.runner"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env, cwd=str(self.data_dir), preexec_fn=limits, text=True)
            stderr: list[str] = []
            threading.Thread(target=lambda: stderr.extend(proc.stderr), daemon=True).start()  # type: ignore[arg-type]
            proc.stdin.write(json.dumps(payload))  # type: ignore[union-attr]
            proc.stdin.close()  # type: ignore[union-attr]
            outcome: dict | None = None
            deadline = time.monotonic() + timeout

            def reader() -> None:
                nonlocal outcome
                for line in proc.stdout:  # type: ignore[union-attr]
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "progress":
                        self.progress(job_id, msg.get("progress", 0), msg.get("message"))
                    elif msg.get("type") in ("result", "error"):
                        outcome = msg

            t = threading.Thread(target=reader, daemon=True)
            t.start()
            while proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                return self.fail(job_id, f"timed out after {timeout}s", recoverable=True)
            t.join(timeout=5)
            if proxy.denied:
                print(f"[worker] {plugin['id']}: denied egress to {sorted(set(proxy.denied))}", file=sys.stderr)
        if outcome is None:
            tail = "".join(stderr[-20:])[-1500:]
            return self.fail(job_id, f"plugin process exited with {proc.returncode} without a result{': ' + tail if tail else ''}", recoverable=True)
        if outcome["type"] == "error":
            return self.fail(job_id, outcome["error"], recoverable=bool(outcome.get("recoverable", True)))
        self.complete(job_id, outcome.get("result"), outcome.get("costUsd"))

    # ---- Kernel calls --------------------------------------------------------------------

    def progress(self, job_id: str, value: float, message: str | None) -> None:
        try:
            self.http.post(f"/api/v1/worker/jobs/{job_id}/progress", json={"workerId": self.worker_id, "progress": value, "message": message})
        except httpx.HTTPError:
            pass

    def complete(self, job_id: str, result, cost) -> None:
        self.http.post(f"/api/v1/worker/jobs/{job_id}/complete", json={"workerId": self.worker_id, "result": result, "costUsd": cost})

    def fail(self, job_id: str, error: str, recoverable: bool) -> None:
        self.http.post(f"/api/v1/worker/jobs/{job_id}/fail", json={"workerId": self.worker_id, "error": error, "recoverable": recoverable})

    def tick(self) -> bool:
        """Claim and run one job. Returns whether there was one."""
        self.http.post("/api/v1/worker/events/deliver")
        try:
            self.deid.tick()
        except httpx.HTTPError as e:
            print(f"[worker] review checks: {e}", file=sys.stderr)
        r = self.http.post("/api/v1/worker/claim", json={"workerId": self.worker_id, "plugins": self.plugins})
        r.raise_for_status()
        claim = r.json()
        if not claim.get("job"):
            return False
        self.run_job(claim)
        return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="studio-worker")
    ap.add_argument("--kernel", default=env("KERNEL_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--token", default=env("API_WORKER_TOKEN"))
    ap.add_argument("--data-dir", default=str(Path(__file__).resolve().parents[2] / ".data"))
    ap.add_argument("--worker-id", default=f"worker-{os.getpid()}")
    ap.add_argument("--plugins", nargs="*")
    ap.add_argument("--once", action="store_true", help="run at most one job, then exit")
    ap.add_argument("--poll", type=float, default=1.0)
    a = ap.parse_args(argv)
    token = a.token
    if not token:
        print(f"set {NAMING['envPrefix']}API_WORKER_TOKEN (the kernel's worker token)", file=sys.stderr)
        return 2
    data = Path(a.data_dir)
    (data / "home").mkdir(parents=True, exist_ok=True)
    w = Worker(a.kernel, token, data, a.worker_id, a.plugins)
    while True:
        try:
            had = w.tick()
        except httpx.HTTPError as e:
            print(f"[worker] kernel unreachable: {e}", file=sys.stderr)
            had = False
        if a.once:
            return 0
        if not had:
            time.sleep(a.poll)


if __name__ == "__main__":
    raise SystemExit(main())
