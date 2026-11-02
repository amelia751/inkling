"""todo17 M0: every write runs the policy. The workspace environment PUT (once a bypass) gets
shape/reference checks, API keys need `environments:write` and follow the agent allow-list
unless they hold `admin`, and a Studio annotation save validates every item and its label."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from studio_api.auth import api_keys

from .conftest import ws

CASES = json.loads((Path(__file__).resolve().parents[3] / "packages/environment-core/fixtures/cases.json").read_text())
CASES = CASES.get("cases", CASES) if isinstance(CASES, dict) else CASES
VALID = next(c["environment"] for c in CASES if c["name"] == "person replaces a valid document")
UNKNOWN_RENDERER = next(c["environment"] for c in CASES if c["name"] == "unknown renderer")


@pytest.fixture(autouse=True)
def _fresh_cache():
    api_keys.forget()
    yield
    api_keys.forget()


def _put_env(c, pid, env, headers=None):
    return c.put(f"/api/v1/workspaces/{pid}/environment", json={"environment": env}, headers=headers or {})


def _key(c, scopes):
    r = c.post("/api/v1/org/api-keys", json={"name": "k", "expiresInDays": 30, "scopes": scopes})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['secret']}"}


def test_environment_put_rejects_a_bad_environment(client):
    """The old bypass: any JSON was stored. Now a broken reference or shape is a 422 and nothing is saved."""
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    r = _put_env(client, pid, UNKNOWN_RENDERER)
    assert r.status_code == 422, r.text
    assert [e["code"] for e in r.json()["errors"]] == ["reference"]
    assert _put_env(client, pid, "not an object").status_code == 422
    assert _put_env(client, pid, None).status_code == 422
    r = _put_env(client, pid, VALID)
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1


def test_api_key_environment_scope(client):
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    assert _put_env(client, pid, VALID).status_code == 200  # a person sets the base
    annotator = _key(client, ["annotations:write"])
    assert _put_env(client, pid, VALID, annotator).status_code == 403  # annotations:write isn't enough

    env_key = _key(client, ["environments:write"])
    relabelled = copy.deepcopy(VALID)
    relabelled["labels"][0]["classes"].append({"id": "nodule"})
    r = _put_env(client, pid, relabelled, env_key)
    assert r.status_code == 200, r.text
    retooled = {**relabelled, "tools": ["x.y"]}
    r = _put_env(client, pid, retooled, env_key)
    assert r.status_code == 403 and r.json()["errors"][0]["code"] == "scope"

    admin = _key(client, ["admin"])
    r = _put_env(client, pid, retooled, admin)
    assert r.status_code == 422 and r.json()["errors"][0]["code"] == "reference"  # admin skips the allow-list, not the checks


def test_environments_write_scope_maps_to_kernel():
    assert api_keys.kernel_scopes(["environments:write"]) and "environments.write" in api_keys.kernel_scopes(["environments:write"])
    assert "environments.write" not in api_keys.kernel_scopes(["annotations:write"])


def ann(i, label="normal", **extra):
    return {"id": f"a{i}", "itemId": "img/a.png", "label": label, "geometry": {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4}, "provenance": "human-created", "author": "alice", "createdAt": "2026-01-01T00:00:00Z", **extra}


def test_annotation_save_validates_every_item_at_once(client):
    bad = [ann(1), ann(2, provenance="made-up"), {**ann(3), "geometry": None}, ann(4)]
    r = client.put("/api/annotations/ws-a", json={"revision": 0, "annotations": bad}, headers=ws("ws-a"))
    assert r.status_code == 422, r.text
    body = r.json()  # todo17: problem JSON, every violation at once (legacy `errors` kept)
    assert body["code"] == "write_rejected" and [(v["rule"], v["path"]) for v in body["violations"]] == [("annotation.invalid", "/annotations/1"), ("annotation.invalid", "/annotations/2")]
    assert [e["path"] for e in body["errors"]] == ["/annotations/1", "/annotations/2"]
    assert client.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["revision"] == 0


def test_annotation_save_rejects_labels_outside_the_studio_label_set(client):
    pid = client.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    assert _put_env(client, pid, VALID).status_code == 200
    doc = {"revision": 0, "annotations": [ann(1), ann(2, label="cat"), ann(3, label="dog")]}
    r = client.put(f"/api/annotations/{pid}", json=doc, headers=ws(pid))
    assert r.status_code == 422, r.text
    violations = r.json()["violations"]
    assert [(v["path"], v["rule"]) for v in violations] == [("/annotations/1/label", "label.unknown"), ("/annotations/2/label", "label.unknown")]
    ok = client.put(f"/api/annotations/{pid}", json={"revision": 0, "annotations": [ann(1)]}, headers=ws(pid))
    assert ok.status_code == 200, ok.text
