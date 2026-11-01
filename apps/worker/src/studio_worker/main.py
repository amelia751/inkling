"""Plugin job worker (docs/plugins.md §5.1, §10; todo2 Phase 6; todo3 E.2).

    uv run studio-worker [--kernel http://127.0.0.1:8000] [--once] [--plugins <id> …]
    uv run studio-worker --prepare-envs [--plugins <id|dir> …]     # image build time

Loop: run the built-in subscribers (`deid.py`: the de-identification check for dataset
reviews; `inspect/`: inspection of uploaded files) → claim a job from the kernel → find
the plugin's locked `uv` environment (prebuilt in `WORKER_ENVS_DIR`, or built once with `uv sync --locked`) → run `python -m
studio_plugin_sdk.runner` in it as a separate process (own session, CPU and memory limits,
a timeout, a minimal environment and an egress allowlist proxy) → forward progress →
report the result or the error to the kernel, which validates and commits it. A plugin
crash, hang or bad output fails only its own job (§14 #6).

Stateless and scalable: all job state is the kernel's; the worker keeps only scratch under
`WORKER_DATA_DIR` (/tmp in containers). SIGTERM stops claiming at once, lets the current
job finish within `WORKER_SHUTDOWN_GRACE_S`, else hands it back to the queue, then exits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import resource
import signal
import subprocess
import sys
import threading
import time
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from studio_observability import bound, httpx_request_hook, setup_service, traceparent

from . import config, health
from .config import env  # noqa: F401 — kept for callers that read namespaced env vars
from .boundary import BoundaryRunner
from .deid import DeidSubscriber
from .egress import EgressProxy
from .inspect import InspectSubscriber
from .inspect.items import ItemProcessor
from .schedule import Scheduled

log = logging.getLogger("studio_worker")
NAMING = config.naming()
SERVICE = "worker"


def service_version() -> str:
    try:
        return pkg_version("studio-worker")
    except PackageNotFoundError:
        return "0.0.0"


def env_name(plugin_id: str, version: str, plugin_path: Path) -> str:
    """One environment per plugin version and lockfile: computable both at image build time
    (`--prepare-envs`) and when a job arrives, from the plugin directory alone."""
    lock = plugin_path / "uv.lock"
    lock_hash = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.is_file() else "nolock"
    key = hashlib.sha256(f"{plugin_id}@{version}:{lock_hash}".encode()).hexdigest()[:16]
    return f"{plugin_id}@{version}-{key}"


def build_env(uv: str, plugin_path: Path, venv: Path) -> None:
    if not (plugin_path / "uv.lock").is_file():
        raise RuntimeError(f"{plugin_path.name} has no uv.lock; refusing to resolve dependencies at run time")
    venv.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([uv, "sync", "--locked", "--no-dev", "--project", str(plugin_path), "--quiet"], env={**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)}, check=True, timeout=600)


class Worker:
    def __init__(self, kernel: str, token: str, data_dir: Path, worker_id: str, plugins: list[str] | None = None, uv: str = "uv", *, envs_dir: Path | None = None, build_envs: bool = True, shutdown_grace_s: float = 270.0, signer=None, verify_python: str | None = None, verify_memory_mb: int = 2048):
        self.kernel = kernel.rstrip("/")
        self.http = httpx.Client(base_url=self.kernel, headers={"X-Worker-Token": token}, timeout=30, event_hooks={"request": [httpx_request_hook]})
        self.data_dir = data_dir
        self.envs_dir = envs_dir or data_dir / "envs"
        self.build_envs = build_envs
        self.worker_id = worker_id
        self.plugins = plugins
        self.uv = uv
        self.shutdown_grace_s = shutdown_grace_s
        self.stopping = threading.Event()
        self._stop_at: float | None = None
        self.busy = False
        # Built-in subscriber: the de-identification check for dataset reviews (todo4 Phase 6).
        self.deid = DeidSubscriber(self.http)
        # Built-in subscriber: inspection of uploaded files (`source.uploaded`, todo6 Phase 5).
        self.inspect = InspectSubscriber(self.http, data_dir / "inspect")
        # Item derivatives (todo11 D8): on their own thread and client in `run_forever`, so a
        # long inspection or plugin job never holds up the thumbnails a person is waiting for.
        self.items = ItemProcessor(httpx.Client(base_url=self.kernel, headers={"X-Worker-Token": token}, timeout=30, event_hooks={"request": [httpx_request_hook]}))
        self._items_thread: threading.Thread | None = None
        # Periodic kernel work: `files.empty_trash` (todo7 Phase 4), at most daily in the kernel.
        self.scheduled = Scheduled(self.http)
        # Data-boundary jobs (todo10 Phase 7): fingerprint, fixtures, verify, probe, build.
        self.boundary = BoundaryRunner(self.http, worker_id, data_dir / "boundary", signer=signer, verify_python=verify_python, verify_memory_mb=verify_memory_mb)

    def request_stop(self) -> None:
        """SIGTERM: no new claims from now on; the current job gets the grace period."""
        if not self.stopping.is_set():
            self._stop_at = time.monotonic()
            self.stopping.set()
            log.info("stopping: finishing the current job, claiming nothing new", extra={"busy": self.busy})

    def _past_grace(self) -> bool:
        return self._stop_at is not None and time.monotonic() - self._stop_at > self.shutdown_grace_s

    # ---- Environments --------------------------------------------------------------------

    def ensure_env(self, plugin_path: Path, plugin_id: str, version: str, digest: str = "") -> Path:
        """The plugin's locked environment: prebuilt (read-only is fine), else built once here."""
        name = env_name(plugin_id, version, plugin_path)
        for root in dict.fromkeys([self.envs_dir, self.data_dir / "envs"]):
            python = root / name / "bin" / "python"
            if python.exists():
                return python
        if not self.build_envs:
            raise RuntimeError(f"no prebuilt environment {name} in {self.envs_dir} (run `studio-worker --prepare-envs` when building the image)")
        target = self.envs_dir if os.access(self.envs_dir if self.envs_dir.exists() else self.envs_dir.parent, os.W_OK) else self.data_dir / "envs"
        build_env(self.uv, plugin_path, target / name)
        return target / name / "bin" / "python"

    # ---- One job -------------------------------------------------------------------------

    def run_job(self, claim: dict) -> None:
        job = claim["job"]
        with bound(request_id=job.get("correlationId"), traceparent=job.get("traceparent"), name=f"job {job.get('tool')}", kind="consumer", attributes={"job.id": job["jobId"], "plugin.id": claim["plugin"]["id"]}):
            self.busy = True
            try:
                self._run_job(claim)
            finally:
                self.busy = False

    def _run_job(self, claim: dict) -> None:
        job, plugin = claim["job"], claim["plugin"]
        job_id = job["jobId"]
        log.info("job claimed", extra={"job_id": job_id, "plugin": plugin["id"], "tool": job["tool"], "attempt": job.get("attempts")})
        try:
            python = self.ensure_env(Path(plugin["path"]), plugin["id"], plugin["version"], plugin.get("artifactDigest") or "")
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
            "traceparent": traceparent(),
            "naming": NAMING,  # the SDK has no reliable path to schemas/ inside a plugin env
        }
        mem = plugin.get("memoryMb")
        home = self.data_dir / "home"
        home.mkdir(parents=True, exist_ok=True)
        with EgressProxy(allowed) as proxy:
            child_env = {
                "PATH": "/usr/bin:/bin",
                "HOME": str(home),
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
            while proc.poll() is None and time.monotonic() < deadline and not self._past_grace():
                time.sleep(0.05)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                if self._past_grace():
                    return self.release(job_id)
                return self.fail(job_id, f"timed out after {timeout}s", recoverable=True)
            t.join(timeout=5)
            if proxy.denied:
                log.warning("denied egress", extra={"job_id": job_id, "plugin": plugin["id"], "hosts": sorted(set(proxy.denied))})
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
        r = self.http.post(f"/api/v1/worker/jobs/{job_id}/complete", json={"workerId": self.worker_id, "result": result, "costUsd": cost})
        self._reported(r, job_id, "job done")

    def fail(self, job_id: str, error: str, recoverable: bool) -> None:
        r = self.http.post(f"/api/v1/worker/jobs/{job_id}/fail", json={"workerId": self.worker_id, "error": error, "recoverable": recoverable})
        self._reported(r, job_id, "job failed", recoverable=recoverable)

    @staticmethod
    def _reported(r: httpx.Response, job_id: str, msg: str, **extra) -> None:
        if r.is_success:
            log.info(msg, extra={"job_id": job_id, **extra})
        else:  # e.g. the lease was lost (expired and re-claimed elsewhere) or the job was cancelled
            log.warning("kernel refused the job report", extra={"job_id": job_id, "status": r.status_code})

    def release(self, job_id: str) -> None:
        """Out of grace time: give the job back so another replica runs it now."""
        try:
            self.http.post(f"/api/v1/worker/jobs/{job_id}/release", json={"workerId": self.worker_id})
            log.warning("job handed back: shutdown grace period over", extra={"job_id": job_id})
        except httpx.HTTPError:
            log.warning("couldn't hand the job back; its lease will expire", extra={"job_id": job_id})

    def tick(self) -> bool:
        """Claim and run one job. Returns whether there was one."""
        if self.stopping.is_set():
            return False
        self.http.post("/api/v1/worker/events/deliver")
        if self._items_thread is None:
            try:
                self.items.tick()
            except httpx.HTTPError as e:
                log.warning("items: %s", type(e).__name__)
        try:
            self.deid.tick()
        except httpx.HTTPError as e:
            log.warning("review checks: %s", type(e).__name__)
        try:
            self.inspect.tick()
        except httpx.HTTPError as e:
            log.warning("inspection: %s", type(e).__name__)
        try:
            self.scheduled.tick()
        except httpx.HTTPError as e:
            log.warning("scheduled jobs: %s", type(e).__name__)
        r = self.http.post("/api/v1/worker/claim", json={"workerId": self.worker_id, "plugins": self.plugins})
        r.raise_for_status()
        claim = r.json()
        if not claim.get("job"):
            return False
        if claim.get("builtin") == "boundary":
            self.busy = True
            try:
                self.boundary.run(claim)
            finally:
                self.busy = False
            return True
        self.run_job(claim)
        return True

    def run_items(self, poll_s: float = 0.2) -> None:
        """The item loop: claim, process, repeat; a short wait only when nothing is waiting."""
        while not self.stopping.is_set():
            try:
                had = self.items.tick()
            except httpx.HTTPError as e:
                log.warning("items: %s", type(e).__name__)
                had = 0
            if not had:
                self.stopping.wait(poll_s)

    def run_forever(self, poll_s: float = 1.0, once: bool = False) -> int:
        if not once and self._items_thread is None:
            self._items_thread = threading.Thread(target=self.run_items, name="items", daemon=True)
            self._items_thread.start()
        while not self.stopping.is_set():
            try:
                had = self.tick()
            except httpx.HTTPError as e:
                log.warning("kernel unreachable: %s", type(e).__name__)
                had = False
            if once:
                return 0
            if not had:
                self.stopping.wait(poll_s)
        log.info("stopped")
        return 0


# ---- Image build: prebuilt plugin environments -------------------------------------------------


def bundled_python_plugins(repo_root: Path, only: list[str] | None = None) -> list[tuple[str, str, Path]]:
    """(id, version, dir) of every registry entry under plugins/ with a Python worker."""
    index = json.loads((repo_root / "registry" / "index.json").read_text())
    out = []
    for e in index.get("plugins", []):
        path = e.get("path")
        if not path or Path(path).is_absolute() or ((e.get("manifest") or {}).get("runtime") or {}).get("kind") != "python-worker":
            continue
        d = (repo_root / path).resolve()
        if only and e["id"] not in only and d.name not in only:
            continue
        out.append((e["id"], e["version"], d))
    return out


def prepare_envs(repo_root: Path, envs_dir: Path, only: list[str] | None, uv: str = "uv") -> int:
    plugins = bundled_python_plugins(repo_root, only)
    if only and len(plugins) < len(only):
        log.error("unknown plugin(s) in --plugins", extra={"asked": only, "found": [p[0] for p in plugins]})
        return 2
    for pid, version, d in plugins:
        name = env_name(pid, version, d)
        if (envs_dir / name / "bin" / "python").exists():
            log.info("env present", extra={"plugin": pid, "env": name})
            continue
        log.info("building env", extra={"plugin": pid, "env": name})
        build_env(uv, d, envs_dir / name)
    print(json.dumps({"envsDir": str(envs_dir), "envs": [env_name(p, v, d) for p, v, d in plugins]}))
    return 0


def make_signer(s: config.WorkerSettings):
    """The platform key `build_plugin` signs with (studio_signing; KMS in production)."""
    from studio_signing import make_signer as make

    return make(s.signer, key_file=s.signing_key_file, kms_key=s.kms_key)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="studio-worker")
    ap.add_argument("--kernel", default=None, help="api URL (default: <envPrefix>API_URL)")
    ap.add_argument("--token", default=None)
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--envs-dir", default=None)
    ap.add_argument("--worker-id", default=None)
    ap.add_argument("--plugins", nargs="*")
    ap.add_argument("--once", action="store_true", help="run at most one job, then exit")
    ap.add_argument("--poll", type=float, default=None)
    ap.add_argument("--prepare-envs", action="store_true", help="build the locked envs of the bundled Python plugins into WORKER_ENVS_DIR, then exit")
    a = ap.parse_args(argv)
    level, json_logs = config.log_settings()
    setup_service(SERVICE, service_version(), level=level, json_logs=json_logs)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per poll is noise
    try:
        s = config.load_settings(require_token=not a.prepare_envs, token=a.token, kernel_url=a.kernel, data_dir=a.data_dir, envs_dir=a.envs_dir, plugins=a.plugins, worker_id=a.worker_id)
    except config.SettingsError as e:
        print(str(e), file=sys.stderr)
        return 2
    if a.prepare_envs:
        return prepare_envs(config.REPO_ROOT, s.envs_dir, a.plugins)
    (s.data_dir / "home").mkdir(parents=True, exist_ok=True)
    w = Worker(s.kernel_url, s.token, s.data_dir, s.worker_id, s.plugins, envs_dir=s.envs_dir, build_envs=s.build_envs, shutdown_grace_s=s.shutdown_grace_s, signer=make_signer(s), verify_python=s.verify_python, verify_memory_mb=s.verify_memory_mb)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: w.request_stop())
    if s.health_port:
        probe = health.KernelProbe(s.kernel_url)
        health.serve(s.health_port, version={"service": SERVICE, "version": service_version(), "gitSha": s.git_sha}, ready=lambda: (not w.stopping.is_set() and probe(), {"kernel": "ok" if probe() else "unreachable", "stopping": w.stopping.is_set()}))
    log.info("worker started", extra={"kernel": s.kernel_url, "worker_id": s.worker_id, "plugins": s.plugins, "envs_dir": str(s.envs_dir)})
    return w.run_forever(a.poll if a.poll is not None else s.poll_s, once=a.once)


if __name__ == "__main__":
    raise SystemExit(main())
