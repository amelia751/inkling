"""Kernel settings, from namespaced env vars (<envPrefix>API_*) and secrets/api.env."""

from __future__ import annotations

import secrets as pysecrets
from dataclasses import dataclass, field
from pathlib import Path

from .naming import REPO_ROOT, env


def _read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    return out


@dataclass
class Settings:
    database_url: str
    seed_root: Path
    data_dir: Path
    registry_dir: Path
    plugins_dir: Path
    secret_key: str
    # Dev: requests without a session token act as `dev_principal`, and the workspace comes
    # from the X-Workspace-Id header. Production sets this off and requires tokens.
    dev_trust_headers: bool = True
    dev_principal: str = "user:local-expert"
    # Phase 4 exit path: a kernel-internal mock `image.segment` provider usable without
    # installing a plugin. Off unless asked for (it bypasses installation, never policy).
    builtin_mock_segment: bool = False
    signed_url_ttl_s: int = 600
    event_rate_per_minute: int = 600
    event_max_depth: int = 4
    job_lease_s: int = 60
    extra: dict[str, str] = field(default_factory=dict)


def load_settings(**overrides) -> Settings:
    file_env = _read_env_file(REPO_ROOT / "secrets" / "api.env")
    data_dir = Path(env("API_DATA_DIR") or REPO_ROOT / "apps" / "api" / ".data")
    key = env("API_SECRET_KEY") or file_env.get("API_SECRET_KEY") or file_env.get("SECRET_KEY")
    if not key:
        # Dev fallback: a stable per-checkout key so signed URLs survive restarts.
        data_dir.mkdir(parents=True, exist_ok=True)
        key_file = data_dir / "dev-secret.key"
        if not key_file.exists():
            key_file.write_text(pysecrets.token_urlsafe(48))
        key = key_file.read_text().strip()
    s = Settings(
        database_url=env("API_DATABASE_URL") or f"sqlite:///{data_dir / 'api.db'}",
        seed_root=Path(env("API_SEED_ROOT") or REPO_ROOT / "seed-data"),
        data_dir=data_dir,
        registry_dir=REPO_ROOT / "registry",
        plugins_dir=REPO_ROOT / "plugins",
        secret_key=key,
        dev_trust_headers=(env("API_DEV_TRUST_HEADERS", "1") == "1"),
        builtin_mock_segment=(env("API_BUILTIN_MOCK_SEGMENT", "0") == "1"),
    )
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings


def set_settings(s: Settings) -> None:
    global _settings
    _settings = s
