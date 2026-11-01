"""todo13 §7.1 feature flags (`GET /api/v1/features`, `features.require`) and the drop timeline
endpoint (§7.3, Milestone 4 item 1)."""

from __future__ import annotations

import json
import logging

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from studio_api import config
from studio_api.kernel import features
from studio_api.naming import naming

P = naming()["envPrefix"]
ALL = {"chatDrops", "autoApply", "fastPath", "datasetsTab"}


def test_flags_default_on_in_development(make_client):
    c = make_client()
    r = c.get("/api/v1/features")
    assert r.status_code == 200
    assert r.json() == {k: True for k in ALL}


def test_flags_default_off_in_production():
    s = config.Settings(database_url="sqlite://", seed_root=".", data_dir=".", registry_dir=".", plugins_dir=".", secret_key="x", env="production")
    assert not any(s.feature(n) for n in features.FLAGS)


def test_flags_follow_the_keys(make_client, monkeypatch):
    monkeypatch.setenv(f"{P}API_FEATURE_CHAT_DROPS", "0")
    monkeypatch.setenv(f"{P}API_FEATURE_DATASETS_TAB", "false")
    monkeypatch.setenv(f"{P}API_FEATURE_FAST_PATH", "1")
    c = make_client()
    assert c.get("/api/v1/features").json() == {"chatDrops": False, "autoApply": True, "fastPath": True, "datasetsTab": False}


def test_features_need_no_token(make_client):
    c = make_client(dev_trust_headers=False)
    assert c.get("/api/v1/features").status_code == 200


def test_invalid_flag_value_names_the_key(monkeypatch):
    monkeypatch.setenv(f"{P}API_FEATURE_AUTO_APPLY", "maybe")
    try:
        config.load_settings(database_url="sqlite://", secret_key="x")
    except config.SettingsError as e:
        assert f"{P}API_FEATURE_AUTO_APPLY" in str(e) and "maybe" not in str(e)
    else:  # pragma: no cover
        raise AssertionError("an invalid flag must fail fast")


def test_require_answers_404_while_off(make_client):
    make_client(feature_chat_drops=False)
    app = FastAPI()

    @app.get("/x", dependencies=[Depends(features.require("chat_drops"))])
    def x():
        return {"ok": True}

    c = TestClient(app)
    assert c.get("/x").status_code == 404
    config.set_settings(config.settings().model_copy(update={"feature_chat_drops": True}))
    assert c.get("/x").json() == {"ok": True}


def test_timeline_logs_durations_only(make_client, caplog):
    c = make_client()
    body = {"dropId": "drop_01", "origin": "home", "steps": {"gesture": 0, "project-created": 140.4, "first-frame": 2310, "first-interactive": 2400}}
    with caplog.at_level(logging.INFO, logger="studio_api.telemetry"):
        r = c.post("/api/v1/telemetry/timeline", json=body)
    assert r.status_code == 204, r.text
    rec = next(r for r in caplog.records if r.getMessage() == "drop.timeline")
    assert rec.dropId == "drop_01" and rec.origin == "home" and rec.elapsed_ms == 2400
    assert rec.steps_ms["project-created"] == 140


def test_timeline_refuses_anything_but_durations(make_client):
    c = make_client()
    post = lambda b: c.post("/api/v1/telemetry/timeline", json=b).status_code  # noqa: E731
    assert post({"origin": "home", "steps": {"Smith_John.dcm": 10}}) == 422
    assert post({"origin": "home", "steps": {"first-frame": "fast"}}) == 422
    assert post({"origin": "home", "steps": {"first-frame": -1}}) == 422
    assert post({"origin": "home", "steps": {}}) == 422
    assert post({"origin": "elsewhere", "steps": {"first-frame": 1}}) == 422
    assert post({"origin": "home", "dropId": "../x", "steps": {"first-frame": 1}}) == 422
    assert post({"origin": "home", "steps": {f"s{i}": 1 for i in range(41)}}) == 422


def test_timeline_needs_a_person(make_client):
    c = make_client(dev_trust_headers=False)
    assert c.post("/api/v1/telemetry/timeline", json={"origin": "home", "steps": {"first-frame": 1}}).status_code == 401


def test_timeline_log_line_is_json(make_client, capsys):
    from studio_observability import JsonFormatter

    rec = logging.LogRecord("studio_api.telemetry", logging.INFO, "", 0, "drop.timeline", None, None)
    rec.steps_ms = {"first-frame": 1}
    line = json.loads(JsonFormatter("api", "0").format(rec))
    assert line["msg"] == "drop.timeline" and line["steps_ms"] == {"first-frame": 1}


def test_every_flag_off_no_todo13_route_answers(make_client):
    """§6 J12: with every API_FEATURE_* off the product is as before todo13: drops, plans,
    structure, collections, the Datasets reads and the timeline all answer 404."""
    c = make_client(feature_chat_drops=False, feature_auto_apply=False, feature_fast_path=False, feature_datasets_tab=False)
    pid = c.post("/api/v1/projects", json={"title": "Flags off"}).json()["id"]
    calls = [
        ("POST", f"/api/v1/projects/{pid}/drops", {"origin": "chat", "conversationId": "conv-1"}),
        ("GET", f"/api/v1/projects/{pid}/drops", None),
        ("GET", "/api/v1/drops/drp-x", None),
        ("GET", "/api/v1/drops/drp-x/plan", None),
        ("POST", "/api/v1/drops/drp-x/apply", {}),
        ("POST", "/api/v1/drops/drp-x/undo", {}),
        ("GET", "/api/v1/datasets/ds-x/structure", None),
        ("PUT", "/api/v1/datasets/ds-x/structure", {"structure": {}}),
        ("GET", f"/api/v1/projects/{pid}/datasets/ds-x/collections", None),
        ("GET", f"/api/v1/projects/{pid}/dataset-summaries", None),
        ("GET", f"/api/v1/projects/{pid}/dataset-attention", None),
        ("POST", "/api/v1/telemetry/timeline", {"origin": "home", "steps": {"gesture": 0, "first-interactive": 10}}),
    ]
    for method, path, body in calls:
        r = c.request(method, path, json=body)
        assert r.status_code == 404, (method, path, r.status_code, r.text[:200])
    assert c.get("/api/v1/features").json() == {k: False for k in ALL}
    # An import with a chat origin is refused too (no drop gets made).
    r = c.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": [{"clientFileId": "f0", "relPath": "a.png", "size": 3, "sha256": "0" * 64}], "origin": {"kind": "chat", "conversationId": "conv-1"}})
    assert r.status_code in (201, 404, 422), r.text
    if r.status_code == 201:
        assert not r.json().get("dropId")
