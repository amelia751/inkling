"""todo/todo3.md E.4: probes, version, request ids + traceparent, config validated at startup."""

from __future__ import annotations

import json
import logging

import pytest
from studio_observability import JsonFormatter, bound, parse_traceparent

from studio_api import config
from studio_api.naming import naming

from .conftest import ws
from .test_installer_flow import install

P = naming()["envPrefix"]
PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def test_probes_are_unauthenticated(make_client):
    c = make_client(dev_trust_headers=False)
    assert c.get("/healthz").json() == {"status": "ok"}
    r = c.get("/readyz")
    assert r.status_code == 200, r.text
    assert r.json()["checks"] == {"database": "ok", "blobstore": "ok"}
    assert c.get("/api/v1/assets").status_code == 401  # everything else still needs a token


def test_readyz_fails_when_a_dependency_is_down(make_client, tmp_path):
    c = make_client(seed_root=tmp_path / "nowhere")
    r = c.get("/readyz")
    assert r.status_code == 503 and r.json()["checks"]["blobstore"].startswith("error")


def test_readyz_reports_redis_when_configured_without_leaking_the_url(make_client):
    c = make_client(redis_url="redis://user:hunter2@127.0.0.1:1/0")
    r = c.get("/readyz")
    assert r.status_code == 503 and r.json()["checks"]["redis"].startswith("error")
    assert "hunter2" not in r.text


def test_version(make_client):
    c = make_client(git_sha="abc1234")
    assert c.get("/version").json() == {"service": "api", "version": "0.1.0", "gitSha": "abc1234"}


def test_request_id_is_propagated_and_becomes_the_correlation_id(make_client):
    c = make_client()
    r = c.get("/api/v1/assets", headers=ws("ws-a", **{"X-Request-Id": "req-123"}))
    assert r.headers["X-Request-Id"] == "req-123" and r.headers["X-Correlation-Id"] == "req-123"
    r = c.get("/api/v1/assets", headers=ws("ws-a", **{"X-Correlation-Id": "legacy-1"}))
    assert r.headers["X-Request-Id"] == "legacy-1"
    generated = c.get("/api/v1/assets", headers=ws("ws-a")).headers["X-Request-Id"]
    assert len(generated) == 32


def test_a_job_keeps_the_trace_of_the_request_that_enqueued_it(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a", traceparent=PARENT, **{"X-Request-Id": "rq-9"}))
    assert r.status_code == 202 and r.json()["job"]["correlationId"] == "rq-9"
    from .conftest import worker_headers

    claim = c.post("/api/v1/worker/claim", json={"workerId": "w1"}, headers=worker_headers()).json()
    tp = parse_traceparent(claim["job"]["traceparent"])
    assert tp and tp[0] == PARENT.split("-")[1] and tp[1] != PARENT.split("-")[2]  # same trace, a child span


def test_json_logs_carry_service_version_request_and_trace_ids():
    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    rec.job_id = "j1"
    with bound(request_id="r-1", traceparent=PARENT):
        line = json.loads(JsonFormatter("api", "1.2.3").format(rec))
    assert line["msg"] == "hello world" and line["service"] == "api" and line["version"] == "1.2.3"
    assert line["request_id"] == "r-1" and line["trace_id"] == PARENT.split("-")[1] and line["job_id"] == "j1"


def test_production_fails_fast_naming_missing_keys_never_values(monkeypatch):
    for k in ("API_SECRET_KEY", "API_DATABASE_URL", "API_WORKER_TOKEN"):
        monkeypatch.delenv(P + k, raising=False)
    monkeypatch.setenv(P + "API_ENV", "production")
    with pytest.raises(config.SettingsError) as e:
        config.load_settings()
    assert set(e.value.missing) == {P + "API_SECRET_KEY", P + "API_DATABASE_URL", P + "API_WORKER_TOKEN"}


def test_invalid_values_are_reported_by_name_only(monkeypatch):
    monkeypatch.setenv(P + "BLOB_STORE", "s3-but-secret-value")
    monkeypatch.setenv(P + "JOB_QUEUE", "redis")
    monkeypatch.delenv(P + "REDIS_URL", raising=False)
    with pytest.raises(config.SettingsError) as e:
        config.load_settings(secret_key="k")
    assert e.value.missing == [P + "REDIS_URL"]
    monkeypatch.setenv(P + "REDIS_URL", "redis://localhost:6379/0")
    with pytest.raises(config.SettingsError) as e:
        config.load_settings(secret_key="k")
    assert e.value.invalid == [P + "BLOB_STORE"] and "secret-value" not in str(e.value)


def test_postgres_urls_use_psycopg3():
    from studio_api.db import normalize_url

    assert normalize_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_url("sqlite:///x.db") == "sqlite:///x.db"
