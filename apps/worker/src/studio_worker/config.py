"""Worker settings, from `<envPrefix>`-named env vars only (todo/done/todo3.md D.4), validated at
startup: a missing key stops the process with its name, never a value.

| Key (without prefix)     | Default                                   | Meaning |
|--------------------------|-------------------------------------------|---------|
| API_URL                  | http://127.0.0.1:8000                     | the api the worker claims jobs from |
| API_WORKER_TOKEN         | required, except against a loopback kernel | shared worker token (the api's `API_WORKER_TOKEN`); a dev kernel on this machine accepts `dev-only-worker-token` |
| WORKER_DATA_DIR          | apps/worker/.data in a checkout, else <tmp>/<resourcePrefix>-worker | scratch: plugin HOME/cwd, envs built at run time |
| WORKER_ENVS_DIR          | <data dir>/envs                           | prebuilt plugin envs (`--prepare-envs`); may be read-only |
| WORKER_BUILD_ENVS        | 1                                         | build a missing env at run time (`uv sync --locked`); images set 0 |
| WORKER_HEALTH_PORT       | 8081                                      | `/healthz`, `/readyz`, `/version` (0 = off) |
| WORKER_SHUTDOWN_GRACE_S  | 270                                       | after SIGTERM, how long the current job may keep running before it's handed back |
| WORKER_POLL_S            | 1.0                                       | idle wait between claims |
| WORKER_PLUGINS           | (all)                                     | comma-separated plugin ids this worker runs |
| WORKER_ID                | <hostname>-<pid>                          | lease owner name |
| WORKER_SIGNER            | local                                     | how `build_plugin` signs bundles (todo10 Phase 7): `local` (Ed25519 key file, dev) or `gcpkms` |
| WORKER_SIGNING_KEY_FILE  | <repo>/.data/dev-build-signing.key        | the `local` key; the api's API_BUILD_SIGNING_KEY_FILE must name the same key |
| WORKER_KMS_KEY           | (none)                                    | the `gcpkms` key version (`projects/…/cryptoKeyVersions/N`) |
| WORKER_VERIFY_PYTHON     | this interpreter                          | the pinned toolchain `verify_plugin` runs the agent's converter with |
| WORKER_VERIFY_MEMORY_MB  | 2048                                      | address-space limit of a verify run |
| REPO_ROOT                | derived                                   | where schemas/, registry/, plugins/ are (/app in images) |
| ENV                      | development                               | shared by every service: `development`, `test` or `production` |
| LOG_LEVEL / LOG_FORMAT   | INFO / json                               | shared by every service; `LOG_FORMAT=text` for humans |
| GIT_SHA                  | unknown                                   | reported by /version (also read unprefixed: the Docker build arg) |

`NAMING_FILE` (unprefixed: the prefix is read from it) points at the naming config when the
checkout's schemas/naming.json isn't there. This module is the only place the worker reads
the environment.
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
from urllib.parse import urlsplit

DEV_WORKER_TOKEN = "dev-only-worker-token"


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
    return json.loads(Path(os.environ.get("NAMING_FILE") or REPO_ROOT / "schemas" / "naming.json").read_text())


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(f"{naming()['envPrefix']}{name}")
    return v if v not in (None, "") else default


def key_name(name: str) -> str:
    return f"{naming()['envPrefix']}{name}"


def log_settings() -> tuple[str, bool]:
    """(`<P>LOG_LEVEL`, JSON logs unless `<P>LOG_FORMAT=text`): read before settings validate."""
    return env("LOG_LEVEL", "INFO") or "INFO", env("LOG_FORMAT", "json") != "text"


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
    signer: str = "local"
    signing_key_file: Path | None = None
    kms_key: str | None = None
    verify_python: str | None = None
    verify_memory_mb: int = 2048


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

    kernel_url = (overrides.pop("kernel_url", None) or env("API_URL", "http://127.0.0.1:8000") or "").rstrip("/")
    token = overrides.pop("token", None) or env("API_WORKER_TOKEN")
    if not token and urlsplit(kernel_url).hostname in ("127.0.0.1", "localhost", "::1"):
        token = DEV_WORKER_TOKEN  # the api's dev fallback (`pnpm dev`); a production api rejects it
    if require_token and not token:
        missing.append(key_name("API_WORKER_TOKEN"))
    data_dir = Path(overrides.pop("data_dir", None) or env("WORKER_DATA_DIR") or default_data_dir())
    build = env("WORKER_BUILD_ENVS", "1")
    if build not in ("0", "1", "true", "false"):
        invalid.append(key_name("WORKER_BUILD_ENVS"))
    plugins = [p.strip() for p in (env("WORKER_PLUGINS") or "").split(",") if p.strip()] or None
    s = WorkerSettings(
        kernel_url=kernel_url,
        token=token or "",
        data_dir=data_dir,
        envs_dir=Path(overrides.pop("envs_dir", None) or env("WORKER_ENVS_DIR") or data_dir / "envs"),
        build_envs=build in ("1", "true"),
        health_port=num("WORKER_HEALTH_PORT", "8081", int),
        shutdown_grace_s=num("WORKER_SHUTDOWN_GRACE_S", "270"),
        poll_s=num("WORKER_POLL_S", "1.0"),
        plugins=overrides.pop("plugins", None) or plugins,
        git_sha=env("GIT_SHA") or os.environ.get("GIT_SHA") or "unknown",
        signer=env("WORKER_SIGNER", "local") or "local",
        signing_key_file=Path(env("WORKER_SIGNING_KEY_FILE") or REPO_ROOT / ".data" / "dev-build-signing.key"),
        kms_key=env("WORKER_KMS_KEY"),
        verify_python=env("WORKER_VERIFY_PYTHON"),
        verify_memory_mb=num("WORKER_VERIFY_MEMORY_MB", "2048", int),
    )
    if s.signer not in ("local", "gcpkms"):
        invalid.append(key_name("WORKER_SIGNER"))
    if s.signer == "gcpkms" and not s.kms_key:
        missing.append(key_name("WORKER_KMS_KEY"))
    if overrides.get("worker_id"):
        s.worker_id = overrides.pop("worker_id")
    elif env("WORKER_ID"):
        s.worker_id = env("WORKER_ID") or s.worker_id
    for k, v in overrides.items():
        setattr(s, k, v)
    if missing or invalid:
        raise SettingsError(missing, invalid)
    return s
