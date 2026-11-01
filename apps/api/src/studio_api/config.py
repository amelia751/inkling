"""Kernel settings, validated at startup (todo/done/todo3.md D.4, E.4).

Every key is read from the environment as `<envPrefix><NAME>` (the prefix comes from
schemas/naming.json; `naming.env`). `secrets/api.env` is an optional dev overlay (keys with
or without the prefix) and never overrides the real environment; production
(`ENV=production`) ignores it. A bad configuration fails fast with the key *names*
that are missing or invalid, never their values.

| Key (without prefix)      | Default                          | Meaning |
|---------------------------|----------------------------------|---------|
| ENV                       | development                      | shared by every service (`development`, `test`, `production`); `production` requires the secrets below and skips dev fallbacks |
| LOG_LEVEL / LOG_FORMAT    | INFO / json                      | shared by every service; `LOG_FORMAT=text` for humans |
| API_DATABASE_URL          | sqlite:///<data dir>/api.db      | SQLAlchemy URL; `postgresql+psycopg://…` in production |
| API_CREATE_TABLES         | 1 (dev) / 0 (production)         | create tables at startup; production runs the Alembic migrate Job |
| API_SECRET_KEY            | dev: generated per checkout      | signs URLs, encrypts secrets; required in production |
| API_WORKER_TOKEN          | dev: derived from the secret key | shared token workers authenticate with; required in production |
| API_PIPELINE_URL          | (none)                           | apps/pipeline's private API (`http://pipeline:8095`); unset = the pipeline routes answer 503 |
| API_PIPELINE_JWT_KID      | api                              | `kid` of the JWT the api signs pipeline calls with (the versioning signing key, audience `pipeline`); must be in the pipeline's JWKS |
| API_PIPELINE_TOKEN        | dev: `dev-only-pipeline-token`; production: unset = off | the token the pipeline service presents (`Authorization: Bearer`), principal `service:pipeline` (todo12 §4 M0 item 5) |
| API_DATA_DIR              | apps/api/.data                   | dev-only local data (SQLite file, local derived blobs) |
| API_SEED_ROOT             | <repo>/seed-data                 | the local BlobStore root for seed assets |
| API_DEV_TRUST_HEADERS     | 1                                | requests without a token act as the dev principal |
| API_BUILTIN_MOCK_SEGMENT  | 0                                | kernel-internal mock image.segment provider |
| API_HOUSEKEEPING_INTERVAL_S | 10                             | background event delivery + lease reaping when Redis backs the queue/bus (0 = off) |
| API_VERSIONING_URL        | (none)                           | apps/versioning base URL; unset = versioning routes answer 503 |
| API_VERSIONING_TENANT     | default                          | tenant sent to the versioning service |
| API_VERSIONING_JWT_KEY_FILE / API_VERSIONING_JWKS_FILE | dev: generated | Ed25519 signing key / its public JWKS |
| API_VERSIONING_JWT_AUDIENCE / _ISSUER | versioning / api     | JWT claims for versioning calls |
| API_VERSIONING_JWT_KID    | api-dev                          | key id in the JWT header; must be in the service's JWKS |
| REDIS_URL                 | (none)                           | needed when JOB_QUEUE or EVENT_BUS is redis |
| BLOB_STORE                | local                            | `local` (files), `s3` or `gcs` |
| S3_ENDPOINT               | (AWS)                            | S3-compatible endpoint, e.g. MinIO |
| S3_BUCKET                 | assets                           | bucket holding seed assets (keys = seed-data paths) and derived data |
| S3_REGION                 | us-east-1                        | |
| S3_PREFIX                 | (none)                           | optional key prefix inside the bucket |
| GCS_BUCKET                | (none; required for gcs)         | Cloud Storage bucket, same layout as S3_BUCKET |
| GCS_PREFIX                | (none)                           | optional key prefix inside the bucket |
| GCS_PROJECT               | (from credentials)               | project billed for the requests |
| JOB_QUEUE                 | sql                              | `sql` (DB lease queue) or `redis` (ready list + leases) |
| EVENT_BUS                 | sql                              | `sql` (outbox scan) or `redis` (Streams) |
| REPO_ROOT                 | derived                          | where schemas/, registry/, plugins/ are (/app in images) |
| GIT_SHA                   | unknown                          | reported by /version (also read unprefixed: the Docker build arg) |
| API_UPLOAD_MAX_FILE_BYTES | 2147483648 (2 GB)                | largest file an import session accepts |
| API_UPLOAD_MAX_SESSION_FILES | 20000                         | most files in one import session |
| API_DROP_MAX_FILES        | 10000                            | files per drop; above it the card points to Files' folder upload |
| API_DROP_MAX_BYTES        | 53687091200 (50 GB)              | bytes per drop |
| API_DROP_RATE_PER_MINUTE  | 20                               | drops a person may start per minute (429 with Retry-After above it) |
| API_NAME_SCREEN_MODE      | dlp (production), regex (development, test) | how file and folder names are screened before an agent sees them: `dlp` (Sensitive Data Protection), `regex`, `off` (tests only; refused in production) |
| API_NAME_SCREEN_BATCH     | 500                              | names per screening call |
| API_NAME_SCREEN_QPS       | 5                                | screening calls per second per pod (backfill and live share it) |
| API_NAME_SCREEN_PROJECT   | (GCS_PROJECT, else the credentials' project) | the Google Cloud project billed for Sensitive Data Protection calls |
| API_NAME_SCREEN_LOCATION  | us-central1                      | Sensitive Data Protection location |
| API_SIGNER                | local                            | who signs generated plugin artifacts (todo10 Phase 3): `local` (Ed25519 key file) or `gcpkms` |
| API_SIGNER_KEY_FILE       | dev: <data dir>/plugin-signing.key | the local signer's Ed25519 PEM; production with `local` refuses to sign without it |
| API_SIGNER_KMS_KEY        | (none)                           | `gcpkms`: a key version, `projects/…/cryptoKeys/…/cryptoKeyVersions/N` (EC_SIGN_P256_SHA256) |
| API_SIGNER_TRUSTED_KEYS_FILE | (none)                        | JSON `{keyId: PEM}` of other installations' public keys accepted on artifact import |
| API_ARTIFACTS_BUCKET      | (none: the data area)            | `s3`/`gcs`: separate bucket for content-addressed plugin artifacts (`artifacts/sha256/*`, retention-locked) |
| API_BOUNDARY_PROBE_BUDGET | 64                               | typed probes per sample and workspace (todo10 §6.1 step 5); audited |
| API_TEXT_CHECK            | dev                              | free-text check for probe answers, names and annotation text (`dev`: vocabulary allowlist; Sensitive Data Protection later) |
| API_DROP_UNDO_SECONDS     | 30                               | todo13 D6: how long an applied drop plan can be undone |

Feature flags (todo13 §7.1), served at `GET /api/v1/features` and read once by the web app. Each
gates its UI and its routes (a disabled route answers 404; `kernel/features.py`). Default: off
in production, on in development and test (todo13 §7.4: dev runs with every flag on).

| Key (without prefix)      | Default (prod / dev)             | Meaning |
|---------------------------|----------------------------------|---------|
| API_FEATURE_CHAT_DROPS    | false / true                     | composer drop, paste and attach; the Shared files view |
| API_FEATURE_AUTO_APPLY    | false / true                     | drop plans that only touch the person's drafts apply on their own (off: every plan asks) |
| API_FEATURE_FAST_PATH     | false / true                     | boot a Studio from a drop before the agent answers |
| API_FEATURE_DATASETS_TAB  | false / true                     | Datasets in the project sidebar |

S3 credentials are the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (unprefixed;
or the default AWS credential chain). Cloud Storage uses Application Default Credentials only
(Workload Identity on GKE; `gcloud auth application-default login` locally), never a key file. `NAMING_FILE` (unprefixed: the prefix is read from it) is
handled in naming.py. Everything else reads settings through this module (`env()`).
"""

from __future__ import annotations

import os
import secrets as pysecrets
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .naming import REPO_ROOT, naming


class SettingsError(RuntimeError):
    """Configuration is missing or invalid. The message names keys, never values."""

    def __init__(self, missing: list[str], invalid: list[str]):
        self.missing, self.invalid = missing, invalid
        parts = []
        if missing:
            parts.append("missing " + ", ".join(missing))
        if invalid:
            parts.append("invalid " + ", ".join(invalid))
        super().__init__("configuration error: " + "; ".join(parts))


def _read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    return out


class Settings(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

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
    # Dataset versioning (todo4 Phase 6): apps/versioning's internal URL. Unset means the
    # service isn't configured: the versioning routes answer 503 and the Studio keeps its
    # plain save path. The API mints a 60 s Ed25519 JWT per call (todo4 V4) with the key in
    # `versioning_key_file`; the service reads the public half from `versioning_jwks_file`
    # (its <envPrefix>VERSIONING_JWT_PUBLIC_KEY_FILE). Both are generated in dev if absent.
    versioning_url: str | None = None
    versioning_tenant: str = "default"
    versioning_key_file: Path | None = None
    versioning_jwks_file: Path | None = None
    versioning_audience: str = "versioning"
    versioning_issuer: str = "api"
    # The JWT `kid`; must name the key in the service's JWKS (`devtoken keygen` writes "dev").
    versioning_kid: str = "api-dev"
    extra: dict[str, str] = Field(default_factory=dict)

    # Stateless deployment (todo/done/todo3.md E.2): where state, blobs, jobs and events live.
    env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    log_format: Literal["json", "text"] = "json"
    create_tables: bool = True
    repo_root: Path = REPO_ROOT
    worker_token: str | None = None
    pipeline_token: str | None = None
    pipeline_url: str | None = None
    pipeline_jwt_kid: str = "api"
    redis_url: str | None = None
    blob_store: Literal["local", "s3", "gcs"] = "local"
    s3_endpoint: str | None = None
    s3_bucket: str = "assets"
    s3_region: str = "us-east-1"
    s3_prefix: str = ""
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    gcs_bucket: str | None = None
    gcs_prefix: str = ""
    gcs_project: str | None = None
    job_queue: Literal["sql", "redis"] = "sql"
    event_bus: Literal["sql", "redis"] = "sql"
    housekeeping_interval_s: float = 10.0
    git_sha: str = "unknown"
    # Uploads (todo6 Phase 4): per-file and per-session limits for import sessions.
    upload_max_file_bytes: int = 2 * 1024**3
    upload_max_session_files: int = 20_000
    # ---- Chat drops (todo13-drops, §7.1) ----
    drop_max_files: int = 10_000
    drop_max_bytes: int = 50 * 1024**3
    drop_rate_per_minute: int = 20
    # None: `dlp` in production, `regex` elsewhere. `off` is for tests only.
    name_screen_mode: Literal["dlp", "regex", "off"] | None = None
    name_screen_batch: int = 500
    name_screen_qps: float = 5.0
    name_screen_project: str | None = None
    name_screen_location: str = "us-central1"

    @property
    def screen_mode(self) -> str:
        return self.name_screen_mode or ("dlp" if self.env == "production" else "regex")
    # Plugin artifact signing (todo10 Phase 3, packages/signing).
    signer: Literal["local", "gcpkms"] = "local"
    signer_key_file: Path | None = None
    signer_kms_key: str | None = None
    signer_trusted_keys_file: Path | None = None
    artifacts_bucket: str | None = None
    # The data boundary (todo10 Phase 7): probe budget and free-text check. Worker-built
    # bundles are verified with `signer` above (the worker signs with the same key).
    boundary_probe_budget: int = 64
    text_check: Literal["dev"] = "dev"
    # todo13 D6 (§7.1): how long an applied drop plan can be undone. The `API_FEATURE_*` flags
    # are todo13-entry's (`kernel/features.py`); drop plans read them through `drop_flags`.
    drop_undo_seconds: int = 30

    # ---- Feature flags (todo13 §7.1): None = the default for `env` (off in production). ----
    feature_chat_drops: bool | None = None
    feature_auto_apply: bool | None = None
    feature_fast_path: bool | None = None
    feature_datasets_tab: bool | None = None

    def feature(self, name: str) -> bool:
        """A todo13 flag by short name (`chat_drops`, `auto_apply`, `fast_path`, `datasets_tab`)."""
        v = getattr(self, f"feature_{name}")
        return (not self.production) if v is None else bool(v)

    @property
    def production(self) -> bool:
        return self.env == "production"

    @property
    def needs_redis(self) -> bool:
        return self.job_queue == "redis" or self.event_bus == "redis"


# Settings field → key name (without the prefix). Booleans accept 1/0/true/false.
_KEYS: dict[str, str] = {
    "env": "ENV",
    "log_level": "LOG_LEVEL",
    "log_format": "LOG_FORMAT",
    "database_url": "API_DATABASE_URL",
    "create_tables": "API_CREATE_TABLES",
    "secret_key": "API_SECRET_KEY",
    "worker_token": "API_WORKER_TOKEN",
    "pipeline_token": "API_PIPELINE_TOKEN",
    "pipeline_url": "API_PIPELINE_URL",
    "pipeline_jwt_kid": "API_PIPELINE_JWT_KID",
    "data_dir": "API_DATA_DIR",
    "seed_root": "API_SEED_ROOT",
    "dev_trust_headers": "API_DEV_TRUST_HEADERS",
    "builtin_mock_segment": "API_BUILTIN_MOCK_SEGMENT",
    "housekeeping_interval_s": "API_HOUSEKEEPING_INTERVAL_S",
    "versioning_url": "API_VERSIONING_URL",
    "versioning_tenant": "API_VERSIONING_TENANT",
    "versioning_key_file": "API_VERSIONING_JWT_KEY_FILE",
    "versioning_jwks_file": "API_VERSIONING_JWKS_FILE",
    "versioning_audience": "API_VERSIONING_JWT_AUDIENCE",
    "versioning_issuer": "API_VERSIONING_JWT_ISSUER",
    "versioning_kid": "API_VERSIONING_JWT_KID",
    "redis_url": "REDIS_URL",
    "blob_store": "BLOB_STORE",
    "s3_endpoint": "S3_ENDPOINT",
    "s3_bucket": "S3_BUCKET",
    "s3_region": "S3_REGION",
    "s3_prefix": "S3_PREFIX",
    "gcs_bucket": "GCS_BUCKET",
    "gcs_prefix": "GCS_PREFIX",
    "gcs_project": "GCS_PROJECT",
    "job_queue": "JOB_QUEUE",
    "event_bus": "EVENT_BUS",
    "git_sha": "GIT_SHA",
    "upload_max_file_bytes": "API_UPLOAD_MAX_FILE_BYTES",
    "upload_max_session_files": "API_UPLOAD_MAX_SESSION_FILES",
    # Chat drops (todo13-drops)
    "drop_max_files": "API_DROP_MAX_FILES",
    "drop_max_bytes": "API_DROP_MAX_BYTES",
    "drop_rate_per_minute": "API_DROP_RATE_PER_MINUTE",
    "name_screen_mode": "API_NAME_SCREEN_MODE",
    "name_screen_batch": "API_NAME_SCREEN_BATCH",
    "name_screen_qps": "API_NAME_SCREEN_QPS",
    "name_screen_project": "API_NAME_SCREEN_PROJECT",
    "name_screen_location": "API_NAME_SCREEN_LOCATION",
    "signer": "API_SIGNER",
    "signer_key_file": "API_SIGNER_KEY_FILE",
    "signer_kms_key": "API_SIGNER_KMS_KEY",
    "signer_trusted_keys_file": "API_SIGNER_TRUSTED_KEYS_FILE",
    "artifacts_bucket": "API_ARTIFACTS_BUCKET",
    "boundary_probe_budget": "API_BOUNDARY_PROBE_BUDGET",
    "text_check": "API_TEXT_CHECK",
    # Feature flags (todo13 §7.1).
    "feature_chat_drops": "API_FEATURE_CHAT_DROPS",
    "feature_auto_apply": "API_FEATURE_AUTO_APPLY",
    "feature_fast_path": "API_FEATURE_FAST_PATH",
    "feature_datasets_tab": "API_FEATURE_DATASETS_TAB",
    "drop_undo_seconds": "API_DROP_UNDO_SECONDS",
}
_UNPREFIXED = {"git_sha": "GIT_SHA", "s3_access_key_id": "AWS_ACCESS_KEY_ID", "s3_secret_access_key": "AWS_SECRET_ACCESS_KEY"}


def env(name: str, default: str | None = None) -> str | None:
    """A namespaced env var outside `Settings`: env("API_WORKER_TOKEN") reads <envPrefix>API_WORKER_TOKEN."""
    return os.environ.get(f"{naming()['envPrefix']}{name}", default)


def key_name(field: str) -> str:
    return f"{naming()['envPrefix']}{_KEYS[field]}" if field in _KEYS else _UNPREFIXED.get(field, field)


def _lookup() -> tuple[dict[str, str], bool]:
    """Raw string values by field name, from the environment then (dev) secrets/api.env."""
    prefix = naming()["envPrefix"]
    production = os.environ.get(f"{prefix}ENV", "development") == "production"
    file_env = {} if production else _read_env_file(REPO_ROOT / "secrets" / "api.env")

    def get(name: str, *aliases: str) -> str | None:
        for n in (f"{prefix}{name}",):
            v = os.environ.get(n)
            if v not in (None, ""):
                return v
        for n in (f"{prefix}{name}", name, *aliases):
            v = file_env.get(n)
            if v not in (None, ""):
                return v
        return None

    raw: dict[str, str] = {}
    for field, name in _KEYS.items():
        v = get(name, "SECRET_KEY") if field == "secret_key" else get(name)
        if v is not None:
            raw[field] = v
    for field, name in _UNPREFIXED.items():
        v = os.environ.get(name) or file_env.get(name)
        if v and field not in raw:
            raw[field] = v
    return raw, production


def load_settings(**overrides) -> Settings:
    raw, production = _lookup()
    values: dict = {**raw, **overrides}
    data_dir = Path(values.get("data_dir") or REPO_ROOT / "apps" / "api" / ".data")
    values["data_dir"] = data_dir
    values.setdefault("seed_root", REPO_ROOT / "seed-data")
    values.setdefault("registry_dir", REPO_ROOT / "registry")
    values.setdefault("plugins_dir", REPO_ROOT / "plugins")
    values.setdefault("repo_root", REPO_ROOT)
    values.setdefault("create_tables", "0" if production else "1")

    missing: list[str] = []
    if production:
        for f in ("secret_key", "database_url", "worker_token"):
            if not values.get(f):
                missing.append(key_name(f))
    if values.get("signer") == "gcpkms" and not values.get("signer_kms_key"):
        missing.append(key_name("signer_kms_key"))
    if values.get("job_queue") == "redis" or values.get("event_bus") == "redis":
        if not values.get("redis_url"):
            missing.append(key_name("redis_url"))
    if values.get("blob_store") == "gcs" and not values.get("gcs_bucket"):
        missing.append(key_name("gcs_bucket"))
    invalid_early: list[str] = []
    if (production or values.get("env") == "production") and values.get("name_screen_mode") == "off":
        # Names reach the agent's transcript in another project: never unscreened in production.
        invalid_early.append(key_name("name_screen_mode"))
    if not values.get("secret_key") and not production:
        # Dev fallback: a stable per-checkout key so signed URLs survive restarts.
        data_dir.mkdir(parents=True, exist_ok=True)
        key_file = data_dir / "dev-secret.key"
        if not key_file.exists():
            key_file.write_text(pysecrets.token_urlsafe(48))
        values["secret_key"] = key_file.read_text().strip()
    values.setdefault("database_url", f"sqlite:///{data_dir / 'api.db'}")
    values.setdefault("secret_key", "")
    invalid: list[str] = list(invalid_early)
    try:
        s = Settings(**values)
    except ValidationError as e:
        # Only the field names: pydantic's own message would include the offending value.
        invalid = sorted({*invalid, *(key_name(str(err["loc"][0])) for err in e.errors() if err.get("loc"))})
    if missing or invalid:
        raise SettingsError(sorted(set(missing)), invalid)
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
