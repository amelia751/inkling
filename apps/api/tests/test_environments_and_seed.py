"""The production stand-ins for apps/web/dev/seed-server.ts: /seed/* and /api/environments/*
(same response shapes, so the Studio runs unchanged against the kernel)."""

from __future__ import annotations

import json

import pytest

from .conftest import png, ws

ENV = {"extends": "preset:image-2d", "task": "classification", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "cat"}]}]}


@pytest.fixture
def c(make_client, seed):
    m = json.loads((seed / "manifest.json").read_text())
    m["projects"].append({"id": "with-env", "title": "E", "assets": [], "environment": ENV})
    m["projects"].append({"id": "legacy", "title": "L", "viewer": "pathology", "task": "classification", "labels": ["tumor", "stroma"], "assets": []})
    (seed / "manifest.json").write_text(json.dumps(m))
    (seed / ".annotations").mkdir()
    (seed / ".annotations" / "ws-a.json").write_text("{}")
    return make_client()


# ---- /seed ---------------------------------------------------------------------------------


def test_seed_files_stream_with_ranges(c):
    full = c.get("/seed/img/a.png")
    assert full.status_code == 200 and full.content == png(40, 30) and full.headers["content-type"] == "image/png"
    assert full.headers["accept-ranges"] == "bytes" and int(full.headers["content-length"]) == len(full.content)
    part = c.get("/seed/img/a.png", headers={"Range": "bytes=2-9"})
    assert part.status_code == 206 and part.content == full.content[2:10] and part.headers["content-range"] == f"bytes 2-9/{len(full.content)}"
    tail = c.get("/seed/img/a.png", headers={"Range": "bytes=-4"})
    assert tail.status_code == 206 and tail.content == full.content[-4:]
    assert c.get("/seed/img/a.png", headers={"Range": "bytes=9999-"}).status_code == 416
    assert c.head("/seed/img/a.png").headers["content-length"] == str(len(full.content))
    assert json.loads(c.get("/seed/manifest.json").content)["projects"][0]["id"] == "ws-a"


def test_seed_never_serves_private_or_outside_paths(c):
    assert c.get("/seed/.annotations/ws-a.json").status_code == 404
    assert c.get("/seed/img/missing.png").status_code == 404
    assert c.get("/seed/img/../../etc/passwd").status_code == 404
    assert c.get("/seed/%2e%2e/secret").status_code == 404


# ---- /api/environments -----------------------------------------------------------------------


def test_get_falls_back_to_the_manifest_environment(c):
    assert c.get("/api/environments/with-env").json() == {"revision": 0, "environment": None, "effective": ENV}
    legacy = c.get("/api/environments/legacy").json()["effective"]
    assert legacy["extends"] == "preset:pathology" and legacy["task"] == "classification"
    assert [g["name"] for g in legacy["labels"]] == ["class", "labels"] and legacy["labels"][1]["classes"] == [{"id": "tumor"}, {"id": "stroma"}]
    assert c.get("/api/environments/nope").json() == {"revision": 0, "environment": None, "effective": None}
    assert c.get("/api/environments/Bad_Id").status_code == 400


def test_put_is_optimistic_and_keeps_history(c):
    r = c.put("/api/environments/with-env", json={"revision": 0, "environment": ENV, "author": "ann"})
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["revision"] == 1 and doc["environment"] == ENV and doc["author"] == "ann" and doc["savedAt"].endswith("Z")
    stale = c.put("/api/environments/with-env", json={"revision": 0, "environment": {**ENV, "task": "x"}})
    assert stale.status_code == 409 and stale.json()["error"] == "revision conflict" and stale.json()["current"]["revision"] == 1
    r = c.put("/api/environments/with-env", json={"environment": {**ENV, "task": "segmentation"}})  # no revision: last writer wins
    assert r.json()["revision"] == 2 and r.json()["author"] == "local-expert"
    got = c.get("/api/environments/with-env").json()
    assert got["revision"] == 2 and got["effective"]["task"] == "segmentation" and got["environment"] == got["effective"]
    hist = c.get("/api/environments/with-env/history").json()
    assert [h["revision"] for h in hist] == [1, 2] and hist[0]["environment"] == ENV and set(hist[0]) == {"revision", "environment", "savedAt", "author"}
    assert c.put("/api/environments/with-env", content=b"").status_code == 400
    assert c.put("/api/environments/with-env", json={"environment": "nope"}).status_code == 422


def test_patch_applies_rfc6902_to_the_saved_or_manifest_environment(c):
    r = c.patch("/api/environments/with-env", json={"patch": [{"op": "replace", "path": "/task", "value": "detection"}, {"op": "add", "path": "/labels/0/classes/-", "value": {"id": "dog"}}]})
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1 and r.json()["environment"]["task"] == "detection"
    assert r.json()["environment"]["labels"][0]["classes"] == [{"id": "cat"}, {"id": "dog"}]
    r = c.patch("/api/environments/with-env", json={"revision": 1, "patch": [{"op": "remove", "path": "/task"}]})
    assert r.status_code == 200 and "task" not in r.json()["environment"]
    bad = c.patch("/api/environments/with-env", json={"patch": [{"op": "replace", "path": "/nope/deeper", "value": 1}]})
    assert bad.status_code == 422 and bad.json()["ok"] is False and bad.json()["errors"][0]["path"] == "/0"
    assert c.get("/api/environments/with-env").json()["revision"] == 2  # a failed patch saves nothing
    assert c.patch("/api/environments/with-env", json={"patch": {"op": "x"}}).status_code == 422
    assert c.patch("/api/environments/nope", json={"patch": []}).status_code == 404
    assert c.patch("/api/environments/with-env", json={"revision": 0, "patch": []}).status_code == 409


def test_validation_and_catalog_stay_on_the_dev_server(c):
    r = c.post("/api/environments/validate", json=ENV)
    assert r.status_code == 501 and "dev server" in r.json()["error"]
    assert c.get("/api/catalog").status_code == 501 and c.get("/api/catalog/schema").status_code == 501


def test_a_session_token_cant_edit_another_workspace(c):
    tok = c.post("/api/v1/sessions", json={"scopes": ["assets.read"]}, headers=ws("ws-a")).json()["token"]
    assert c.get("/api/environments/with-env", headers={"Authorization": f"Bearer {tok}"}).status_code == 403
