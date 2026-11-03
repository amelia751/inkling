"""todo22 W1 (D2): with ENV=production the api refuses dev mode. Errors name keys, never values."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from studio_api import config
from studio_api.naming import naming

P = naming()["envPrefix"]

SECRET = "super-secret-value-never-printed"


@pytest.fixture
def prod(monkeypatch, tmp_path):
    """Production in the environment (what a deploy sets), plus a valid signed-in configuration
    as overrides; each test breaks one key."""
    monkeypatch.setenv(P + "ENV", "production")
    for k in ("API_AUTH_MODE", "API_DEV_TRUST_HEADERS", "API_DATABASE_URL", "BLOB_STORE", "API_GCS_BUCKET"):
        monkeypatch.delenv(P + k, raising=False)
    good = {
        "data_dir": tmp_path,
        "secret_key": "k",
        "worker_token": "w",
        "approval_secret": "a",
        "database_url": f"postgresql+psycopg://studio:{SECRET}@db/studio",
        "blob_store": "gcs",
        "gcs_bucket": "bucket",
        "auth_mode": "workos",
        "workos_api_key": "sk_test",
        "workos_client_id": "client_test",
        "workos_cookie_password": Fernet.generate_key().decode(),
        "workos_redirect_uri": "https://studio.example/auth/callback",
    }

    def load(**changes):
        merged = {**good, **changes}
        return config.load_settings(**{k: v for k, v in merged.items() if v is not None})

    return load


def refused(load, **changes) -> config.SettingsError:
    with pytest.raises(config.SettingsError) as e:
        load(**changes)
    assert SECRET not in str(e.value)
    for v in changes.values():
        if isinstance(v, str) and len(v) > 3:
            assert v not in str(e.value)
    return e.value


def test_valid_production_loads(prod):
    s = prod()
    assert s.production and s.workos and not s.dev_trust_headers and s.blob_store == "gcs"


def test_refuses_dev_auth(prod):
    e = refused(prod, auth_mode="dev")
    assert P + "API_AUTH_MODE" in e.invalid


def test_refuses_trusted_headers(prod):
    e = refused(prod, dev_trust_headers="1")
    assert P + "API_DEV_TRUST_HEADERS" in e.invalid


def test_refuses_sqlite(prod):
    e = refused(prod, database_url="sqlite:///tmp/api.db")
    assert e.invalid == [P + "API_DATABASE_URL"]


def test_refuses_local_blob_store(prod):
    e = refused(prod, blob_store="local")
    assert e.invalid == [P + "BLOB_STORE"]


def test_refuses_default_blob_store(prod):
    e = refused(prod, blob_store=None)
    assert P + "BLOB_STORE" in e.invalid


def test_development_still_allows_dev_mode(monkeypatch, tmp_path):
    monkeypatch.setenv(P + "ENV", "development")
    for k in ("API_AUTH_MODE", "API_DEV_TRUST_HEADERS", "API_DATABASE_URL", "BLOB_STORE"):
        monkeypatch.delenv(P + k, raising=False)
    s = config.load_settings(data_dir=tmp_path)
    assert not s.workos and s.database_url.startswith("sqlite") and s.blob_store == "local"
