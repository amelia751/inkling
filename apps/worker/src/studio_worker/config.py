"""Worker settings, from `<envPrefix>`-named env vars only (todo/todo3.md D.4), validated at
startup: a missing key stops the process with its name, never a value.

| Key (without prefix)     | Default                                   | Meaning |
|--------------------------|-------------------------------------------|---------|
| KERNEL_URL               | http://127.0.0.1:8000                     | the api (kernel) the worker claims jobs from |
| API_WORKER_TOKEN         | (required)                                | shared worker token (the api's `API_WORKER_TOKEN`) |
| WORKER_DATA_DIR          | apps/worker/.data in a checkout, else <tmp>/<resourcePrefix>-worker | scratch: plugin HOME/cwd, envs built at run time |
| WORKER_ENVS_DIR          | <data dir>/envs                           | prebuilt plugin envs (`--prepare-envs`); may be read-only |
| WORKER_BUILD_ENVS        | 1                                         | build a missing env at run time (`uv sync --locked`); images set 0 |
| WORKER_HEALTH_PORT       | 8081                                      | `/healthz`, `/readyz`, `/version` (0 = off) |
| WORKER_SHUTDOWN_GRACE_S  | 270                                       | after SIGTERM, how long the current job may keep running before it's handed back |
| WORKER_POLL_S            | 1.0                                       | idle wait between claims |
| WORKER_PLUGINS           | (all)                                     | comma-separated plugin ids this worker runs |
| WORKER_ID                | <hostname>-<pid>                          | lease owner name |
| REPO_ROOT                | derived                                   | where schemas/, registry/, plugins/ are (/app in images) |
| GIT_SHA                  | unknown                                   | reported by /version (also read unprefixed) |
"""

from __future__ import annotations

import json
import os
import socket
import tempfile
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any


def _find_repo_root() -> Path:
    """Same rule as the api: `<envPrefix>REPO_ROOT` (checked against that root's naming.json),
    else walk up from this file, then the working directory, then /app."""
    for key, value in os.environ.items():
        if key.endswith("REPO_ROOT") and value:
            f = Path(value) / "schemas" / "naming.json"
            if f.is_file() and key == f"{json.loads(f.read_text())['envPrefix']}REPO_ROOT":
                return Path(value).resolve()
    for start in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        for d in (start, *start.parents):
            if (d / "schemas" / "naming.json").is_file():
                return d
    return Path("/app")


REPO_ROOT = _find_repo_root()


@cache
def naming() -> dict:
    return json.loads((REPO_ROOT / "schemas" / "naming.json").read_text())


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(f"{naming()['envPrefix']}{name}")
    return v if v not in (None, "") else default


def key_name(name: str) -> str:
    return f"{naming()['envPrefix']}{name}"


class SettingsError(RuntimeError):
    def __init__(self, missing: list[str], invalid: list[str]):
        self.missing, self.invalid = missing, invalid
        parts = (["missing " + ", ".join(missing)] if missing else []) + (["invalid " + ", ".join(invalid)] if invalid else [])
        super().__init__("configuration error: " + "; ".join(parts))


def default_data_dir() -> Path:
    if (REPO_ROOT / ".git").exists() and os.access(REPO_ROOT / "apps" / "worker", os.W_OK):
        return REPO_ROOT / "apps" / "worker" / ".data"  # a dev checkout
    return Path(tempfile.gettempdir()) / f"{naming()['resourcePrefix']}-worker"  # containers: /tmp only


@dataclass
class WorkerSettings:
    kernel_url: str
    token: str
    data_dir: Path
    envs_dir: Path
    build_envs: bool = True
    health_port: int = 8081
    shutdown_grace_s: float = 270.0
    poll_s: float = 1.0
    plugins: list[str] | None = None
    worker_id: str = field(default_factory=lambda: f"{socket.gethostname()}-{os.getpid()}")
    git_sha: str = "unknown"


def load_settings(require_token: bool = True, **overrides) -> WorkerSettings:
    overrides = {k: v for k, v in overrides.items() if v is not None}  # unset CLI flags
    missing: list[str] = []
    invalid: list[str] = []

    def num(name: str, default: str, kind: Any = float) -> Any:
        raw = env(name, default)
        try:
            return kind(raw if raw is not None else default)
        except (TypeError, ValueError):
            invalid.append(key_name(name))
            return kind(default)

    token = overrides.pop("token", None) or env("API_WORKER_TOKEN")
    if require_token and not token:
        missing.append(key_name("API_WORKER_TOKEN"))
    data_dir = Path(overrides.pop("data_dir", None) or env("WORKER_DATA_DIR") or default_data_dir())
    build = env("WORKER_BUILD_ENVS", "1")
    if build not in ("0", "1", "true", "false"):
        invalid.append(key_name("WORKER_BUILD_ENVS"))
    plugins = [p.strip() for p in (env("WORKER_PLUGINS") or "").split(",") if p.strip()] or None
    s = WorkerSettings(
        kernel_url=(overrides.pop("kernel_url", None) or env("KERNEL_URL", "http://127.0.0.1:8000") or "").rstrip("/"),
        token=token or "",
        data_dir=data_dir,
        envs_dir=Path(overrides.pop("envs_dir", None) or env("WORKER_ENVS_DIR") or data_dir / "envs"),
        build_envs=build in ("1", "true"),
        health_port=num("WORKER_HEALTH_PORT", "8081", int),
        shutdown_grace_s=num("WORKER_SHUTDOWN_GRACE_S", "270"),
        poll_s=num("WORKER_POLL_S", "1.0"),
        plugins=overrides.pop("plugins", None) or plugins,
        git_sha=env("GIT_SHA") or os.environ.get("GIT_SHA") or "unknown",
    )
    if overrides.get("worker_id"):
        s.worker_id = overrides.pop("worker_id")
    elif env("WORKER_ID"):
        s.worker_id = env("WORKER_ID") or s.worker_id
    for k, v in overrides.items():
        setattr(s, k, v)
    if missing or invalid:
        raise SettingsError(missing, invalid)
    return s
